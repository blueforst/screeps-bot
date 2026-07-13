import { getCreepConfigService, getMemoryService } from "@/runtime/runtimeServices";
import { HUB_RESERVE_PER_ROOM } from "@/config/hub";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import type {
  SynthesisRoomCapability,
  SynthesisDispatchAssignment,
  AllocationLedgerEntry,
  DirectRouteDecision,
  ProgressEdge,
} from "@/runtime/hubPlanner";
import { Panel, type VisualSurface } from "@/visual/panel";

export interface HubProgressInput {
  hubConfig: {
    enabled?: boolean;
    hubRoomName?: string;
    targetCompounds?: ResourceConstant[];
    reservePerRoom?: number;
    hubReservePerCompound?: number;
  } | null;
  hubRuntime: {
    status?: "idle" | "importing" | "synthesizing" | "distributing" | "blocked";
    updatedAt?: number;
    activeProduct?: string;
    activeStep?: number;
    missingResources?: string[];
    lastPlanActions?: string[];
    needsPlan?: boolean;
    lastError?: string;
  } | null;
  synthesisRuntime: {
    stage?: string;
    activeProduct?: ResourceConstant;
    reagentA?: ResourceConstant;
    reagentB?: ResourceConstant;
    targetAmount?: number;
  } | null;
  hubLabInventory?: Record<string, number>;
  hubStorageStore: Record<string, number> | null;
  hubTerminalStore: Record<string, number> | null;
  resourceControlRooms: Record<
    string,
    {
      state: string;
      storageEnergy: number;
      terminalEnergy: number;
      energyFloor: number;
      energyTarget: number;
      energyExportStart: number;
      terminalEnergyReserve?: number;
      taskHealth?: {
        pendingIncoming: number;
        pendingOutgoing: number;
        blockedIncoming: Partial<Record<string, number>>;
        blockedOutgoing: Partial<Record<string, number>>;
      };
      nativeMineralType?: MineralConstant;
      canMineNative: boolean;
      minerals: Partial<Record<ResourceConstant, number>>;
    }
  > | null;
  hubCarrierCargo?: Record<string, number>;
  transferTasks: Record<string, ResourceTransferTask> | null;
  currentTick: number;
  distributedSynthesis?: {
    roomCapabilities?: Record<string, SynthesisRoomCapability>;
    dispatchAssignments?: SynthesisDispatchAssignment[];
    allocationLedger?: Record<string, AllocationLedgerEntry>;
    routeDecisions?: DirectRouteDecision[];
    progressEdges?: ProgressEdge[];
  };
  synthesisControlRooms?: Record<string, {
    stage?: string;
    activeProduct?: ResourceConstant;
    reagentA?: ResourceConstant;
    reagentB?: ResourceConstant;
    targetAmount?: number;
    lastError?: string;
  }>;
  synthesisControlCfgRooms?: Record<string, {
    reactions?: Array<{ product?: ResourceConstant; targetAmount?: number }>;
  }>;
  satelliteStores?: Array<{
    roomName: string;
    storage: Record<string, number> | null;
    terminal: Record<string, number> | null;
  }>;
}

/** Represents a production room in the distributed synthesis chain. */
export interface ProductionRoomEntry {
  roomName: string;
  /** The compound this room is assigned to produce. */
  product: ResourceConstant;
  /** Current synthesis stage from synthesisControl runtime. */
  stage: string;
  /** currentAmount / targetAmount, capped at 1. */
  progressPercent: number;
  /** Current amount of product available (labs + storage + terminal). */
  currentAmount: number;
  /** Target amount for this assignment. */
  targetAmount: number;
  /** Whether this is the hub room itself. */
  isHubRoom: boolean;
  /** Upstream suppliers: rooms feeding resources into this room. */
  upstream: Array<{ roomName: string; resource: ResourceConstant }>;
  /** Downstream consumers: rooms receiving this room's product. */
  downstream: Array<{ roomName: string; resource: ResourceConstant }>;
  /** Amount committed to direct-routed transfers (not via hub). */
  directSupplyAmount: number;
  /** Amount designated to flow through the hub. */
  hubSurplusAmount: number;
  /** Reason the room is blocked, if any. */
  blocker: string | null;
}

export interface HubProgressSnapshot {
  updatedAt: number;
  enabled: boolean;
  hubRoomName: string;
  hubRoomVisible: boolean;
  status: string | null;
  stage: string | null;
  activeProduct: string | null;
  lastPlanActions: string[];
  missingResources: string[];
  lastError: string | null;
  needsPlan: boolean;
  hubStorageEnergy: number;
  hubTerminalEnergy: number;
  hubInventory: Record<string, number>;
  hubCarrierCargo: Record<string, number>;
  pendingImports: number;
  pendingReclaims: number;
  pendingExports: number;
  pendingTasks: Array<{
    resource: string;
    from: string;
    to: string;
    remaining: number;
    reason: string;
  }>;
  roomTerminalBlockers: Array<{
    room: string;
    terminalEnergy: number;
    reserve: number;
    pendingNonEnergy: number;
  }>;
  hubLabInventory: Record<string, number>;
  synthesisTargetAmount?: number;
  /** Distributed production rooms with chain linkage data. */
  productionRooms: ProductionRoomEntry[];
  t3ReserveStatus: {
    hubSurplus: number;
    totalDeficit: Array<{ compound: string; needed: number }>;
  };
}

const ANALYTICS_SAMPLE_INTERVAL = 5;
const MAX_LAST_PLAN_ACTIONS = 8;
const MAX_INVENTORY_EXTRA = 10;
const MAX_OVERLAY_LINES = 8;
const DEFAULT_TERMINAL_ENERGY_RESERVE = 20_000;
// Visual layout constants
const HUB_VISUAL_X = 1;
const HUB_VISUAL_Y = 2;
const HUB_VISUAL_WIDTH = 13.5;
const HUB_VISUAL_ROW = 0.7;
const HUB_VISUAL_BAR_HEIGHT = 0.45;
const HUB_VISUAL_BAR_PAD = 0.15;
const HUB_PROGRESS_TARGET = 1000;

// Palette
const VIS_TEXT = "#c9c9c9";
const VIS_HEADER_FILL = "#1a1a2e";
const VIS_PANEL_STROKE = "#c9c9c9";
const VIS_OK = "#00ff88";
const VIS_WARN = "#ffaa00";
const VIS_ERROR = "#ff5555";
const VIS_MUTED = "#888888";

function formatEnergy(amount: number): string {
  if (amount >= 1000000) return `${Math.round(amount / 10000) / 100}M`;
  if (amount >= 1000) return `${Math.round(amount / 100) / 10}K`;
  return `${amount}`;
}

export interface HubVisualModel {
  totalTasks: number;
  roomBreakdown: Array<{ room: string; taskCount: number; resourceAmount: number }>;
  activeProduct: string | null;
  progressPercent: number;
  progressText: string;
  t3Reserve: {
    hubSurplus: number;
    totalDeficit: Array<{ compound: string; needed: number }>;
  };
}

const MAX_INBOUND_ROWS = 2;

export function buildHubVisualModel(snapshot: HubProgressSnapshot): HubVisualModel {
  const byRoom = new Map<string, { taskCount: number; resourceAmount: number }>();
  let totalTasks = 0;

  for (const task of snapshot.pendingTasks) {
    totalTasks++;
    const existing = byRoom.get(task.from);
    if (existing) {
      existing.taskCount++;
      existing.resourceAmount += task.remaining;
    } else {
      byRoom.set(task.from, { taskCount: 1, resourceAmount: task.remaining });
    }
  }

  const roomBreakdown = Array.from(byRoom.entries())
    .map(([room, data]) => ({ room, taskCount: data.taskCount, resourceAmount: data.resourceAmount }))
    .sort((a, b) => b.taskCount - a.taskCount || a.room.localeCompare(b.room));

  const activeProduct = snapshot.activeProduct;
  const isBatchMode = !!activeProduct && typeof snapshot.synthesisTargetAmount === "number" && snapshot.synthesisTargetAmount > 0;

  let progressPercent: number;
  let progressText: string;

  if (!activeProduct) {
    progressPercent = 0;
    progressText = "idle";
  } else if (isBatchMode) {
    const target = snapshot.synthesisTargetAmount!;
    const currentAmount = (snapshot.hubInventory[activeProduct] || 0) + (snapshot.hubLabInventory[activeProduct] || 0);
    progressPercent = Math.min(currentAmount / target, 1);
    progressText = `${activeProduct} ${currentAmount}/${target}`;
  } else {
    const inventoryAmount = snapshot.hubInventory[activeProduct] || 0;
    progressPercent = Math.min(inventoryAmount / HUB_PROGRESS_TARGET, 1);
    progressText = `${activeProduct} ${formatEnergy(inventoryAmount)}/${HUB_PROGRESS_TARGET}`;
  }

  return { totalTasks, roomBreakdown, activeProduct, progressPercent, progressText, t3Reserve: snapshot.t3ReserveStatus };
}

function formatCompactAmount(amount: number): string {
  if (amount >= 1000000) return `${Math.round(amount / 10000) / 100}M`;
  if (amount >= 1000) return `${Math.round(amount / 100) / 10}K`;
  return `${amount}`;
}

function drawDistributedProductionSection(
  p: Panel,
  productionRooms: ProductionRoomEntry[],
): void {
  if (productionRooms.length === 0) return;

  p.sectionHeader("Distributed Production");

  const rooms = productionRooms.slice(0, MAX_PRODUCTION_ROOM_ROWS);

  for (const room of rooms) {
    // Row 1: room name + product + stage
    const hubTag = room.isHubRoom ? " ★" : "";
    p.textRow(`${room.roomName}${hubTag} ${room.product} [${room.stage}]`, { font: 0.35 });

    // Row 2: progress bar
    const pct = room.progressPercent;
    const progressLabel = `${formatCompactAmount(room.currentAmount)}/${formatCompactAmount(room.targetAmount)} ${Math.round(pct * 100)}%`;
    const barColor = room.stage === "blocked" ? VIS_ERROR
      : room.stage === "synthesizing" ? VIS_OK
      : pct >= 1 ? VIS_OK
      : VIS_MUTED;
    p.progressBar(pct, barColor, progressLabel);

    // Row 3: upstream + downstream links + amounts
    const upstreamLabels = room.upstream
      .slice(0, MAX_LINK_LABELS)
      .map(u => u.roomName);
    const upstreamStr = upstreamLabels.length > 0
      ? `←${upstreamLabels.join(",")}${room.upstream.length > MAX_LINK_LABELS ? `+${room.upstream.length - MAX_LINK_LABELS}` : ""}`
      : "";

    const downstreamLabels = room.downstream
      .slice(0, MAX_LINK_LABELS)
      .map(d => d.roomName);
    const downstreamStr = downstreamLabels.length > 0
      ? `→${downstreamLabels.join(",")}${room.downstream.length > MAX_LINK_LABELS ? `+${room.downstream.length - MAX_LINK_LABELS}` : ""}`
      : "";

    const supplyParts: string[] = [];
    if (upstreamStr) supplyParts.push(upstreamStr);
    if (downstreamStr) supplyParts.push(downstreamStr);
    if (room.directSupplyAmount > 0) supplyParts.push(`direct:${formatCompactAmount(room.directSupplyAmount)}`);
    if (room.hubSurplusAmount > 0) supplyParts.push(`hub:${formatCompactAmount(room.hubSurplusAmount)}`);

    if (supplyParts.length > 0) {
      p.textRow(supplyParts.join(" "), { font: 0.35, color: VIS_MUTED });
    }

    // Row 4: blockers (up to 2)
    if (room.blocker) {
      p.textRow(`⚠ ${room.blocker}`, { font: 0.35, color: VIS_ERROR });
    }
  }
}

export function drawHubVisualPanel(rv: VisualSurface, model: HubVisualModel): void {
  const p = new Panel({ rv, x: HUB_VISUAL_X, y: HUB_VISUAL_Y, width: HUB_VISUAL_WIDTH });

  p.sectionHeader("Progress");
  const barColor = !model.activeProduct ? VIS_MUTED : model.progressPercent >= 1 ? VIS_OK : VIS_WARN;
  p.progressBar(model.progressPercent, barColor, model.progressText);

  p.sectionHeader("Logistics");
  p.textRow(`tasks: ${model.totalTasks}`);

  for (const room of model.roomBreakdown.slice(0, 3)) {
    p.textRow(`${room.room}: ${room.taskCount} tasks, ${formatEnergy(room.resourceAmount)}`, { font: 0.35 });
  }

  if (model.roomBreakdown.length === 0) {
    p.textRow("none", { font: 0.35, color: VIS_MUTED });
  }

  p.sectionHeader("T3 Reserve");
  const { hubSurplus, totalDeficit } = model.t3Reserve;
  const hubLabel = hubSurplus >= 0 ? `Hub: ${formatCompactAmount(hubSurplus)} surplus` : `Hub: -${formatCompactAmount(-hubSurplus)} deficit`;
  const hubColor = hubSurplus > 0 ? VIS_OK : hubSurplus < 0 ? VIS_ERROR : VIS_MUTED;
  p.textRow(hubLabel, { color: hubColor });

  const totalNeeded = totalDeficit.reduce((sum, d) => sum + d.needed, 0);
  if (totalNeeded === 0) {
    p.textRow("all rooms stocked", { font: 0.35, color: VIS_MUTED });
  }
  for (const d of totalDeficit.slice(0, 3)) {
    const deficitColor = d.needed >= 5000 ? VIS_ERROR : VIS_WARN;
    p.textRow(`${d.compound}: -${formatCompactAmount(d.needed)}`, { font: 0.35, color: deficitColor });
  }
}


/** Satellite visual panel position constants. */
const SATELLITE_VISUAL_X = 1;
const SATELLITE_VISUAL_Y = 2;
const SATELLITE_VISUAL_WIDTH = 13.5;

/** Render a compact production panel in a satellite room. */
function drawSatellitePanel(rv: VisualSurface, room: ProductionRoomEntry): void {
  const p = new Panel({ rv, x: SATELLITE_VISUAL_X, y: SATELLITE_VISUAL_Y, width: SATELLITE_VISUAL_WIDTH });

  p.sectionHeader(`Production: ${room.product} [${room.stage}]`);

  const pct = room.progressPercent;
  const progressLabel = `${formatCompactAmount(room.currentAmount)}/${formatCompactAmount(room.targetAmount)} ${Math.round(pct * 100)}%`;
  const barColor = room.stage === "blocked" ? VIS_ERROR
    : room.stage === "synthesizing" ? VIS_OK
    : pct >= 1 ? VIS_OK
    : VIS_MUTED;
  p.progressBar(pct, barColor, progressLabel);

  const upstreamLabels = room.upstream
    .slice(0, MAX_LINK_LABELS)
    .map(u => u.roomName);
  const upstreamStr = upstreamLabels.length > 0
    ? `←${upstreamLabels.join(",")}${room.upstream.length > MAX_LINK_LABELS ? `+${room.upstream.length - MAX_LINK_LABELS}` : ""}`
    : "";

  const downstreamLabels = room.downstream
    .slice(0, MAX_LINK_LABELS)
    .map(d => d.roomName);
  const downstreamStr = downstreamLabels.length > 0
    ? `→${downstreamLabels.join(",")}${room.downstream.length > MAX_LINK_LABELS ? `+${room.downstream.length - MAX_LINK_LABELS}` : ""}`
    : "";

  const supplyParts: string[] = [];
  if (upstreamStr) supplyParts.push(upstreamStr);
  if (downstreamStr) supplyParts.push(downstreamStr);
  if (room.directSupplyAmount > 0) supplyParts.push(`direct:${formatCompactAmount(room.directSupplyAmount)}`);
  if (room.hubSurplusAmount > 0) supplyParts.push(`hub:${formatCompactAmount(room.hubSurplusAmount)}`);

  if (supplyParts.length > 0) {
    p.textRow(supplyParts.join(" "), { font: 0.35, color: VIS_MUTED });
  }

  if (room.blocker) {
    p.textRow(`⚠ ${room.blocker}`, { font: 0.35, color: VIS_ERROR });
  }
}

function classifyTransferTask(
  reason: string | undefined,
): "import" | "reclaim" | "export" | null {
  if (!reason) return null;
  if (reason.startsWith("hub:import:")) return "import";
  if (reason.startsWith("hub:reclaim:")) return "reclaim";
  if (reason.startsWith("hub:export:")) return "export";
  return null;
}

export function collectCarrierCargoInventory(hubRoomName: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.role !== "carrier") continue;
    const configName = creep.memory.configName;
    const assignedRoom = configName
      ? getCreepConfigService().get(configName)?.roomName || creep.room.name
      : creep.room.name;
    if (assignedRoom !== hubRoomName) continue;
    const store = creep.store as unknown as Record<string, number>;
    for (const [resource, amount] of Object.entries(store)) {
      if (resource !== RESOURCE_ENERGY && amount > 0) {
        result[resource] = (result[resource] || 0) + amount;
      }
    }
  }
  return result;
}

function buildCompactInventory(
  storageStore: Record<string, number> | null,
  terminalStore: Record<string, number> | null,
  targetCompounds: ResourceConstant[],
  activeProduct: string | null,
  missingResources: string[],
  lastPlanActions: string[],
  carrierCargo: Record<string, number>,
): Record<string, number> {
  const combined: Record<string, number> = {};

  if (storageStore) {
    for (const [resource, amount] of Object.entries(storageStore)) {
      if (amount > 0) combined[resource] = (combined[resource] || 0) + amount;
    }
  }
  if (terminalStore) {
    for (const [resource, amount] of Object.entries(terminalStore)) {
      if (amount > 0) combined[resource] = (combined[resource] || 0) + amount;
    }
  }
  for (const [resource, amount] of Object.entries(carrierCargo)) {
    if (amount > 0) combined[resource] = (combined[resource] || 0) + amount;
  }

  const priorityResources = new Set<string>();
  for (const tc of targetCompounds) priorityResources.add(tc);
  if (activeProduct) priorityResources.add(activeProduct);
  for (const mr of missingResources) priorityResources.add(mr);
  for (const pa of lastPlanActions) priorityResources.add(pa);

  const result: Record<string, number> = {};
  for (const resource of priorityResources) {
    if (combined[resource] !== undefined) result[resource] = combined[resource];
  }

  const remaining = Object.entries(combined)
    .filter(([resource]) => !priorityResources.has(resource) && resource !== RESOURCE_ENERGY)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_INVENTORY_EXTRA);

  for (const [resource, amount] of remaining) {
    result[resource] = amount;
  }

  return result;
}

function countPendingHubTasks(
  transferTasks: Record<string, ResourceTransferTask> | null,
  hubRoomName: string,
): {
  pendingImports: number;
  pendingReclaims: number;
  pendingExports: number;
  pendingTasks: Array<{ resource: string; from: string; to: string; remaining: number; reason: string }>;
} {
  let pendingImports = 0;
  let pendingReclaims = 0;
  let pendingExports = 0;
  const pendingTasks: Array<{ resource: string; from: string; to: string; remaining: number; reason: string }> = [];

  if (!transferTasks) {
    return { pendingImports, pendingReclaims, pendingExports, pendingTasks };
  }

  for (const task of Object.values(transferTasks)) {
    if (task.status !== "pending") continue;
    const classification = classifyTransferTask(task.reason);
    if (!classification) continue;

    if (task.fromRoomName !== hubRoomName && task.toRoomName !== hubRoomName) continue;

    pendingTasks.push({
      resource: task.resource,
      from: task.fromRoomName,
      to: task.toRoomName,
      remaining: task.remainingAmount,
      reason: task.reason || "",
    });

    if (classification === "import") pendingImports++;
    else if (classification === "reclaim") pendingReclaims++;
    else if (classification === "export") pendingExports++;
  }

  return { pendingImports, pendingReclaims, pendingExports, pendingTasks };
}

function buildRoomTerminalBlockers(
  resourceControlRooms: HubProgressInput["resourceControlRooms"],
  transferTasks: Record<string, ResourceTransferTask> | null,
  hubRoomName: string,
): Array<{ room: string; terminalEnergy: number; reserve: number; pendingNonEnergy: number }> {
  if (!resourceControlRooms) return [];

  const result: Array<{ room: string; terminalEnergy: number; reserve: number; pendingNonEnergy: number }> = [];
  const roomEntries = Object.entries(resourceControlRooms).filter(([roomName]) => roomName !== hubRoomName);
  const needsPendingNonEnergyIndex = roomEntries.some(([, roomData]) => {
    if (!roomData.taskHealth) return true;
    return roomData.taskHealth.pendingIncoming + roomData.taskHealth.pendingOutgoing !== 0;
  });
  const pendingNonEnergyByRoom = new Map<string, number>();

  if (needsPendingNonEnergyIndex && transferTasks) {
    for (const task of Object.values(transferTasks)) {
      if (task.status !== "pending") continue;
      if (task.resource === RESOURCE_ENERGY) continue;

      pendingNonEnergyByRoom.set(
        task.fromRoomName,
        (pendingNonEnergyByRoom.get(task.fromRoomName) || 0) + 1,
      );
      if (task.toRoomName !== task.fromRoomName) {
        pendingNonEnergyByRoom.set(
          task.toRoomName,
          (pendingNonEnergyByRoom.get(task.toRoomName) || 0) + 1,
        );
      }
    }
  }

  for (const [roomName, roomData] of roomEntries) {
    const projectedPending = roomData.taskHealth
      ? roomData.taskHealth.pendingIncoming + roomData.taskHealth.pendingOutgoing
      : undefined;
    const pendingNonEnergy = projectedPending === 0 ? 0 : (pendingNonEnergyByRoom.get(roomName) || 0);

    result.push({
      room: roomName,
      terminalEnergy: roomData.terminalEnergy,
      reserve: roomData.terminalEnergyReserve ?? DEFAULT_TERMINAL_ENERGY_RESERVE,
      pendingNonEnergy,
    });
  }

  return result;
}

function buildProductionRooms(
  distributedSynthesis: HubProgressInput["distributedSynthesis"],
  synthesisControlRooms: HubProgressInput["synthesisControlRooms"],
  synthesisControlCfgRooms: HubProgressInput["synthesisControlCfgRooms"],
  hubRoomName: string,
): ProductionRoomEntry[] {
  if (!distributedSynthesis?.dispatchAssignments?.length) return [];

  const assignments = distributedSynthesis.dispatchAssignments;
  const routeDecisions = distributedSynthesis.routeDecisions ?? [];
  const progressEdges = distributedSynthesis.progressEdges ?? [];
  const allocationLedger = distributedSynthesis.allocationLedger ?? {};

  const busyStages = new Set(["loading", "synthesizing", "unloading"]);

  // Group assignments by roomName, preserving first-seen order.
  const roomGroups = new Map<string, typeof assignments>();
  const roomOrder: string[] = [];
  for (const a of assignments) {
    if (!roomGroups.has(a.roomName)) {
      roomGroups.set(a.roomName, []);
      roomOrder.push(a.roomName);
    }
    roomGroups.get(a.roomName)!.push(a);
  }

  // For each room, select the best assignment and build exactly one entry.
  const selectedAssignments: typeof assignments = [];
  for (const roomName of roomOrder) {
    const group = roomGroups.get(roomName)!;
    if (group.length === 1) {
      selectedAssignments.push(group[0]);
      continue;
    }

    const runtimeRoom = synthesisControlRooms?.[roomName];
    const activeProduct = runtimeRoom?.activeProduct;
    const stage = runtimeRoom?.stage ?? "idle";

    let selected = group[0];
    if (activeProduct && busyStages.has(stage)) {
      const match = group.find(a => a.product === activeProduct);
      if (match) selected = match;
    }
    selectedAssignments.push(selected);
  }

  return selectedAssignments.map((assignment) => {
    const { roomName, targetAmount, isHubRoom } = assignment;

    const runtimeRoom = synthesisControlRooms?.[roomName];
    const stage = runtimeRoom?.stage ?? "idle";

    // Show the actual configured product when the room is busy with a reaction,
    // not the planner's intended assignment (which may differ until reassignment).
    const cfgProduct = synthesisControlCfgRooms?.[roomName]?.reactions?.[0]?.product;
    const product = (cfgProduct && busyStages.has(stage)) ? cfgProduct as ResourceConstant : assignment.product;

    const room = Game.rooms[roomName];
    let currentAmount = 0;
    if (room) {
      const storageAmount = (room.storage?.store as unknown as Record<string, number>)?.[product] ?? 0;
      const terminalAmount = (room.terminal?.store as unknown as Record<string, number>)?.[product] ?? 0;
      let labAmount = 0;
      if (typeof room.find === "function") {
        const labs = room.find(FIND_MY_STRUCTURES, {
          filter: (s: AnyStructure) => s.structureType === STRUCTURE_LAB,
        }) as StructureLab[];
        for (const lab of labs) {
          const store = lab.store as unknown as Record<string, number>;
          labAmount += store[product] ?? 0;
        }
      }
      currentAmount = storageAmount + terminalAmount + labAmount;
    }

    const progressPercent = targetAmount > 0 ? Math.min(currentAmount / targetAmount, 1) : 0;

    const upstream: Array<{ roomName: string; resource: ResourceConstant }> = [];
    const downstream: Array<{ roomName: string; resource: ResourceConstant }> = [];

    for (const edge of progressEdges) {
      if (edge.toRoom === roomName) {
        upstream.push({ roomName: edge.fromRoom, resource: edge.resource });
      }
      if (edge.fromRoom === roomName) {
        downstream.push({ roomName: edge.toRoom, resource: edge.resource });
      }
    }

    let directSupplyAmount = 0;
    for (const route of routeDecisions) {
      if (route.fromRoom === roomName && route.toRoom !== hubRoomName) {
        directSupplyAmount += route.amount;
      }
    }

    let hubSurplusAmount = 0;
    for (const route of routeDecisions) {
      if (route.fromRoom === roomName && route.toRoom === hubRoomName) {
        hubSurplusAmount += route.amount;
      }
    }

    const blocker = runtimeRoom?.lastError ?? null;

    return {
      roomName,
      product,
      stage,
      progressPercent,
      currentAmount,
      targetAmount,
      isHubRoom,
      upstream,
      downstream,
      directSupplyAmount,
      hubSurplusAmount,
      blocker,
    };
  });
}

function buildT3ReserveStatus(
  hubStorageStore: Record<string, number> | null,
  hubTerminalStore: Record<string, number> | null,
  hubLabInventory: Record<string, number>,
  targetCompounds: ResourceConstant[],
  reservePerRoom: number,
  hubReservePerCompound: number,
  satelliteStores: HubProgressInput["satelliteStores"],
): { hubSurplus: number; totalDeficit: Array<{ compound: string; needed: number }> } {
  let hubSurplus = 0;
  for (const compound of targetCompounds) {
    const hubAmount = (hubStorageStore?.[compound] || 0) + (hubTerminalStore?.[compound] || 0) + (hubLabInventory[compound] || 0);
    hubSurplus += Math.max(0, hubAmount - hubReservePerCompound);
  }

  const compoundDeficit: Record<string, number> = {};
  if (satelliteStores) {
    for (const sat of satelliteStores) {
      for (const compound of targetCompounds) {
        const current = (sat.storage?.[compound] || 0) + (sat.terminal?.[compound] || 0);
        const needed = Math.max(0, reservePerRoom - current);
        if (needed > 0) {
          compoundDeficit[compound] = (compoundDeficit[compound] || 0) + needed;
        }
      }
    }
  }

  const totalDeficit = Object.entries(compoundDeficit)
    .map(([compound, needed]) => ({ compound, needed }))
    .sort((a, b) => b.needed - a.needed);

  return { hubSurplus, totalDeficit };
}

export function buildHubProgressSnapshot(input: HubProgressInput): HubProgressSnapshot {
  const { hubConfig, hubRuntime, synthesisRuntime, currentTick } = input;

  if (!hubConfig?.enabled) {
    return {
      updatedAt: currentTick,
      enabled: false,
      hubRoomName: hubConfig?.hubRoomName || "",
      hubRoomVisible: false,
      status: null,
      stage: null,
      activeProduct: null,
      lastPlanActions: [],
      missingResources: [],
      lastError: null,
      needsPlan: false,
      hubStorageEnergy: 0,
      hubTerminalEnergy: 0,
      hubInventory: {},
      pendingImports: 0,
      pendingReclaims: 0,
      pendingExports: 0,
      pendingTasks: [],
      roomTerminalBlockers: [],
      hubLabInventory: {},
      hubCarrierCargo: {},
      productionRooms: [],
      t3ReserveStatus: { hubSurplus: 0, totalDeficit: [] },
    };
  }

  const hubRoomName = hubConfig.hubRoomName || "";
  const hubRoomVisible = !!(input.hubStorageStore !== null || input.hubTerminalStore !== null);

  const lastPlanActions = (hubRuntime?.lastPlanActions || []).slice(0, MAX_LAST_PLAN_ACTIONS);
  const missingResources = hubRuntime?.missingResources || [];
  const activeProduct = synthesisRuntime?.activeProduct || hubRuntime?.activeProduct || null;

  const hubStorageEnergy = input.hubStorageStore?.[RESOURCE_ENERGY] || 0;
  const hubTerminalEnergy = input.hubTerminalStore?.[RESOURCE_ENERGY] || 0;

  const hubCarrierCargo = input.hubCarrierCargo ?? {};
  const hubInventory = buildCompactInventory(
    input.hubStorageStore,
    input.hubTerminalStore,
    hubConfig.targetCompounds || [],
    activeProduct,
    missingResources,
    lastPlanActions,
    hubCarrierCargo,
  );

  const { pendingImports, pendingReclaims, pendingExports, pendingTasks } = countPendingHubTasks(
    input.transferTasks,
    hubRoomName,
  );

  const roomTerminalBlockers = buildRoomTerminalBlockers(
    input.resourceControlRooms,
    input.transferTasks,
    hubRoomName,
  );

  const targetCompounds = hubConfig.targetCompounds?.length ? hubConfig.targetCompounds : [];
  const reservePerRoom = hubConfig.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
  const hubReservePerCompound = hubConfig.hubReservePerCompound ?? 0;
  const t3ReserveStatus = buildT3ReserveStatus(
    input.hubStorageStore,
    input.hubTerminalStore,
    input.hubLabInventory ?? {},
    targetCompounds,
    reservePerRoom,
    hubReservePerCompound,
    input.satelliteStores,
  );

  return {
    updatedAt: currentTick,
    enabled: true,
    hubRoomName,
    hubRoomVisible,
    status: hubRuntime?.status || null,
    stage: synthesisRuntime?.stage || null,
    activeProduct,
    lastPlanActions,
    missingResources,
    lastError: hubRuntime?.lastError || null,
    needsPlan: hubRuntime?.needsPlan || false,
    hubStorageEnergy,
    hubTerminalEnergy,
    hubInventory,
    pendingImports,
    pendingReclaims,
    pendingExports,
    pendingTasks,
    roomTerminalBlockers,
    hubLabInventory: input.hubLabInventory ?? {},
    hubCarrierCargo,
    synthesisTargetAmount: input.synthesisRuntime?.targetAmount,
    productionRooms: buildProductionRooms(
      input.distributedSynthesis,
      input.synthesisControlRooms,
      input.synthesisControlCfgRooms,
      hubRoomName,
    ),
    t3ReserveStatus,
  };
}

export function collectHubProgressSnapshot(): HubProgressSnapshot {
  const hubConfig = Memory.cfg?.hub ?? null;
  const hubRuntime = Memory.runtime?.hub ?? null;
  const hubRoomName = hubConfig?.hubRoomName || "";

  const synthesisRoom = Memory.runtime?.synthesisControl?.rooms?.[hubRoomName];
  const synthesisRuntime = synthesisRoom ?? null;

  const room = hubRoomName ? Game.rooms[hubRoomName] : undefined;
  const hubStorageStore = (room?.storage?.store as unknown as Record<string, number> | undefined) ?? null;
  const hubTerminalStore = (room?.terminal?.store as unknown as Record<string, number> | undefined) ?? null;

  const hubLabInventory: Record<string, number> = {};
  if (room && typeof room.find === "function") {
    const labs = room.find(FIND_MY_STRUCTURES, {
      filter: (s: AnyStructure) => s.structureType === STRUCTURE_LAB,
    }) as StructureLab[];
    for (const lab of labs) {
      const store = lab.store as unknown as Record<string, number>;
      for (const [resource, amount] of Object.entries(store)) {
        if (resource !== RESOURCE_ENERGY && amount > 0) {
          hubLabInventory[resource] = (hubLabInventory[resource] || 0) + amount;
        }
      }
    }
  }

  const resourceControlRooms = Memory.runtime?.resourceControl?.rooms ?? null;

  const transferTasks = ensureResourceTransferTaskStore();

  const hubCarrierCargo = collectCarrierCargoInventory(hubRoomName);

  const satelliteStores: Array<{
    roomName: string;
    storage: Record<string, number> | null;
    terminal: Record<string, number> | null;
  }> = [];
  if (hubRoomName) {
    for (const [roomName, room] of Object.entries(Game.rooms)) {
      if (roomName === hubRoomName) continue;
      if (!room.controller?.my) continue;
      if (!room.storage || !room.terminal) continue;
      satelliteStores.push({
        roomName,
        storage: room.storage.store as unknown as Record<string, number>,
        terminal: room.terminal.store as unknown as Record<string, number>,
      });
    }
  }

  return buildHubProgressSnapshot({
    hubConfig,
    hubRuntime,
    synthesisRuntime,
    hubStorageStore,
    hubTerminalStore,
    hubLabInventory,
    hubCarrierCargo,
    resourceControlRooms,
    transferTasks,
    currentTick: Game.time,
    distributedSynthesis: Memory.runtime?.hub?.distributedSynthesis,
    synthesisControlRooms: Memory.runtime?.synthesisControl?.rooms,
    synthesisControlCfgRooms: Memory.cfg?.synthesisControl?.rooms,
    satelliteStores,
  });
}

export function runHubProgressAnalytics(): void {
  const hubConfig = Memory.cfg?.hub;
  if (!hubConfig?.enabled) return;

  const hubRuntime = Memory.runtime?.hub;
  const needsPlan = hubRuntime?.needsPlan === true;

  if (!needsPlan && Game.time % ANALYTICS_SAMPLE_INTERVAL !== 0) {
    return;
  }

  const snapshot = collectHubProgressSnapshot();
  const analytics = getMemoryService().ensureAnalytics();
  analytics.hub = snapshot;
}

export function buildHubOverlayLines(snapshot: HubProgressSnapshot): string[] {
  if (!snapshot.enabled) return [];

  const lines: string[] = [];
  const model = buildHubVisualModel(snapshot);

  lines.push(`progress: ${model.progressText}`);
  lines.push(`tasks: ${model.totalTasks}`);
  for (const room of model.roomBreakdown.slice(0, 3)) {
    lines.push(`${room.room}: ${room.taskCount} tasks, ${formatEnergy(room.resourceAmount)}`);
  }

  return lines.slice(0, MAX_OVERLAY_LINES);
}

const MAX_PRODUCTION_ROOM_ROWS = 6;
const MAX_LINK_LABELS = 2;
const MAX_HUB_VISUAL_CALLS = 80;

export function renderHubProgressOverlays(): void {
  if (typeof RoomVisual === "undefined") return;
  if (!Memory.cfg?.hub?.enabled) return;

  if (Game.cpu.bucket < 100) return;

  const snapshot = collectHubProgressSnapshot();
  if (!snapshot.enabled) return;
  if (!snapshot.hubRoomName) return;

  const hubRoom = Game.rooms[snapshot.hubRoomName];
  if (!hubRoom) return;

  const rv = new RoomVisual(snapshot.hubRoomName);
  const model = buildHubVisualModel(snapshot);

  const callsBefore = (global as any).__roomVisualCalls?.length ?? 0;
  drawHubVisualPanel(rv, model);

  const seenRooms = new Set<string>();
  seenRooms.add(snapshot.hubRoomName);

  for (const room of snapshot.productionRooms) {
    if (room.isHubRoom || room.roomName === snapshot.hubRoomName || seenRooms.has(room.roomName) || !Game.rooms[room.roomName]) continue;
    seenRooms.add(room.roomName);
    const satelliteRv = new RoomVisual(room.roomName);
    drawSatellitePanel(satelliteRv, room);
  }

  const callsAfter = (global as any).__roomVisualCalls?.length ?? 0;
  const callsUsed = callsAfter - callsBefore;

  if (callsUsed > MAX_HUB_VISUAL_CALLS) {
    console.log(`[hub-visual] WARNING: panel used ${callsUsed} visual calls (max ${MAX_HUB_VISUAL_CALLS})`);
  }
}
