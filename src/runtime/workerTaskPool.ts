import type { WorkerTask } from "@/types/system";
import { getDesiredWorkerCount } from "@/runtime/roomWorkforce";

const TASK_REFRESH_INTERVAL = 3;
const RAMPART_EMERGENCY_TRIGGER_HITS = 3000;
const RAMPART_EMERGENCY_TARGET_HITS = 6000;
const RAMPART_EMERGENCY_REPAIR_PRIORITY = 780;
const RAMPART_NORMAL_REPAIR_PRIORITY = 320;
const RAMPART_REPAIR_START_RATIO = 0.7;
const RAMPART_REPAIR_ENERGY_GATE_RATIO = 0.35;

function getRampartRepairCap(room: Room): number {
  const rcl = room.controller?.level ?? 1;
  if (rcl >= 8) {
    return 1_000_000;
  }
  if (rcl >= 7) {
    return 500_000;
  }
  if (rcl >= 6) {
    return 150_000;
  }
  if (rcl >= 5) {
    return 50_000;
  }
  if (rcl >= 4) {
    return 20_000;
  }
  return 10_000;
}

function canDoHighCapRampartRepair(room: Room): boolean {
  if (room.energyCapacityAvailable <= 0) {
    return false;
  }

  return room.energyAvailable / room.energyCapacityAvailable >= RAMPART_REPAIR_ENERGY_GATE_RATIO;
}

function ensureRoomMemory(roomName: string): RoomMemory {
  if (!Memory.rooms) {
    Memory.rooms = {};
  }

  if (!Memory.rooms[roomName]) {
    Memory.rooms[roomName] = {};
  }

  return Memory.rooms[roomName];
}

function ensureRoomTaskStore(roomName: string): Record<string, WorkerTask> {
  const roomMemory = ensureRoomMemory(roomName);

  if (!roomMemory.tasks) {
    roomMemory.tasks = {};
  }

  return roomMemory.tasks as Record<string, WorkerTask>;
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
  task.assignedCreeps = task.assignedCreeps.filter((name) => !!Game.creeps[name]);
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

  const maxAssignees = getDesiredWorkerCount(room);

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

function createRampartRepairTask(rampart: StructureRampart, repairMode: "emergency" | "normal"): WorkerTask {
  const targetHits = repairMode === "emergency" ? RAMPART_EMERGENCY_TARGET_HITS : getRampartRepairCap(rampart.room);
  const remaining = Math.max(0, targetHits - rampart.hits);
  const priority = repairMode === "emergency" ? RAMPART_EMERGENCY_REPAIR_PRIORITY : RAMPART_NORMAL_REPAIR_PRIORITY;
  const maxAssignees = repairMode === "normal" ? 1 : Math.max(1, Math.min(2, Math.ceil(remaining / 1500)));

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

  const rooms = Object.values(Game.rooms).filter((room) => room.controller?.my);
  for (const room of rooms) {
    const tasks = ensureRoomTaskStore(room.name);
    const activeEmergencyRepairTaskIds = new Set(
      Object.values(tasks)
        .filter((task) => task.type === "repair" && task.repairMode === "emergency" && task.status === "active")
        .map((task) => task.id),
    );
    const activeNormalRepairTaskIds = new Set(
      Object.values(tasks)
        .filter((task) => task.type === "repair" && task.repairMode === "normal" && task.status === "active")
        .map((task) => task.id),
    );
    const activeNormalRepairTargetIds = new Set(
      [...activeNormalRepairTaskIds]
        .map((taskId) => taskId.replace("repair:", ""))
        .filter((id) => !!id),
    );
    const activeRepairTaskIds = new Set(
      Object.values(tasks)
        .filter((task) => task.type === "repair" && task.status === "active")
        .map((task) => task.id),
    );
    for (const task of Object.values(tasks)) {
      task.updatedAt = -1;
    }

    const sites = room.find(FIND_CONSTRUCTION_SITES);
    for (const site of sites) {
      upsertTask(room.name, createBuildTask(site));
    }

    const rampartCap = getRampartRepairCap(room);
    const startRepairHits = Math.floor(rampartCap * RAMPART_REPAIR_START_RATIO);
    const allowHighCapRepair = canDoHighCapRampartRepair(room);

    const weakRamparts = room.find(FIND_MY_STRUCTURES, {
      filter: (structure) =>
        structure.structureType === STRUCTURE_RAMPART &&
        (structure as StructureRampart).hits < rampartCap,
    }) as StructureRampart[];
    const normalRepairCandidates: StructureRampart[] = [];

    for (const rampart of weakRamparts) {
      const taskId = `repair:${rampart.id}`;
      const wasEmergencyActive = activeEmergencyRepairTaskIds.has(taskId);
      const isEmergencyRepair =
        rampart.hits < RAMPART_EMERGENCY_TRIGGER_HITS ||
        (wasEmergencyActive && rampart.hits < RAMPART_EMERGENCY_TARGET_HITS);
      const underStartLine = rampart.hits < startRepairHits;
      const wasActive = activeRepairTaskIds.has(taskId);
      if (!isEmergencyRepair && !allowHighCapRepair) {
        continue;
      }
      if (!underStartLine && !wasActive) {
        continue;
      }

      if (isEmergencyRepair) {
        upsertTask(room.name, createRampartRepairTask(rampart, "emergency"));
      } else {
        normalRepairCandidates.push(rampart);
      }
    }

    if (normalRepairCandidates.length > 0) {
      let selectedNormalRampart = normalRepairCandidates.find((rampart) => activeNormalRepairTargetIds.has(rampart.id)) || null;

      if (!selectedNormalRampart) {
        selectedNormalRampart = normalRepairCandidates.reduce((minRampart, rampart) =>
          rampart.hits < minRampart.hits ? rampart : minRampart,
        );
      }

      upsertTask(room.name, createRampartRepairTask(selectedNormalRampart, "normal"));
    }

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

  return null;
}

function releaseTaskInternal(creep: Creep, taskId: string): void {
  const roomTasks = ensureRoomMemory(creep.room.name).tasks as Record<string, WorkerTask> | undefined;
  const task = roomTasks?.[taskId];
  if (task?.assignedCreeps) {
    task.assignedCreeps = task.assignedCreeps.filter((name) => name !== creep.name);
  }

  delete creep.memory.taskId;
  delete creep.memory.taskType;
  delete creep.memory.taskTargetId;
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

export function releaseWorkerTask(creep: Creep): void {
  const taskId = creep.memory.taskId;
  if (!taskId) {
    return;
  }

  releaseTaskInternal(creep, taskId);
}

export function assignWorkerTask(creep: Creep): WorkerTask | null {
  const roomTasks = ensureRoomMemory(creep.room.name).tasks as Record<string, WorkerTask> | undefined;
  if (!roomTasks) {
    releaseWorkerTask(creep);
    return null;
  }

  if (creep.memory.taskId) {
    const current = roomTasks[creep.memory.taskId];
    if (current && current.status === "active") {
      clampAssignees(current);
      if (!current.assignedCreeps.includes(creep.name)) {
        current.assignedCreeps.push(creep.name);
      }

      const currentTarget = getTaskTarget(current);
      if (currentTarget) {
        return current;
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

    return !!getTaskTarget(task);
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
  creep.memory.taskId = best.id;
  creep.memory.taskType = best.type;
  creep.memory.taskTargetId = best.targetId;

  return best;
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

  return false;
}
