import type { WorkerTask } from "@/types/system";
import { measureCreepDecision } from "@/runtime/cpuPhaseProfiler";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";

const TASK_REFRESH_INTERVAL = 3;
const RAMPART_EMERGENCY_TARGET_HITS = 6000;
const RAMPART_NORMAL_REPAIR_PRIORITY = 320;

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

function getAssignedWorkerRoomName(creep: Creep): string {
  const configName = creep.memory.configName;
  if (!configName) {
    return creep.room.name;
  }

  return getCreepConfigService().get(configName)?.roomName || creep.room.name;
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
    return !!creep && creep.memory.taskId === task.id;
  });
}

function findTaskStore(taskId: string): Record<string, WorkerTask> | undefined {
  if (!Memory.rooms) {
    return undefined;
  }

  for (const roomMemory of Object.values(Memory.rooms)) {
    const tasks = roomMemory?.tasks as Record<string, WorkerTask> | undefined;
    if (tasks?.[taskId]) {
      return tasks;
    }
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
  const roomTasks = findTaskStore(taskId);
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
  return measureCreepDecision(() => {
    const roomTasks = ensureRoomMemory(getAssignedWorkerRoomName(creep)).tasks as Record<string, WorkerTask> | undefined;
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

  return false;
}
