import type { CreepConfig } from "@/types/system";

type WarStatus = "staging" | "clearing" | "done" | "failed";

interface WarTask {
  targetRoom: string;
  sourceRoom: string;
  status: WarStatus;
  reason: "npc_reservation" | "manual";
  routeRooms?: string[];
  attempts: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

const MELEE_COUNT = 2;
const HEALER_COUNT = 1;
const MAX_STAGING_TICKS = 2500;

function ensureWarStore(): Record<string, WarTask> {
  Memory.data = Memory.data || {};
  if (!Memory.data.war) {
    Memory.data.war = {};
  }

  return Memory.data.war;
}

function ensureConfigStore(): Record<string, CreepConfig> {
  Memory.data = Memory.data || {};
  if (!Memory.data.creepConfigs) {
    Memory.data.creepConfigs = {};
  }

  return Memory.data.creepConfigs;
}

function getSpawnForRoom(roomName: string): StructureSpawn | null {
  return Object.values(Game.spawns).find((spawn) => spawn.room.name === roomName) || null;
}

function getConfigName(task: WarTask, role: "meleeAttacker" | "healer", index: number): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:${role}:${index}`;
}

function getTaskConfigNames(task: WarTask): string[] {
  const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
  return Object.keys(global.creepApi.list(prefix));
}

function getLiveCreepsByConfig(configName: string): Creep[] {
  return Object.values(Game.creeps).filter((creep) => creep.memory.configName === configName);
}

function isConfigSpawning(configName: string): boolean {
  const creepMemory = Memory.creeps || {};
  return Object.values(Game.spawns).some((spawn) => {
    if (!spawn.spawning) {
      return false;
    }

    return creepMemory[spawn.spawning.name]?.configName === configName;
  });
}

function enqueueConfig(spawn: StructureSpawn, configName: string, toFront: boolean): void {
  const queue = spawn.memory.spawnList || [];
  if (toFront) {
    spawn.memory.spawnList = [configName, ...queue.filter((name) => name !== configName)];
    return;
  }

  if (!queue.includes(configName)) {
    spawn.addTask(configName);
  }
}

function removeQueuedConfig(task: WarTask, configName: string): void {
  const spawn = getSpawnForRoom(task.sourceRoom);
  if (!spawn?.memory.spawnList) {
    return;
  }

  spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
}

function removeConfigWhenIdle(configName: string): void {
  if (getLiveCreepsByConfig(configName).length > 0 || isConfigSpawning(configName)) {
    return;
  }

  const store = ensureConfigStore();
  if (store[configName]) {
    delete store[configName];
  }
}

function isHostileReservation(room: Room): boolean {
  const controller = room.controller;
  if (!controller) {
    return false;
  }

  if (controller.my || controller.owner) {
    return false;
  }

  const myUser = Object.values(Game.spawns)[0]?.owner.username || Object.values(Game.creeps)[0]?.owner.username;
  const reservation = controller.reservation;
  if (!reservation) {
    return false;
  }

  if (!myUser) {
    return true;
  }

  return reservation.username !== myUser;
}

function hasHostilePresence(room: Room): boolean {
  const hostileCreeps = room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) => creep.owner.username !== "Source Keeper",
  });
  if (hostileCreeps.length > 0) {
    return true;
  }

  const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) =>
      structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  });
  if (hostileStructures.length > 0) {
    return true;
  }

  return isHostileReservation(room);
}

function ensureCombatConfigs(task: WarTask): void {
  const store = ensureConfigStore();
  const encodedRoute = task.routeRooms?.join("|") || "";

  for (let i = 0; i < MELEE_COUNT; i++) {
    const configName = getConfigName(task, "meleeAttacker", i);
    store[configName] = {
      role: "meleeAttacker",
      args: [task.targetRoom, encodedRoute],
      roomName: task.sourceRoom,
    };
  }

  for (let i = 0; i < HEALER_COUNT; i++) {
    const configName = getConfigName(task, "healer", i);
    store[configName] = {
      role: "healer",
      args: [task.targetRoom, encodedRoute],
      roomName: task.sourceRoom,
    };
  }

  const spawn = getSpawnForRoom(task.sourceRoom);
  if (!spawn) {
    return;
  }

  for (let i = 0; i < MELEE_COUNT; i++) {
    const configName = getConfigName(task, "meleeAttacker", i);
    const hasLive = getLiveCreepsByConfig(configName).length > 0;
    const queued = spawn.memory.spawnList?.includes(configName) ?? false;
    const spawning = isConfigSpawning(configName);
    if (!hasLive && !queued && !spawning) {
      enqueueConfig(spawn, configName, true);
    }
  }

  for (let i = 0; i < HEALER_COUNT; i++) {
    const configName = getConfigName(task, "healer", i);
    const hasLive = getLiveCreepsByConfig(configName).length > 0;
    const queued = spawn.memory.spawnList?.includes(configName) ?? false;
    const spawning = isConfigSpawning(configName);
    if (!hasLive && !queued && !spawning) {
      enqueueConfig(spawn, configName, true);
    }
  }
}

function clearTaskConfigs(task: WarTask): void {
  const configNames = getTaskConfigNames(task);
  for (const configName of configNames) {
    removeQueuedConfig(task, configName);
    removeConfigWhenIdle(configName);
  }
}

function processTask(task: WarTask): void {
  const room = Game.rooms[task.targetRoom];
  const stagingTooLong = Game.time - task.createdAt > MAX_STAGING_TICKS;
  if (stagingTooLong && task.status !== "done") {
    task.status = "failed";
    clearTaskConfigs(task);
    return;
  }

  if (!room) {
    task.status = "staging";
    ensureCombatConfigs(task);
    return;
  }

  if (!hasHostilePresence(room)) {
    task.status = "done";
    task.completedAt = Game.time;
    clearTaskConfigs(task);
    return;
  }

  task.status = "clearing";
  ensureCombatConfigs(task);
}

export function requestWarRoomClear(
  targetRoom: string,
  sourceRoom: string,
  options?: { routeRooms?: string[]; reason?: "npc_reservation" | "manual" },
): void {
  const store = ensureWarStore();
  const existing = store[targetRoom];
  const now = Game.time;
  const restart = !existing || existing.status === "failed" || existing.sourceRoom !== sourceRoom;
  const nextStatus: WarStatus = restart ? "staging" : existing.status;
  const nextAttempts = restart ? (existing?.attempts ?? 0) + 1 : (existing?.attempts ?? 1);

  store[targetRoom] = {
    targetRoom,
    sourceRoom,
    status: nextStatus,
    reason: options?.reason ?? existing?.reason ?? "npc_reservation",
    routeRooms: options?.routeRooms ?? existing?.routeRooms,
    attempts: nextAttempts,
    createdAt: restart ? now : (existing?.createdAt ?? now),
    updatedAt: now,
    completedAt: existing?.completedAt,
  };
}

export function isWarRoomClearDone(roomName: string): boolean {
  const task = Memory.data?.war?.[roomName];
  return task?.status === "done";
}

export function clearWarRoomTask(roomName: string): void {
  if (Memory.data?.war?.[roomName]) {
    delete Memory.data.war[roomName];
  }
}

export function runWarControl(): void {
  const store = ensureWarStore();
  for (const task of Object.values(store)) {
    processTask(task);
    task.updatedAt = Game.time;
  }
}
