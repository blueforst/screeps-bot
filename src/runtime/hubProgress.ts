import { getCreepConfigService, getMemoryService } from "@/runtime/runtimeServices";
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
}

const ANALYTICS_SAMPLE_INTERVAL = 5;
const MAX_LAST_PLAN_ACTIONS = 8;
const MAX_INVENTORY_EXTRA = 10;
const MAX_OVERLAY_LINES = 8;

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
  productLabel: string;
  statusLabel: string;
  stageLabel: string | null;
  needsPlan: boolean;
  progressPercent: number;
  progressText: string;
  missingSummary: string;
  logisticsCounts: { imports: number; reclaims: number; exports: number };
  inboundRows: Array<{ room: string; amount: number; taskCount: number }>;
  inboundOverflow: number;
}

const MAX_INBOUND_ROWS = 2;

export function buildInboundTransferRows(snapshot: HubProgressSnapshot): {
  rows: Array<{ room: string; amount: number; taskCount: number }>;
  overflow: number;
} {
  const hub = snapshot.hubRoomName;
  const bySource = new Map<string, { amount: number; taskCount: number }>();

  for (const task of snapshot.pendingTasks) {
    if (task.to !== hub) continue;
    if (task.from === hub) continue;

    const existing = bySource.get(task.from);
    if (existing) {
      existing.amount += task.remaining;
      existing.taskCount += 1;
    } else {
      bySource.set(task.from, { amount: task.remaining, taskCount: 1 });
    }
  }

  const sorted = Array.from(bySource.entries())
    .map(([room, data]) => ({ room, amount: data.amount, taskCount: data.taskCount }))
    .sort((a, b) => b.amount - a.amount || a.room.localeCompare(b.room));

  return {
    rows: sorted.slice(0, MAX_INBOUND_ROWS),
    overflow: Math.max(0, sorted.length - MAX_INBOUND_ROWS),
  };
}

export function buildHubVisualModel(snapshot: HubProgressSnapshot): HubVisualModel {
  const activeProduct = snapshot.activeProduct;
  const productLabel = activeProduct ?? "idle";
  const statusLabel = snapshot.status ?? "—";
  const stageLabel = snapshot.stage ?? null;
  const needsPlan = snapshot.needsPlan;

  const isBatchMode = !!activeProduct && typeof snapshot.synthesisTargetAmount === "number" && snapshot.synthesisTargetAmount > 0;

  let progressPercent: number;
  let progressText: string;

  if (!activeProduct) {
    progressPercent = 0;
    progressText = "0% idle";
  } else if (isBatchMode) {
    const target = snapshot.synthesisTargetAmount!;
    const currentAmount = (snapshot.hubInventory[activeProduct] || 0) + (snapshot.hubLabInventory[activeProduct] || 0);
    progressPercent = Math.min(currentAmount / target, 1);
    const stageOrStatus = stageLabel ?? statusLabel;
    progressText = `${activeProduct} ${currentAmount}/${target} ${stageOrStatus}`;
  } else {
    const inventoryAmount = snapshot.hubInventory[activeProduct] || 0;
    progressPercent = Math.min(inventoryAmount / HUB_PROGRESS_TARGET, 1);
    progressText = formatEnergy(inventoryAmount) + `/${HUB_PROGRESS_TARGET} stock`;
  }

  const missingResources = snapshot.missingResources;
  let missingSummary = "";
  if (missingResources.length > 0) {
    const first4 = missingResources.slice(0, 4);
    const remainder = missingResources.length - 4;
    missingSummary = first4.join(", ");
    if (remainder > 0) {
      missingSummary += `, +${remainder}`;
    }
  }

  const logisticsCounts = {
    imports: snapshot.pendingImports,
    reclaims: snapshot.pendingReclaims,
    exports: snapshot.pendingExports,
  };

  const { rows: inboundRows, overflow: inboundOverflow } = buildInboundTransferRows(snapshot);

  return {
    productLabel,
    statusLabel,
    stageLabel,
    needsPlan,
    progressPercent,
    progressText,
    missingSummary,
    logisticsCounts,
    inboundRows,
    inboundOverflow,
  };
}

function getStatusColor(model: HubVisualModel): string {
  if (model.statusLabel === "blocked") return VIS_ERROR;
  if (model.needsPlan || model.missingSummary !== "") return VIS_WARN;
  if (model.statusLabel === "synthesizing") return VIS_OK;
  if (!model.productLabel || model.productLabel === "idle") return VIS_MUTED;
  return VIS_OK;
}

const getProgressColor = getStatusColor;

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

export function drawHubVisualPanel(rv: VisualSurface, model: HubVisualModel, productionRooms?: ProductionRoomEntry[]): void {
  const p = new Panel({ rv, x: HUB_VISUAL_X, y: HUB_VISUAL_Y, width: HUB_VISUAL_WIDTH });

  p.sectionHeader("Hub Production");

  const statusColor = getStatusColor(model);
  p.textRow(model.productLabel, { color: statusColor });

  if (model.statusLabel !== "—") {
    p.textRow("status: " + model.statusLabel, { color: statusColor });
  }
  if (model.stageLabel !== null) {
    p.textRow("stage: " + model.stageLabel, { color: statusColor });
  }
  if (model.needsPlan) {
    p.textRow("⚠ needs plan", { color: VIS_WARN });
  }

  p.spacer(HUB_VISUAL_ROW);

  p.sectionHeader("Progress");
  const progressColor = getProgressColor(model);
  p.progressBar(model.progressPercent, progressColor, model.progressText);

  p.sectionHeader("Logistics");
  const lc = model.logisticsCounts;
  p.textRow(`imp ${lc.imports} | recl ${lc.reclaims} | exp ${lc.exports}`);

  if (model.inboundRows.length > 0) {
    for (const row of model.inboundRows) {
      const label = row.taskCount === 1
        ? `${row.room}: ${formatEnergy(row.amount)} inbound`
        : `${row.room}: ${formatEnergy(row.amount)} inbound (${row.taskCount} tasks)`;
      p.textRow(label, { font: 0.35, color: VIS_WARN });
    }
    if (model.inboundOverflow > 0) {
      p.textRow(`+${model.inboundOverflow} more inbound`, { font: 0.35, color: VIS_MUTED });
    }
  } else {
    p.textRow("inbound: none", { font: 0.35, color: VIS_MUTED });
  }

  if (productionRooms && productionRooms.length > 0) {
    const hubOnly = productionRooms.filter(r => r.isHubRoom);
    if (hubOnly.length > 0) {
      drawDistributedProductionSection(p, hubOnly);
    }
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

  for (const [roomName, roomData] of Object.entries(resourceControlRooms)) {
    if (roomName === hubRoomName) continue;

    let pendingNonEnergy = 0;
    if (transferTasks) {
      for (const task of Object.values(transferTasks)) {
        if (task.status !== "pending") continue;
        if (task.resource === RESOURCE_ENERGY) continue;
        if (task.fromRoomName === roomName || task.toRoomName === roomName) {
          pendingNonEnergy++;
        }
      }
    }

    result.push({
      room: roomName,
      terminalEnergy: roomData.terminalEnergy,
      reserve: roomData.energyFloor,
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

  return assignments.map((assignment) => {
    const { roomName, targetAmount, isHubRoom } = assignment;

    const runtimeRoom = synthesisControlRooms?.[roomName];
    const stage = runtimeRoom?.stage ?? "idle";

    // Show the actual configured product when the room is busy with a reaction,
    // not the planner's intended assignment (which may differ until reassignment).
    const cfgProduct = synthesisControlCfgRooms?.[roomName]?.reactions?.[0]?.product;
    const busyStages = new Set(["loading", "synthesizing", "unloading"]);
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

  // Line 1: status + product
  const statusStr = snapshot.status ?? "—";
  const productStr = snapshot.activeProduct ?? "—";
  lines.push(`[hub] ${statusStr} product=${productStr}`);

  // Line 2: stage
  if (snapshot.stage) {
    lines.push(`stage=${snapshot.stage}`);
  }

  // Line 3: plan actions (truncated)
  if (snapshot.lastPlanActions.length > 0) {
    const actions = snapshot.lastPlanActions.slice(0, 4).join(", ");
    lines.push(`plan: ${actions}`);
  }

  // Line 4: missing
  if (snapshot.missingResources.length > 0) {
    lines.push(`missing: ${snapshot.missingResources.join(", ")}`);
  }

  // Line 5: error
  lines.push(`error: ${snapshot.lastError ?? "(none)"}`);

  // Line 6: energy
  lines.push(`storage=${formatEnergy(snapshot.hubStorageEnergy)} terminal=${formatEnergy(snapshot.hubTerminalEnergy)}`);

  // Line 7: tasks
  lines.push(`tasks: ${snapshot.pendingImports} imp, ${snapshot.pendingReclaims} recl, ${snapshot.pendingExports} exp`);

  // Line 8: inbound summary
  const inbound = buildInboundTransferRows(snapshot);
  if (inbound.rows.length > 0) {
    const top = inbound.rows[0];
    const totalSourceRooms = inbound.rows.length + inbound.overflow;
    let line = `inbound: ${top.room} ${formatEnergy(top.amount)} (${top.taskCount} tasks)`;
    if (totalSourceRooms > 1) {
      line += `, +${totalSourceRooms - 1} more`;
    }
    lines.push(line);
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
  drawHubVisualPanel(rv, model, snapshot.productionRooms);

  for (const room of snapshot.productionRooms) {
    if (room.isHubRoom) continue;
    if (!Game.rooms[room.roomName]) continue;
    const satelliteRv = new RoomVisual(room.roomName);
    drawSatellitePanel(satelliteRv, room);
  }

  const callsAfter = (global as any).__roomVisualCalls?.length ?? 0;
  const callsUsed = callsAfter - callsBefore;

  if (callsUsed > MAX_HUB_VISUAL_CALLS) {
    console.log(`[hub-visual] WARNING: panel used ${callsUsed} visual calls (max ${MAX_HUB_VISUAL_CALLS})`);
  }
}
