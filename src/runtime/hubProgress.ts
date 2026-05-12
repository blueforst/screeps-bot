import { getMemoryService } from "@/runtime/runtimeServices";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
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
  } | null;
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
  transferTasks: Record<string, ResourceTransferTask> | null;
  currentTick: number;
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
  blockerRows: Array<{ room: string; terminalEnergy: number; reserve: number; pendingNonEnergy: number }>;
  blockerOverflow: number;
}

export function buildHubVisualModel(snapshot: HubProgressSnapshot): HubVisualModel {
  const activeProduct = snapshot.activeProduct;
  const productLabel = activeProduct ?? "idle";
  const statusLabel = snapshot.status ?? "—";
  const stageLabel = snapshot.stage ?? null;
  const needsPlan = snapshot.needsPlan;

  const inventoryAmount = activeProduct ? (snapshot.hubInventory[activeProduct] || 0) : 0;
  const progressPercent = activeProduct ? Math.min(inventoryAmount / HUB_PROGRESS_TARGET, 1) : 0;

  let progressText: string;
  if (activeProduct) {
    progressText = formatEnergy(inventoryAmount) + `/${HUB_PROGRESS_TARGET} stock`;
  } else {
    progressText = "0% idle";
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

  const blockerRows = snapshot.roomTerminalBlockers.slice(0, 2);
  const blockerOverflow = Math.max(0, snapshot.roomTerminalBlockers.length - 2);

  return {
    productLabel,
    statusLabel,
    stageLabel,
    needsPlan,
    progressPercent,
    progressText,
    missingSummary,
    logisticsCounts,
    blockerRows,
    blockerOverflow,
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

export function drawHubVisualPanel(rv: VisualSurface, model: HubVisualModel): void {
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

  if (model.blockerRows.length > 0) {
    for (const blocker of model.blockerRows) {
      p.textRow(
        `${blocker.room}: term ${formatEnergy(blocker.terminalEnergy)} / reserve ${formatEnergy(blocker.reserve)}, nonE ${blocker.pendingNonEnergy}`,
        { font: 0.35, color: VIS_WARN },
      );
    }
    if (model.blockerOverflow > 0) {
      p.textRow(`+${model.blockerOverflow} more`, { font: 0.35, color: VIS_MUTED });
    }
  } else {
    p.textRow("blockers: none", { font: 0.35, color: VIS_MUTED });
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

function buildCompactInventory(
  storageStore: Record<string, number> | null,
  terminalStore: Record<string, number> | null,
  targetCompounds: ResourceConstant[],
  activeProduct: string | null,
  missingResources: string[],
  lastPlanActions: string[],
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
    };
  }

  const hubRoomName = hubConfig.hubRoomName || "";
  const hubRoomVisible = !!(input.hubStorageStore !== null || input.hubTerminalStore !== null);

  const lastPlanActions = (hubRuntime?.lastPlanActions || []).slice(0, MAX_LAST_PLAN_ACTIONS);
  const missingResources = hubRuntime?.missingResources || [];
  const activeProduct = synthesisRuntime?.activeProduct || hubRuntime?.activeProduct || null;

  const hubStorageEnergy = input.hubStorageStore?.[RESOURCE_ENERGY] || 0;
  const hubTerminalEnergy = input.hubTerminalStore?.[RESOURCE_ENERGY] || 0;

  const hubInventory = buildCompactInventory(
    input.hubStorageStore,
    input.hubTerminalStore,
    hubConfig.targetCompounds || [],
    activeProduct,
    missingResources,
    lastPlanActions,
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

  const resourceControlRooms = Memory.runtime?.resourceControl?.rooms ?? null;

  const transferTasks = ensureResourceTransferTaskStore();

  return buildHubProgressSnapshot({
    hubConfig,
    hubRuntime,
    synthesisRuntime,
    hubStorageStore,
    hubTerminalStore,
    resourceControlRooms,
    transferTasks,
    currentTick: Game.time,
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

  // Line 8: blockers
  if (snapshot.roomTerminalBlockers.length > 0) {
    const b = snapshot.roomTerminalBlockers[0];
    lines.push(`blocker: ${b.room} (term=${formatEnergy(b.terminalEnergy)}, reserve=${formatEnergy(b.reserve)})`);
  }

  return lines.slice(0, MAX_OVERLAY_LINES);
}

const MAX_HUB_VISUAL_CALLS = 40;

export function renderHubProgressOverlays(): void {
  if (typeof RoomVisual === "undefined") return;
  if (!Memory.cfg?.hub?.enabled) return;

  // CPU guard
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
  const callsAfter = (global as any).__roomVisualCalls?.length ?? 0;
  const callsUsed = callsAfter - callsBefore;

  // Production RoomVisual has no __roomVisualCalls global, so callsUsed=0 and this never fires.
  // Budget warning only triggers in test mock environment where __roomVisualCalls is recorded.
  if (callsUsed > MAX_HUB_VISUAL_CALLS) {
    console.log(`[hub-visual] WARNING: panel used ${callsUsed} visual calls (max ${MAX_HUB_VISUAL_CALLS})`);
  }
}
