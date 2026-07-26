import {
  listCarrierTasksByRoom,
  type CarrierTask,
} from "@/runtime/carrierTaskBoard";
import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import {
  findFactoryInRoom,
  parseConfig as parseFactoryConfig,
  resolveTargetQueue,
} from "@/runtime/factoryControl";
import {
  buildMarketSaleProtectionLedger,
  type MarketProtectionCandidate,
  type MarketProtectionFact,
  type MarketProtectionSourceKind,
  type MarketProtectionSourceSnapshot,
  type MarketSaleProtectionLedger,
} from "@/runtime/marketSaleProtection";
import type { MarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import { getProductReagents } from "@/runtime/reactionMap";
import {
  collectResourceControlSnapshots,
  type ResourceControlSnapshot,
} from "@/runtime/resourceControl";
import { POWER_BANK_BOOST_REQUIREMENTS } from "@/runtime/powerBankConstants";

export interface LiveManagedOrderExposure {
  orderId: string;
  roomName: string;
  resourceType: ResourceConstant;
  remainingExposure: number;
}

export type LiveManagedOrderCollection =
  | readonly LiveManagedOrderExposure[]
  | Readonly<Record<string, LiveManagedOrderExposure>>;

export interface CollectLiveMarketSaleProtectionOptions {
  candidates?: readonly MarketProtectionCandidate[];
}

type MutableSourceMap = Record<
  MarketProtectionSourceKind,
  MarketProtectionSourceSnapshot
>;

type UnknownRecord = Record<string, unknown>;

interface SourceCollection {
  complete: boolean;
  facts: MarketProtectionFact[];
}

const WAR_T3_BOOSTS: readonly ResourceConstant[] = [
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
  RESOURCE_CATALYZED_UTRIUM_ACID,
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
];

const BASE_REACTION_MINERALS = new Set<ResourceConstant>([
  RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN,
  RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM,
  RESOURCE_KEANIUM,
  RESOURCE_ZYNTHIUM,
  RESOURCE_CATALYST,
]);

const TERMINAL_POWER_BANK_STATUSES = new Set([
  "complete",
  "failed",
  "aborted",
]);

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validResource(value: unknown): value is ResourceConstant {
  return typeof value === "string" && value.length > 0;
}

function validRoomName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function currentSnapshot(
  complete: boolean,
  facts: readonly MarketProtectionFact[],
): MarketProtectionSourceSnapshot {
  return {
    revision: Game.time,
    observedAt: Game.time,
    expiresAt: Game.time,
    complete,
    facts,
  };
}

function uniqueCandidates(
  candidates: readonly MarketProtectionCandidate[],
): MarketProtectionCandidate[] {
  const seen = new Set<string>();
  const result: MarketProtectionCandidate[] = [];
  for (const candidate of candidates) {
    if (
      !validRoomName(candidate.roomName) ||
      !validResource(candidate.resource)
    ) {
      continue;
    }
    const key = `${candidate.roomName}:${candidate.resource}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function resolveCandidates(
  config: MarketSaleAutomationConfig,
  options: CollectLiveMarketSaleProtectionOptions,
): MarketProtectionCandidate[] {
  if (options.candidates) {
    return uniqueCandidates(options.candidates);
  }

  const candidates: MarketProtectionCandidate[] = [];
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my || !room.terminal) continue;
    for (const resource of config.sellResources) {
      candidates.push({ roomName: room.name, resource });
    }
  }
  return uniqueCandidates(candidates);
}

function getTransferableStock(
  room: Room,
  resource: ResourceConstant,
): { totalStock: number; terminalStock: number } | undefined {
  if (!room.controller?.my || !room.terminal) return undefined;
  const storageStock = room.storage?.store.getUsedCapacity(resource) ?? 0;
  const terminalStock = room.terminal.store.getUsedCapacity(resource) ?? 0;
  if (!finiteNonNegative(storageStock) || !finiteNonNegative(terminalStock)) {
    return undefined;
  }
  return {
    totalStock: storageStock + terminalStock,
    terminalStock,
  };
}

function collectStock(
  candidates: readonly MarketProtectionCandidate[],
): SourceCollection {
  const facts: MarketProtectionFact[] = [];
  for (const candidate of candidates) {
    const room = Game.rooms[candidate.roomName];
    if (!room) continue;
    const stock = getTransferableStock(room, candidate.resource);
    if (!stock) continue;
    facts.push({
      roomName: candidate.roomName,
      resource: candidate.resource,
      amount: stock.totalStock,
      terminalStock: stock.terminalStock,
      stableKey: `stock:${candidate.roomName}:${candidate.resource}`,
    });
  }
  return { complete: true, facts };
}

function collectRoomFloors(
  candidates: readonly MarketProtectionCandidate[],
): SourceCollection {
  let snapshots: ResourceControlSnapshot[];
  try {
    snapshots = collectResourceControlSnapshots();
  } catch {
    return { complete: false, facts: [] };
  }

  const byRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const),
  );
  const facts: MarketProtectionFact[] = [];
  for (const candidate of candidates) {
    const floor = byRoom.get(candidate.roomName)?.mineralFloor[
      candidate.resource
    ];
    if (!finiteNonNegative(floor)) continue;
    facts.push({
      roomName: candidate.roomName,
      resource: candidate.resource,
      amount: floor,
      stableKey: `floor:${candidate.roomName}:${candidate.resource}`,
    });
  }
  return { complete: true, facts };
}

function collectForecast(
  config: MarketSaleAutomationConfig,
  candidates: readonly MarketProtectionCandidate[],
): SourceCollection {
  const minimumForecastBuffer = Math.max(
    config.minDealAmount,
    config.makerBatchAmount,
  );
  let complete =
    config.validForPlanning &&
    Number.isFinite(minimumForecastBuffer) &&
    minimumForecastBuffer > 0;
  const facts: MarketProtectionFact[] = [];
  for (const candidate of candidates) {
    const amount = config.forecastBuffer[candidate.resource];
    if (
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount < minimumForecastBuffer
    ) {
      complete = false;
      continue;
    }
    facts.push({
      roomName: candidate.roomName,
      resource: candidate.resource,
      amount,
      stableKey: `forecast:${candidate.roomName}:${candidate.resource}`,
    });
  }
  return {
    complete,
    facts,
  };
}

function collectResourceReservations(): SourceCollection {
  const store = Memory.runtime?.resourceReservations;
  if (store === undefined) {
    return { complete: true, facts: [] };
  }
  if (!asRecord(store)) {
    return { complete: false, facts: [] };
  }

  let complete = true;
  const facts: MarketProtectionFact[] = [];
  for (const [storeKey, rawEntry] of Object.entries(store)) {
    const entry = asRecord(rawEntry);
    if (
      !entry ||
      !validRoomName(entry.roomName) ||
      !validResource(entry.resource) ||
      typeof entry.holderId !== "string" ||
      !finiteNonNegative(entry.amount) ||
      !finiteNonNegative(entry.updatedAt) ||
      !finiteNonNegative(entry.expiresAt)
    ) {
      complete = false;
      continue;
    }
    if (entry.expiresAt < Game.time) continue;
    facts.push({
      roomName: entry.roomName,
      resource: entry.resource,
      amount: entry.amount,
      stableKey: `reservation:${storeKey}`,
      observedAt: entry.updatedAt,
      expiresAt: entry.expiresAt,
    });
  }
  return { complete, facts };
}

function collectOutgoingTransfers(): SourceCollection {
  const tasks = Memory.data?.resourceControl?.tasks;
  if (!tasks || !asRecord(tasks)) {
    return { complete: false, facts: [] };
  }

  const noProgressTtl =
    Memory.cfg?.resourceControl?.capacityBalancing?.automaticTaskNoProgressTtl;
  const normalizedTtl = finiteNonNegative(noProgressTtl)
    ? noProgressTtl
    : 5_000;
  // ResourceControl only plans on its sample ticks, but its task store is the
  // durable source of truth between samples. Re-reading and validating that
  // store here is a current-tick observation; requiring ResourceControl itself
  // to have run would make every managed market order unmaintainable between
  // sample ticks.
  let complete = true;
  const facts: MarketProtectionFact[] = [];
  for (const [taskKey, rawTask] of Object.entries(tasks)) {
    const task = asRecord(rawTask);
    if (!task) {
      complete = false;
      continue;
    }
    if (task.status !== "pending") continue;
    if (
      !validRoomName(task.fromRoomName) ||
      !validResource(task.resource) ||
      !finiteNonNegative(task.remainingAmount) ||
      typeof task.id !== "string"
    ) {
      complete = false;
      continue;
    }

    const isCapacityRelief =
      task.origin === "automatic" &&
      typeof task.reason === "string" &&
      task.reason.startsWith("capacity:relief:");
    const contractExpired =
      isCapacityRelief &&
      finiteNonNegative(task.lastProgressAt) &&
      Game.time - task.lastProgressAt > normalizedTtl;
    facts.push({
      roomName: task.fromRoomName,
      resource: task.resource,
      amount: task.remainingAmount,
      stableKey: `transfer:${task.id || taskKey}`,
      status: task.blockedReason ? "blocked" : "pending",
      blockedReason:
        typeof task.blockedReason === "string" ? task.blockedReason : undefined,
      disposable: isCapacityRelief,
      contractExpired,
    });
  }
  return { complete, facts };
}

function carrierFactKey(taskId: string, stepId: string): string {
  return `carrier:${taskId}:${stepId}`;
}

function validCarrierTask(task: CarrierTask): boolean {
  return (
    validRoomName(task.id) &&
    validRoomName(task.roomName) &&
    Array.isArray(task.steps)
  );
}

function collectCarrierCommitments(
  candidates: readonly MarketProtectionCandidate[],
): SourceCollection {
  const roomNames = new Set(candidates.map((candidate) => candidate.roomName));
  const taskRoomById = new Map<string, string>();
  // CarrierTaskBoard and creep assignment memory can change on any tick (for
  // example, synthesis/factory run before market-sale). Inspect them directly
  // every tick instead of inheriting ResourceControl's slower cadence.
  let complete = true;
  const facts: MarketProtectionFact[] = [];

  for (const roomName of roomNames) {
    let tasks: CarrierTask[];
    try {
      tasks = listCarrierTasksByRoom(roomName);
    } catch {
      complete = false;
      continue;
    }
    for (const task of tasks) {
      if (!validCarrierTask(task) || task.roomName !== roomName) {
        complete = false;
        continue;
      }
      taskRoomById.set(task.id, roomName);
      for (const step of task.steps) {
        if (
          !validRoomName(step.id) ||
          !validResource(step.resource) ||
          !finiteNonNegative(step.amount)
        ) {
          complete = false;
          continue;
        }
        facts.push({
          roomName,
          resource: step.resource,
          amount: step.amount,
          stableKey: carrierFactKey(task.id, step.id),
          status: "pending",
        });
      }
    }
  }

  for (const creep of Object.values(Game.creeps)) {
    const state = getCreepAssignmentState(creep.name);
    const resource = state?.synthesisCarrierPendingResource;
    const taskId = state?.synthesisCarrierTaskId;
    if (!resource || !taskId) continue;
    const amount = creep.store.getUsedCapacity(resource);
    if (!finiteNonNegative(amount) || amount <= 0) continue;
    const roomName = taskRoomById.get(taskId) ?? creep.room.name;
    if (!roomNames.has(roomName)) continue;
    const stepId =
      state.synthesisCarrierPendingStepId ??
      `inflight:${creep.name}:${resource}`;
    facts.push({
      roomName,
      resource,
      amount,
      stableKey: carrierFactKey(taskId, stepId),
      status: "active",
    });
  }

  return { complete, facts };
}

interface CommodityRecipeView {
  amount: number;
  components: Record<string, number>;
}

function getCommodityRecipe(
  resource: ResourceConstant,
): CommodityRecipeView | undefined {
  if (typeof COMMODITIES === "undefined") return undefined;
  const raw = (COMMODITIES as unknown as Record<string, unknown>)[resource];
  const record = asRecord(raw);
  const components = asRecord(record?.components);
  if (
    !record ||
    !components ||
    !finiteNonNegative(record.amount) ||
    record.amount <= 0
  ) {
    return undefined;
  }
  const normalized: Record<string, number> = {};
  for (const [component, amount] of Object.entries(components)) {
    if (!finiteNonNegative(amount) || amount <= 0) continue;
    normalized[component] = amount;
  }
  return { amount: record.amount, components: normalized };
}

function appendFactoryComponents(
  facts: MarketProtectionFact[],
  roomName: string,
  rootTarget: ResourceConstant,
  resource: ResourceConstant,
  amount: number,
  path: readonly string[] = [],
): boolean {
  const recipe = getCommodityRecipe(resource);
  if (!recipe) return false;
  if (path.includes(resource) || path.length > 20) return false;
  const batches = Math.ceil(amount / recipe.amount);
  let complete = true;
  for (const [componentName, perBatch] of Object.entries(recipe.components)) {
    const component = componentName as ResourceConstant;
    const required = perBatch * batches;
    const componentPath = [...path, resource, component].join(">");
    facts.push({
      roomName,
      resource: component,
      amount: required,
      stableKey: `factory:component:${roomName}:${rootTarget}:${componentPath}`,
      status: "active",
    });
    if (getCommodityRecipe(component)) {
      complete =
        appendFactoryComponents(
          facts,
          roomName,
          rootTarget,
          component,
          required,
          [...path, resource],
        ) && complete;
    }
  }
  return complete;
}

function collectFactory(candidates: readonly MarketProtectionCandidate[]): {
  targets: SourceCollection;
  components: SourceCollection;
  tasks: SourceCollection;
} {
  const targetFacts: MarketProtectionFact[] = [];
  const componentFacts: MarketProtectionFact[] = [];
  const taskFacts: MarketProtectionFact[] = [];
  const rawConfig = Memory.cfg?.factoryControl;
  let targetsComplete = true;
  let componentsComplete = true;

  if (rawConfig?.enabled === true) {
    const runtime = Memory.runtime?.factoryControl;
    if (runtime?.updatedAt !== Game.time) {
      targetsComplete = false;
      componentsComplete = false;
    } else {
      let config: ReturnType<typeof parseFactoryConfig> | undefined;
      try {
        config = parseFactoryConfig();
      } catch {
        targetsComplete = false;
        componentsComplete = false;
      }
      if (!config) {
        return {
          targets: { complete: false, facts: targetFacts },
          components: { complete: false, facts: componentFacts },
          tasks: { complete: false, facts: taskFacts },
        };
      }
      const candidateRooms = new Set(
        candidates.map((candidate) => candidate.roomName),
      );
      for (const roomName of candidateRooms) {
        const room = Game.rooms[roomName];
        if (!room || config.rooms[roomName]?.enabled === false) continue;
        let factory: StructureFactory | null;
        try {
          factory = findFactoryInRoom(room);
        } catch {
          factory = null;
          targetsComplete = false;
          componentsComplete = false;
        }
        if (!factory) continue;

        const queue = resolveTargetQueue(config, roomName);
        for (const target of queue) {
          const recipe = getCommodityRecipe(target.resource);
          const targetAmount =
            target.targetAmount > 0
              ? target.targetAmount
              : target.cap > 0
                ? target.cap
                : recipe?.amount;
          if (!finiteNonNegative(targetAmount) || targetAmount <= 0) {
            targetsComplete = false;
            componentsComplete = false;
            continue;
          }
          targetFacts.push({
            roomName,
            resource: target.resource,
            amount: targetAmount,
            stableKey: `factory:target:${roomName}:${target.resource}`,
            status: "active",
          });
          if (!recipe) {
            componentsComplete = false;
            continue;
          }
          componentsComplete =
            appendFactoryComponents(
              componentFacts,
              roomName,
              target.resource,
              target.resource,
              targetAmount,
            ) && componentsComplete;
        }

        const activeTarget = runtime.rooms?.[roomName]?.activeTarget;
        if (
          activeTarget &&
          !queue.some((target) => target.resource === activeTarget)
        ) {
          const activeRecipe = getCommodityRecipe(activeTarget);
          if (!activeRecipe) {
            componentsComplete = false;
          } else {
            componentFacts.push({
              roomName,
              resource: activeTarget,
              amount: activeRecipe.amount,
              stableKey: `factory:runtime-target:${roomName}:${activeTarget}`,
              status: "active",
            });
            componentsComplete =
              appendFactoryComponents(
                componentFacts,
                roomName,
                activeTarget,
                activeTarget,
                activeRecipe.amount,
              ) && componentsComplete;
          }
        }
      }
    }
  }

  const taskStore = Memory.data?.factoryTasks;
  let tasksComplete = true;
  if (taskStore !== undefined && !asRecord(taskStore)) {
    tasksComplete = false;
  } else {
    for (const [taskKey, rawTask] of Object.entries(taskStore || {})) {
      const task = asRecord(rawTask);
      if (
        !task ||
        !validRoomName(task.roomName) ||
        typeof task.id !== "string" ||
        !finiteNonNegative(task.remainingBatteryAmount)
      ) {
        tasksComplete = false;
        continue;
      }
      if (task.status === "done" || task.status === "cancelled") continue;
      taskFacts.push({
        roomName: task.roomName,
        resource: RESOURCE_BATTERY,
        amount: task.remainingBatteryAmount,
        stableKey: `factory:task:${task.id || taskKey}`,
        status:
          task.status === "failed"
            ? "failed"
            : task.status === "pending"
              ? "pending"
              : "active",
      });
    }
  }

  return {
    targets: { complete: targetsComplete, facts: targetFacts },
    components: { complete: componentsComplete, facts: componentFacts },
    tasks: { complete: tasksComplete, facts: taskFacts },
  };
}

function synthesisPlanStableKey(
  roomName: string,
  product: ResourceConstant,
): string {
  return `synthesis:plan:${roomName}:${product}`;
}

function appendSynthesisPlanFacts(
  facts: MarketProtectionFact[],
  roomName: string,
  planStableKey: string,
  product: ResourceConstant,
  targetAmount: number,
  status: "active" | "paused",
): boolean {
  if (!finiteNonNegative(targetAmount) || targetAmount <= 0) return false;
  const reagents = getProductReagents(product);
  if (!reagents) return false;
  facts.push({
    roomName,
    resource: product,
    amount: targetAmount,
    stableKey: `${planStableKey}:product`,
    status,
  });
  for (const reagent of reagents) {
    facts.push({
      roomName,
      resource: reagent,
      amount: targetAmount,
      stableKey: `${planStableKey}:reagent:${reagent}`,
      status,
    });
  }
  return true;
}

function collectSynthesis(candidates: readonly MarketProtectionCandidate[]): {
  active: SourceCollection;
  paused: SourceCollection;
} {
  const activeFacts: MarketProtectionFact[] = [];
  const pausedFacts: MarketProtectionFact[] = [];
  const rawConfig = Memory.cfg?.synthesisControl;
  if (rawConfig?.enabled !== true) {
    return {
      active: { complete: true, facts: [] },
      paused: { complete: true, facts: [] },
    };
  }

  const runtime = Memory.runtime?.synthesisControl;
  let activeComplete = runtime?.updatedAt === Game.time;
  let pausedComplete = runtime?.updatedAt === Game.time;
  const candidateRooms = new Set(
    candidates.map((candidate) => candidate.roomName),
  );
  const configuredRooms = asRecord(rawConfig.rooms) || {};

  for (const roomName of candidateRooms) {
    const roomConfig = asRecord(configuredRooms[roomName]);
    if (!roomConfig || roomConfig.enabled === false) continue;
    const state = runtime?.rooms?.[roomName];
    if (!state) {
      activeComplete = false;
      pausedComplete = false;
      continue;
    }
    if (state.activeProduct) {
      try {
        activeComplete =
          appendSynthesisPlanFacts(
            activeFacts,
            roomName,
            synthesisPlanStableKey(roomName, state.activeProduct),
            state.activeProduct,
            state.targetAmount ?? 0,
            "active",
          ) && activeComplete;
      } catch {
        activeComplete = false;
      }
    }
    const pausedPlan = state.boostPause?.pausedPlan;
    if (pausedPlan) {
      try {
        pausedComplete =
          appendSynthesisPlanFacts(
            pausedFacts,
            roomName,
            synthesisPlanStableKey(roomName, pausedPlan.product),
            pausedPlan.product,
            pausedPlan.targetAmount,
            "paused",
          ) && pausedComplete;
      } catch {
        pausedComplete = false;
      }
    }
  }

  return {
    active: { complete: activeComplete, facts: activeFacts },
    paused: { complete: pausedComplete, facts: pausedFacts },
  };
}

function collectHub(
  candidates: readonly MarketProtectionCandidate[],
): SourceCollection {
  const cfg = Memory.cfg?.hub;
  if (cfg?.enabled !== true) {
    return { complete: true, facts: [] };
  }
  if (!validRoomName(cfg.hubRoomName)) {
    return { complete: false, facts: [] };
  }

  const runtime = Memory.runtime?.hub;
  const updatedAt = runtime?.updatedAt;
  const planInterval = finiteNonNegative(cfg.planInterval)
    ? Math.max(1, cfg.planInterval)
    : 200;
  let complete =
    !!runtime &&
    finiteNonNegative(updatedAt) &&
    Game.time - updatedAt <= planInterval &&
    runtime.needsPlan !== true;
  const facts: MarketProtectionFact[] = [];
  const reserve = finiteNonNegative(cfg.hubReservePerCompound)
    ? cfg.hubReservePerCompound
    : 10_000;
  for (const resource of cfg.targetCompounds || []) {
    if (!validResource(resource)) {
      complete = false;
      continue;
    }
    facts.push({
      roomName: cfg.hubRoomName,
      resource,
      amount: reserve,
      stableKey: `hub:target:${cfg.hubRoomName}:${resource}`,
      status: "active",
    });
  }

  const distributed = runtime?.distributedSynthesis;
  // `planDistributedSynthesis` seeds allocationLedger from effective room
  // inventories, then decrements it as assignments and routes consume stock.
  // Persisted roomCommitments are therefore residual available supply, not
  // production demand. Only the concrete assignments and routes below are
  // protection commitments.

  for (const rawAssignment of distributed?.dispatchAssignments || []) {
    const assignment = asRecord(rawAssignment);
    if (
      !assignment ||
      !validRoomName(assignment.roomName) ||
      !validResource(assignment.product) ||
      !finiteNonNegative(assignment.targetAmount)
    ) {
      complete = false;
      continue;
    }
    try {
      complete =
        appendSynthesisPlanFacts(
          facts,
          assignment.roomName,
          synthesisPlanStableKey(assignment.roomName, assignment.product),
          assignment.product,
          assignment.targetAmount,
          "active",
        ) && complete;
    } catch {
      complete = false;
    }
  }

  for (const [index, rawRoute] of (
    distributed?.routeDecisions || []
  ).entries()) {
    const route = asRecord(rawRoute);
    if (
      !route ||
      !validRoomName(route.fromRoom) ||
      !validRoomName(route.toRoom) ||
      !validResource(route.resource) ||
      !finiteNonNegative(route.amount)
    ) {
      complete = false;
      continue;
    }
    facts.push({
      roomName: route.fromRoom,
      resource: route.resource,
      amount: route.amount,
      stableKey: `hub:route:${index}:${route.fromRoom}->${route.toRoom}:${route.resource}`,
      status: "pending",
    });
  }

  for (const candidate of candidates) {
    if (candidate.roomName !== cfg.hubRoomName) continue;
    const room = Game.rooms[candidate.roomName];
    const stock = room
      ? getTransferableStock(room, candidate.resource)
      : undefined;
    if (!stock) {
      complete = false;
      continue;
    }
    const declaredSurplus = runtime?.marketSellSurplus?.[candidate.resource];
    const sellable = finiteNonNegative(declaredSurplus) ? declaredSurplus : 0;
    facts.push({
      roomName: candidate.roomName,
      resource: candidate.resource,
      amount: Math.max(0, stock.totalStock - sellable),
      stableKey: `hub:surplus-limit:${candidate.roomName}:${candidate.resource}`,
      status: "active",
    });
  }

  return { complete, facts };
}

function reactionDemandAmount(amount: unknown): number | undefined {
  if (
    !finiteNonNegative(amount) ||
    amount <= 0 ||
    typeof LAB_REACTION_AMOUNT !== "number" ||
    !Number.isFinite(LAB_REACTION_AMOUNT) ||
    LAB_REACTION_AMOUNT <= 0
  ) {
    return undefined;
  }
  const normalized =
    Math.ceil(amount / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT;
  return finiteNonNegative(normalized) && normalized > 0
    ? normalized
    : undefined;
}

function expandReactionBaseAmounts(
  product: ResourceConstant,
  amount: unknown,
): { amount: number; baseAmounts: Map<ResourceConstant, number> } | undefined {
  const normalizedAmount = reactionDemandAmount(amount);
  if (normalizedAmount === undefined || BASE_REACTION_MINERALS.has(product)) {
    return undefined;
  }

  const baseAmounts = new Map<ResourceConstant, number>();
  const visit = (
    resource: ResourceConstant,
    required: number,
    path: readonly ResourceConstant[],
  ): boolean => {
    if (BASE_REACTION_MINERALS.has(resource)) {
      baseAmounts.set(resource, (baseAmounts.get(resource) || 0) + required);
      return true;
    }
    if (path.includes(resource) || path.length >= 20) return false;

    let reagents: [ResourceConstant, ResourceConstant] | null;
    try {
      reagents = getProductReagents(resource);
    } catch {
      return false;
    }
    if (
      !reagents ||
      reagents.length !== 2 ||
      !validResource(reagents[0]) ||
      !validResource(reagents[1])
    ) {
      return false;
    }
    const nextPath = [...path, resource];
    return (
      visit(reagents[0], required, nextPath) &&
      visit(reagents[1], required, nextPath)
    );
  };

  if (!visit(product, normalizedAmount, [])) return undefined;
  if (
    baseAmounts.size === 0 ||
    [...baseAmounts.values()].some(
      (baseAmount) => !finiteNonNegative(baseAmount) || baseAmount <= 0,
    )
  ) {
    return undefined;
  }
  return { amount: normalizedAmount, baseAmounts };
}

function appendBoostWarReactionDemand(
  facts: MarketProtectionFact[],
  roomName: string,
  stablePrefix: string,
  product: ResourceConstant,
  amount: unknown,
): boolean {
  const expanded = expandReactionBaseAmounts(product, amount);
  if (!expanded) return false;

  facts.push({
    roomName,
    resource: product,
    amount: expanded.amount,
    stableKey: stablePrefix,
    status: "active",
  });
  for (const [baseResource, baseAmount] of [
    ...expanded.baseAmounts.entries(),
  ].sort(([left], [right]) => left.localeCompare(right))) {
    facts.push({
      roomName,
      resource: baseResource,
      amount: baseAmount,
      stableKey: `${stablePrefix}:base:${baseResource}`,
      status: "active",
    });
  }
  return true;
}

function boostContractStablePrefix(
  taskId: string,
  product: ResourceConstant,
): string {
  return `boost-contract:${taskId}:${product}`;
}

function appendPowerBankHarvestDemand(
  facts: MarketProtectionFact[],
): boolean {
  const tasks = Memory.data?.powerBankHarvest;
  if (tasks === undefined) return true;
  if (!asRecord(tasks)) return false;

  let complete = true;
  for (const rawTask of Object.values(tasks)) {
    const task = asRecord(rawTask);
    if (!task || typeof task.status !== "string") {
      complete = false;
      continue;
    }
    if (TERMINAL_POWER_BANK_STATUSES.has(task.status)) continue;
    if (
      typeof task.id !== "string" ||
      task.id.length === 0 ||
      !validRoomName(task.sourceRoom) ||
      !Number.isSafeInteger(task.tier) ||
      (task.tier as number) <= 0
    ) {
      // A discovered task is resolved by powerBankHarvest after market-sale
      // in the main loop. Until its source/tier is known, block rather than
      // expose a one-tick unprotected production window.
      complete = false;
      continue;
    }
    const requirements = POWER_BANK_BOOST_REQUIREMENTS[task.tier as number];
    if (!requirements) {
      complete = false;
      continue;
    }
    const compounds = [
      ...new Set<ResourceConstant>([
        ...requirements.attacker,
        ...requirements.healer,
      ]),
    ];
    if (compounds.length === 0) {
      complete = false;
      continue;
    }
    for (const compound of compounds) {
      complete =
        appendBoostWarReactionDemand(
          facts,
          task.sourceRoom,
          boostContractStablePrefix(task.id, compound),
          compound,
          typeof LAB_MINERAL_CAPACITY === "number"
            ? LAB_MINERAL_CAPACITY
            : undefined,
        ) && complete;
    }
  }
  return complete;
}

function collectBoost(): SourceCollection {
  let complete = true;
  const facts: MarketProtectionFact[] = [];
  const defenseConfig = Memory.cfg?.homeDefense;
  const configuredTarget = defenseConfig?.boostTarget;
  const target =
    configuredTarget === undefined || configuredTarget === 0
      ? 1_000
      : finiteNonNegative(configuredTarget)
        ? configuredTarget
        : undefined;
  if (configuredTarget !== undefined && target === undefined) {
    complete = false;
  }
  for (const [roomName, rawRoom] of Object.entries(
    defenseConfig?.rooms || {},
  )) {
    const roomConfig = asRecord(rawRoom);
    if (!roomConfig || !validRoomName(roomName)) {
      complete = false;
      continue;
    }
    if (typeof roomConfig.boostLabId !== "string") continue;
    if (target === 0) continue;
    if (target === undefined) {
      complete = false;
      continue;
    }
    complete =
      appendBoostWarReactionDemand(
        facts,
        roomName,
        `boost:homeDefense:${roomName}`,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        target,
      ) && complete;
  }

  const prepStore = Memory.runtime?.powerBankBoost;
  if (prepStore !== undefined && !asRecord(prepStore)) {
    complete = false;
  } else {
    for (const [taskKey, rawPrep] of Object.entries(prepStore || {})) {
      const prep = asRecord(rawPrep);
      const labs = asRecord(prep?.labs);
      if (
        !prep ||
        !labs ||
        !validRoomName(prep.sourceRoomName) ||
        typeof prep.taskId !== "string"
      ) {
        complete = false;
        continue;
      }
      for (const rawAssignment of Object.values(labs)) {
        const assignment = asRecord(rawAssignment);
        if (!assignment || !validResource(assignment.compound)) {
          complete = false;
          continue;
        }
        complete =
          appendBoostWarReactionDemand(
            facts,
            prep.sourceRoomName,
            boostContractStablePrefix(
              prep.taskId || taskKey,
              assignment.compound,
            ),
            assignment.compound,
            typeof LAB_MINERAL_CAPACITY === "number"
              ? LAB_MINERAL_CAPACITY
              : undefined,
          ) && complete;
      }
    }
  }
  complete = appendPowerBankHarvestDemand(facts) && complete;
  return { complete, facts };
}

function collectWar(): SourceCollection {
  const store = Memory.data?.war;
  if (store !== undefined && !asRecord(store)) {
    return { complete: false, facts: [] };
  }

  let complete = true;
  const facts: MarketProtectionFact[] = [];
  for (const rawTask of Object.values(store || {})) {
    const task = asRecord(rawTask);
    if (
      !task ||
      !validRoomName(task.sourceRoom) ||
      typeof task.status !== "string"
    ) {
      complete = false;
      continue;
    }
    if (task.status === "done" || task.status === "failed") continue;
    if (task.squad !== "t3Duo" && task.boostTier !== "t3") continue;
    const activeGeneration = asRecord(task.activeGeneration);
    const boostTaskId =
      typeof activeGeneration?.boostTaskId === "string" &&
      activeGeneration.boostTaskId.length > 0
        ? activeGeneration.boostTaskId
        : validRoomName(task.targetRoom)
          ? `war:${task.sourceRoom}:${task.targetRoom}`
          : undefined;
    if (!boostTaskId) {
      complete = false;
      continue;
    }
    for (const resource of WAR_T3_BOOSTS) {
      complete =
        appendBoostWarReactionDemand(
          facts,
          task.sourceRoom,
          boostContractStablePrefix(boostTaskId, resource),
          resource,
          typeof LAB_MINERAL_CAPACITY === "number"
            ? LAB_MINERAL_CAPACITY
            : undefined,
        ) && complete;
    }
  }
  return { complete, facts };
}

function normalizeManagedOrders(
  managedOrders: LiveManagedOrderCollection | undefined,
): readonly LiveManagedOrderExposure[] | undefined {
  if (!managedOrders) return undefined;
  return Array.isArray(managedOrders)
    ? managedOrders
    : Object.values(managedOrders);
}

function collectManagedExposure(
  managedOrders: LiveManagedOrderCollection | undefined,
): SourceCollection {
  const marketData = Memory.data?.marketSaleAutomation;
  const explicit = normalizeManagedOrders(managedOrders);
  const rawManaged = explicit ?? Object.values(marketData?.managedOrders || {});
  let complete =
    explicit !== undefined ||
    marketData === undefined ||
    asRecord(marketData.managedOrders) !== undefined;
  const facts: MarketProtectionFact[] = [];
  const orderLocation = new Map<
    string,
    { roomName: string; resource: ResourceConstant }
  >();

  for (const rawOrder of rawManaged) {
    const order = asRecord(rawOrder);
    if (
      !order ||
      typeof order.orderId !== "string" ||
      !validRoomName(order.roomName) ||
      !validResource(order.resourceType) ||
      !finiteNonNegative(order.remainingExposure)
    ) {
      complete = false;
      continue;
    }
    const liveOrder = Game.market?.orders?.[order.orderId];
    const liveRemaining = finiteNonNegative(liveOrder?.remainingAmount)
      ? liveOrder.remainingAmount
      : finiteNonNegative(liveOrder?.amount)
        ? liveOrder.amount
        : 0;
    const amount = Math.max(order.remainingExposure, liveRemaining);
    orderLocation.set(order.orderId, {
      roomName: order.roomName,
      resource: order.resourceType,
    });
    facts.push({
      roomName: order.roomName,
      resource: order.resourceType,
      amount,
      stableKey: `managed-order:${order.orderId}`,
      managedOrderId: order.orderId,
      status: "active",
    });
  }

  const pendingCreate = asRecord(marketData?.pendingCreate);
  if (pendingCreate && finiteNonNegative(pendingCreate.exposure)) {
    const tuple = asRecord(pendingCreate.tuple);
    if (
      !tuple ||
      !validRoomName(tuple.roomName) ||
      !validResource(tuple.resourceType) ||
      typeof pendingCreate.requestId !== "string"
    ) {
      complete = false;
    } else {
      facts.push({
        roomName: tuple.roomName,
        resource: tuple.resourceType,
        amount: pendingCreate.exposure,
        stableKey: `pending-create:${pendingCreate.requestId}`,
        status: "pending",
      });
    }
  } else if (pendingCreate) {
    complete = false;
  }

  const marketDataRecord = asRecord(marketData);
  const rawDirectAutomation =
    marketDataRecord?.directAutomation;
  const directAutomation = asRecord(rawDirectAutomation);
  const directMigrationBlocker =
    directAutomation?.migrationBlockedReason;
  const rawQuarantine =
    directAutomation?.quarantinedPendingDirectDeals;
  const quarantine = asRecord(rawQuarantine);
  if (
    (rawDirectAutomation !== undefined && !directAutomation) ||
    (directMigrationBlocker !== undefined &&
      directMigrationBlocker !==
        "direct_qualification_state_invalid") ||
    (rawQuarantine !== undefined &&
      (!quarantine || Object.keys(quarantine).length > 0))
  ) {
    // Quarantine 中的损坏 WAL 不能安全归属 room/resource。把完整
    // managedExposure 源标为 stale，使所有候选 sellableAmount=0。
    complete = false;
  }
  const rawPendingDirectDeals = marketDataRecord?.pendingDirectDeals;
  const pendingDirectDeals = asRecord(rawPendingDirectDeals);
  if (rawPendingDirectDeals !== undefined && !pendingDirectDeals) {
    complete = false;
  } else {
    for (const [requestId, rawPending] of Object.entries(
      pendingDirectDeals || {},
    )) {
      const pending = asRecord(rawPending);
      const roomName = pending?.canaryRoomName ?? pending?.roomName;
      const resource = pending?.resource ?? pending?.resourceType;
      const amount = pending?.dealAmount ?? pending?.amount;
      if (
        !pending ||
        !validRoomName(roomName) ||
        !validResource(resource) ||
        !finiteNonNegative(amount) ||
        amount <= 0 ||
        typeof pending.status !== "string" ||
        !["prepared", "submitted", "reconcile_gap"].includes(
          pending.status,
        )
      ) {
        complete = false;
        continue;
      }
      facts.push({
        roomName,
        resource,
        amount,
        stableKey: `pending-direct:${requestId}`,
        status: "pending",
      });
    }
  }

  const pendingMutations = asRecord(marketData?.pendingMutations);
  if (marketData && !pendingMutations) {
    complete = false;
  } else {
    for (const [orderId, rawMutation] of Object.entries(
      pendingMutations || {},
    )) {
      const mutation = asRecord(rawMutation);
      const location = orderLocation.get(orderId);
      if (
        !mutation ||
        !location ||
        !finiteNonNegative(mutation.conservativeExposure)
      ) {
        complete = false;
        continue;
      }
      facts.push({
        roomName: location.roomName,
        resource: location.resource,
        amount: mutation.conservativeExposure,
        stableKey: `managed-order:${orderId}`,
        managedOrderId: orderId,
        status: "pending",
      });
    }
  }

  return { complete, facts };
}

function toSources(
  config: MarketSaleAutomationConfig,
  candidates: readonly MarketProtectionCandidate[],
  managedOrders: LiveManagedOrderCollection | undefined,
): MutableSourceMap {
  const stock = collectStock(candidates);
  const floor = collectRoomFloors(candidates);
  const forecast = collectForecast(config, candidates);
  const reservations = collectResourceReservations();
  const outgoing = collectOutgoingTransfers();
  const carrier = collectCarrierCommitments(candidates);
  const factory = collectFactory(candidates);
  const synthesis = collectSynthesis(candidates);
  const hub = collectHub(candidates);
  const boost = collectBoost();
  const war = collectWar();
  const exposure = collectManagedExposure(managedOrders);

  return {
    stock: currentSnapshot(stock.complete, stock.facts),
    floor: currentSnapshot(floor.complete, floor.facts),
    forecast: currentSnapshot(forecast.complete, forecast.facts),
    resourceReservations: currentSnapshot(
      reservations.complete,
      reservations.facts,
    ),
    blockedOutgoing: currentSnapshot(outgoing.complete, outgoing.facts),
    carrierInFlight: currentSnapshot(carrier.complete, carrier.facts),
    factoryTargets: currentSnapshot(
      factory.targets.complete,
      factory.targets.facts,
    ),
    factoryComponents: currentSnapshot(
      factory.components.complete,
      factory.components.facts,
    ),
    factoryTasks: currentSnapshot(factory.tasks.complete, factory.tasks.facts),
    synthesisActive: currentSnapshot(
      synthesis.active.complete,
      synthesis.active.facts,
    ),
    synthesisPaused: currentSnapshot(
      synthesis.paused.complete,
      synthesis.paused.facts,
    ),
    hub: currentSnapshot(hub.complete, hub.facts),
    boost: currentSnapshot(boost.complete, boost.facts),
    war: currentSnapshot(war.complete, war.facts),
    managedExposure: currentSnapshot(exposure.complete, exposure.facts),
  };
}

export function collectLiveMarketSaleProtectionLedger(
  config: MarketSaleAutomationConfig,
  managedOrders?: LiveManagedOrderCollection,
  options: CollectLiveMarketSaleProtectionOptions = {},
): MarketSaleProtectionLedger {
  const candidates = resolveCandidates(config, options);
  return buildMarketSaleProtectionLedger({
    currentTick: Game.time,
    revision: Game.time,
    observedAt: Game.time,
    expiresAt: Game.time,
    candidates,
    sources: toSources(config, candidates, managedOrders),
  });
}
