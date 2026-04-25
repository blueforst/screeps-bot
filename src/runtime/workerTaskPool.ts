import type { WorkerTask } from "@/types/system";
import { getPlannedControllerLinkPos, getPlannedStoragePos, getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";
import { ensureCreepAssignmentState, getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { measureCreepDecision } from "@/runtime/cpuPhaseProfiler";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { isInsideSafeZone } from "@/runtime/safeZoneHelpers";

const TASK_REFRESH_INTERVAL = 3;
const RAMPART_EMERGENCY_TARGET_HITS = 6000;
const RAMPART_NORMAL_REPAIR_PRIORITY = 320;
type PlannedLayout = { [structureType: string]: { x: number; y: number }[] };
type StructureWithOptionalOwner = Structure<StructureConstant> & {
  my?: boolean;
  owner?: { username: string };
};

type WorkerTaskBoardStore = Record<string, Record<string, WorkerTask>>;

type RuntimeGlobalWithWorkerTasks = typeof global & {
  __workerTaskBoard?: WorkerTaskBoardStore;
};

const runtimeGlobal: RuntimeGlobalWithWorkerTasks = global;

function ensureWorkerTaskBoard(): WorkerTaskBoardStore {
  if (!runtimeGlobal.__workerTaskBoard) {
    runtimeGlobal.__workerTaskBoard = {};
  }

  return runtimeGlobal.__workerTaskBoard;
}

function ensureRoomTaskStore(roomName: string): Record<string, WorkerTask> {
  const board = ensureWorkerTaskBoard();
  const existing = board[roomName];
  if (existing) {
    return existing;
  }

  const legacyTasks = Memory.rooms?.[roomName]?.tasks as Record<string, WorkerTask> | undefined;
  if (legacyTasks) {
    board[roomName] = legacyTasks;
    delete Memory.rooms[roomName].tasks;
    if (Object.keys(Memory.rooms[roomName]).length === 0) {
      delete Memory.rooms[roomName];
    }
    return board[roomName];
  }

  board[roomName] = {};
  return board[roomName];
}

export function getWorkerTasksByRoom(roomName: string): Record<string, WorkerTask> {
  const board = ensureWorkerTaskBoard();
  if (board[roomName]) {
    return board[roomName];
  }

  const legacyTasks = Memory.rooms?.[roomName]?.tasks as Record<string, WorkerTask> | undefined;
  if (!legacyTasks) {
    return {};
  }

  board[roomName] = legacyTasks;
  delete Memory.rooms[roomName].tasks;
  if (Object.keys(Memory.rooms[roomName]).length === 0) {
    delete Memory.rooms[roomName];
  }

  return board[roomName];
}

function getAssignedWorkerRoomName(creep: Creep): string {
  const configName = creep.memory.configName;
  if (!configName) {
    return creep.room.name;
  }

   const config = getCreepConfigService().get(configName);
   if (config?.role === "colonizerWorker" || config?.role === "crossShardColonizerWorker") {
     return creep.room.name;
   }

   return config?.roomName || creep.room.name;
}

function getBuildPriority(structureType: BuildableStructureConstant | StructureConstant): number {
  if (structureType === STRUCTURE_SPAWN) {
    return 900;
  }
  if (structureType === STRUCTURE_EXTENSION) {
    return 850;
  }
  if (structureType === STRUCTURE_TOWER) {
    return 800;
  }
  return 500;
}

function clampAssignees(task: WorkerTask): void {
  if (!Array.isArray(task.assignedCreeps)) {
    task.assignedCreeps = [];
  }
  task.assignedCreeps = task.assignedCreeps.filter((name) => {
    const creep = Game.creeps[name];
    return !!creep && ensureCreepAssignmentState(creep.name).taskId === task.id;
  });
}

function findTaskStore(taskId: string): Record<string, WorkerTask> | undefined {
  for (const tasks of Object.values(ensureWorkerTaskBoard())) {
    if (tasks?.[taskId]) {
      return tasks;
    }
  }

  if (!Memory.rooms) {
    return undefined;
  }

  for (const [roomName, roomMemory] of Object.entries(Memory.rooms)) {
    const tasks = roomMemory?.tasks as Record<string, WorkerTask> | undefined;
    if (!tasks?.[taskId]) {
      continue;
    }

    ensureWorkerTaskBoard()[roomName] = tasks;
    delete roomMemory.tasks;
    if (Object.keys(roomMemory).length === 0) {
      delete Memory.rooms[roomName];
    }
    return ensureWorkerTaskBoard()[roomName];
  }

  return undefined;
}

function upsertTask(roomName: string, task: WorkerTask): void {
  const tasks = ensureRoomTaskStore(roomName);
  const current = tasks[task.id];

  if (!current) {
    tasks[task.id] = task;
    return;
  }

  current.type = task.type;
  current.targetId = task.targetId;
  current.priority = task.priority;
  current.requiredWork = task.requiredWork;
  current.repairTargetHits = task.repairTargetHits;
  current.repairMode = task.repairMode;
  current.maxAssignees = task.maxAssignees;
  current.status = task.status;
  current.updatedAt = task.updatedAt;
  clampAssignees(current);
}

function createBuildTask(site: ConstructionSite): WorkerTask {
  const remaining = Math.max(0, site.progressTotal - site.progress);
  const maxAssignees = Math.max(1, Math.min(3, Math.ceil(remaining / 2000)));

  return {
    id: `build:${site.id}`,
    type: "build",
    targetId: site.id,
    roomName: site.room.name,
    priority: getBuildPriority(site.structureType),
    requiredWork: remaining,
    assignedCreeps: [],
    maxAssignees,
    status: "active",
    updatedAt: Game.time,
  };
}

function createUpgradeTask(room: Room): WorkerTask | null {
  const controller = room.controller;
  if (!controller || !controller.my) {
    return null;
  }

  const liveWorkers = getTickContextService().getCreepsByRoom(room.name).filter((creep) => {
    const configName = creep.memory.configName;
    return typeof configName === "string" && configName.startsWith(`${room.name}:worker:`);
  }).length;
  const maxAssignees = Math.max(1, liveWorkers);

  return {
    id: `upgrade:${controller.id}`,
    type: "upgrade",
    targetId: controller.id,
    roomName: room.name,
    priority: 300,
    assignedCreeps: [],
    maxAssignees,
    status: "active",
    updatedAt: Game.time,
  };
}

function createRampartRepairTask(rampart: StructureRampart): WorkerTask {
  const targetHits = rampart.hitsMax;
  const remaining = Math.max(0, targetHits - rampart.hits);
  const priority = RAMPART_NORMAL_REPAIR_PRIORITY;
  const repairMode: "normal" = "normal";
  const maxAssignees = 1;

  return {
    id: `repair:${rampart.id}`,
    type: "repair",
    targetId: rampart.id,
    roomName: rampart.room.name,
    priority,
    requiredWork: remaining,
    repairTargetHits: targetHits,
    repairMode,
    assignedCreeps: [],
    maxAssignees,
    status: "active",
    updatedAt: Game.time,
  };
}

function getPlannedPositionKey(structureType: string, x: number, y: number): string {
  return `${structureType}:${x}:${y}`;
}

function getPlannedStructurePositionKeys(layout: PlannedLayout): Set<string> {
  const planned = new Set<string>();
  for (const [structureType, positions] of Object.entries(layout)) {
    for (const pos of positions) {
      planned.add(getPlannedPositionKey(structureType, pos.x, pos.y));
    }
  }

  return planned;
}

function ensureIllegalStructureCleanupMemory(): { rooms: Record<string, { completedAt: number; layoutSavedAt: number }> } {
  Memory.runtime = Memory.runtime || {};
  if (!Memory.runtime.illegalStructureCleanup) {
    Memory.runtime.illegalStructureCleanup = { rooms: {} };
  }

  return Memory.runtime.illegalStructureCleanup;
}

function isIllegalStructureCleanupComplete(roomName: string, layoutSavedAt: number): boolean {
  return Memory.runtime?.illegalStructureCleanup?.rooms?.[roomName]?.layoutSavedAt === layoutSavedAt;
}

function markIllegalStructureCleanupComplete(roomName: string, layoutSavedAt: number): void {
  ensureIllegalStructureCleanupMemory().rooms[roomName] = {
    completedAt: Game.time,
    layoutSavedAt,
  };
}

function getProtectedContainerPositionKeys(room: Room): Set<string> {
  const protectedKeys = new Set<string>();

  for (const pos of getSourceContainerPositionsForRoom(room.name)) {
    protectedKeys.add(getPlannedPositionKey(STRUCTURE_CONTAINER, pos.x, pos.y));
  }

  const storagePos = getPlannedStoragePos(room);
  if (storagePos) {
    protectedKeys.add(getPlannedPositionKey(STRUCTURE_CONTAINER, storagePos.x, storagePos.y));
  }

  const controllerLinkPos = getPlannedControllerLinkPos(room);
  if (controllerLinkPos) {
    protectedKeys.add(getPlannedPositionKey(STRUCTURE_CONTAINER, controllerLinkPos.x, controllerLinkPos.y));
  }

  return protectedKeys;
}

function isIllegalStructureCandidate(
  structure: StructureWithOptionalOwner,
  plannedPositions: Set<string>,
  protectedContainerPositions: Set<string>,
): boolean {
  if (structure.my === true || structure.owner !== undefined) {
    return false;
  }

  if (structure.structureType === STRUCTURE_CONTROLLER) {
    return false;
  }

  if (
    structure.structureType === STRUCTURE_CONTAINER &&
    protectedContainerPositions.has(getPlannedPositionKey(STRUCTURE_CONTAINER, structure.pos.x, structure.pos.y))
  ) {
    return false;
  }

  return !plannedPositions.has(getPlannedPositionKey(structure.structureType, structure.pos.x, structure.pos.y));
}

function destroyIllegalStructures(room: Room): void {
  const roomContext = getTickContextService().getRoomContext(room);
  const layoutData = Memory.data?.roomPlanner?.[room.name];
  if (!roomContext || !layoutData || roomContext.getTowers().length === 0) {
    return;
  }

  if (isIllegalStructureCleanupComplete(room.name, layoutData.savedAt)) {
    return;
  }

  const plannedPositions = getPlannedStructurePositionKeys(layoutData.layout);
  const protectedContainerPositions = getProtectedContainerPositionKeys(room);
  const candidates = roomContext
    .getStructures()
    .filter((structure) => isIllegalStructureCandidate(structure, plannedPositions, protectedContainerPositions));

  if (candidates.length === 0) {
    markIllegalStructureCleanupComplete(room.name, layoutData.savedAt);
    return;
  }

  let allDestroyed = true;
  for (const structure of candidates) {
    const destroyCode = structure.destroy();
    if (destroyCode !== OK && destroyCode !== ERR_INVALID_TARGET) {
      allDestroyed = false;
    }
  }

  if (allDestroyed) {
    markIllegalStructureCleanupComplete(room.name, layoutData.savedAt);
  }
}

function cleanupStaleTasks(roomName: string): void {
  const tasks = ensureRoomTaskStore(roomName);
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.updatedAt !== Game.time) {
      delete tasks[taskId];
      continue;
    }

    clampAssignees(task);
  }
}

export function refreshWorkerTasks(): void {
  if (Game.time % TASK_REFRESH_INTERVAL !== 0) {
    return;
  }

  const rooms = getTickContextService().getMyRooms();
  for (const room of rooms) {
    const roomContext = getTickContextService().getRoomContext(room);
    const tasks = ensureRoomTaskStore(room.name);
    const activeAssignedNormalRepairTask = Object.values(tasks).find(
      (task) =>
        task.type === "repair" &&
        task.repairMode === "normal" &&
        task.status === "active" &&
        task.assignedCreeps.some((name) => !!Game.creeps[name]),
    );
    for (const task of Object.values(tasks)) {
      task.updatedAt = -1;
    }

    const sites = roomContext?.getConstructionSites() || [];
    for (const site of sites) {
      upsertTask(room.name, createBuildTask(site));
    }

    const weakRamparts = (roomContext?.getRamparts() || []).filter((rampart) => rampart.hits < rampart.hitsMax);
    const normalRepairCandidates: StructureRampart[] = [];

    for (const rampart of weakRamparts) {
      if (rampart.hits < RAMPART_EMERGENCY_TARGET_HITS) {
        continue;
      }

      normalRepairCandidates.push(rampart);
    }

    if (normalRepairCandidates.length > 0) {
      let selectedNormalRampart = activeAssignedNormalRepairTask
        ? normalRepairCandidates.find((rampart) => rampart.id === activeAssignedNormalRepairTask.targetId) || null
        : null;

      if (!selectedNormalRampart) {
        selectedNormalRampart = normalRepairCandidates.reduce((minRampart, rampart) =>
          rampart.hits < minRampart.hits ? rampart : minRampart,
        );
      }

      upsertTask(room.name, createRampartRepairTask(selectedNormalRampart));
    }
    destroyIllegalStructures(room);

    const upgradeTask = createUpgradeTask(room);
    if (upgradeTask) {
      upsertTask(room.name, upgradeTask);
    }

    cleanupStaleTasks(room.name);
  }
}

function getTaskTarget(task: WorkerTask): RoomObject | null {
  if (task.type === "build") {
    return Game.getObjectById(task.targetId as Id<ConstructionSite>);
  }

  if (task.type === "upgrade") {
    return Game.getObjectById(task.targetId as Id<StructureController>);
  }

  if (task.type === "repair") {
    return Game.getObjectById(task.targetId as Id<StructureRampart>);
  }

  if (task.type === "dismantle") {
    return Game.getObjectById(task.targetId as Id<Structure<StructureConstant>>);
  }

  return null;
}

function releaseTaskInternal(creep: Creep, taskId: string): void {
  const roomTasks = findTaskStore(taskId);
  const task = roomTasks?.[taskId];
  if (task?.assignedCreeps) {
    task.assignedCreeps = task.assignedCreeps.filter((name) => name !== creep.name);
  }

  delete ensureCreepAssignmentState(creep.name).taskId;
}

function scoreTask(creep: Creep, task: WorkerTask): number {
  const target = getTaskTarget(task);
  if (!target) {
    return Number.NEGATIVE_INFINITY;
  }

  const distance = creep.pos.getRangeTo(target.pos);
  const assignedPenalty = task.assignedCreeps.length * 120;

  return task.priority * 1000 - distance * 15 - assignedPenalty;
}

export function isWorkerTaskSafeForCreep(creep: Creep, task: WorkerTask): boolean {
  const assignedRoomName = getAssignedWorkerRoomName(creep);
  if (!isDefenseMode(assignedRoomName)) {
    return true;
  }

  const safeZone = getSafeZone(assignedRoomName);
  if (safeZone.size === 0) {
    return true;
  }

  const target = getTaskTarget(task);
  if (!target) {
    return false;
  }

  return target.pos.roomName === assignedRoomName && isInsideSafeZone(target.pos, safeZone);
}

export function releaseWorkerTask(creep: Creep): void {
  const taskId = ensureCreepAssignmentState(creep.name).taskId;
  if (!taskId) {
    return;
  }

  releaseTaskInternal(creep, taskId);
}

export function assignWorkerTask(creep: Creep): WorkerTask | null {
  return measureCreepDecision(() => {
    const assignedRoomName = getAssignedWorkerRoomName(creep);
    const roomTasks = getWorkerTasksByRoom(assignedRoomName);
    if (Object.keys(roomTasks).length === 0) {
      releaseWorkerTask(creep);
      return null;
    }

    const inDefenseMode = isDefenseMode(assignedRoomName);
    const safeZone = inDefenseMode ? getSafeZone(assignedRoomName) : null;

    const assignmentState = ensureCreepAssignmentState(creep.name);
    if (assignmentState.taskId) {
      const current = roomTasks[assignmentState.taskId];
      if (current && current.status === "active") {
        const currentTarget = getTaskTarget(current);
        if (inDefenseMode && safeZone && safeZone.size > 0 && currentTarget && !isInsideSafeZone(currentTarget.pos, safeZone)) {
          releaseWorkerTask(creep);
        } else {
          clampAssignees(current);
          if (!current.assignedCreeps.includes(creep.name)) {
            current.assignedCreeps.push(creep.name);
          }
          if (currentTarget) {
            return current;
          }
        }
      }

      releaseWorkerTask(creep);
    }

    const candidates = Object.values(roomTasks).filter((task) => {
      if (task.status !== "active") {
        return false;
      }

      clampAssignees(task);
      if (task.assignedCreeps.length >= task.maxAssignees) {
        return false;
      }

      const target = getTaskTarget(task);
      if (!target) {
        return false;
      }

      if (inDefenseMode && safeZone && safeZone.size > 0 && !isInsideSafeZone(target.pos, safeZone)) {
        return false;
      }

      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    let best: WorkerTask | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const task of candidates) {
      const score = scoreTask(creep, task);
      if (score > bestScore) {
        bestScore = score;
        best = task;
      }
    }

    if (!best) {
      return null;
    }

    best.assignedCreeps.push(creep.name);
    assignmentState.taskId = best.id;

    return best;
  });
}

export function getWorkerTaskTarget(task: WorkerTask): RoomObject | null {
  return getTaskTarget(task);
}

export function completeWorkerTaskIfDone(task: WorkerTask): boolean {
  if (task.type === "build") {
    const site = Game.getObjectById(task.targetId as Id<ConstructionSite>);
    return !site;
  }

  if (task.type === "upgrade") {
    const controller = Game.getObjectById(task.targetId as Id<StructureController>);
    return !controller || !controller.my;
  }

  if (task.type === "repair") {
    const rampart = Game.getObjectById(task.targetId as Id<StructureRampart>);
    if (!rampart) {
      return true;
    }

    const targetHits = task.repairTargetHits ?? RAMPART_EMERGENCY_TARGET_HITS;
    return rampart.hits >= targetHits;
  }

  if (task.type === "dismantle") {
    return !Game.getObjectById(task.targetId as Id<Structure<StructureConstant>>);
  }

  return false;
}

export function cleanupWorkerTaskBoard(ownedRooms: Set<string>): number {
  const board = ensureWorkerTaskBoard();
  let removed = 0;

  for (const roomName of Object.keys(board)) {
    if (ownedRooms.has(roomName)) {
      continue;
    }

    delete board[roomName];
    removed += 1;
  }

  return removed;
}

export function clearWorkerTaskBoardForTest(): void {
  delete runtimeGlobal.__workerTaskBoard;
}

export function getAssignedWorkerTaskId(creepName: string): string | undefined {
  return getCreepAssignmentState(creepName)?.taskId;
}
