import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import type { CreepConfig } from "@/types/system";

type WarStatus = "staging" | "clearing" | "done" | "failed";
type WarSquad = "standard" | "t3Duo";
type WarRole = "meleeAttacker" | "healer";

interface WarTask {
  targetRoom: string;
  sourceRoom: string;
  status: WarStatus;
  reason: "npc_reservation" | "manual";
  routeRooms?: string[];
  squad?: WarSquad;
  boostTier?: "t3";
  boostLabs?: string[];
  boostStatus?: "preparing" | "ready" | "failed";
  failReason?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  statusSince?: number;
  lastHostileSeenAt?: number;
  clearSince?: number;
  completedAt?: number;
}

interface HostilePresenceSnapshot {
  present: boolean;
  hostileCreeps: number;
  hostileStructures: number;
  hostileReservation: boolean;
}

export interface StopWarOptions {
  suicide?: boolean;
}

export interface StopWarResult {
  ok: true;
  targetRoom: string;
  removedTask: boolean;
  removedConfigs: number;
  removedQueuedTasks: number;
  cancelledSpawns: number;
  suicidedCreeps: number;
  releasedBoosts: boolean;
}

export interface WarStatusCreepSnapshot {
  name: string;
  role?: string;
  configName?: string;
  roomName: string;
  x: number;
  y: number;
  hits: number;
  hitsMax: number;
  boostedParts: number;
  spawning: boolean;
}

export interface WarStatusTaskSnapshot {
  targetRoom: string;
  sourceRoom: string;
  status: WarStatus;
  reason: "npc_reservation" | "manual";
  squad?: WarSquad;
  boostTier?: "t3";
  boostStatus?: "preparing" | "ready" | "failed";
  attempts: number;
  age: number;
  statusAge: number;
  clearTicks: number;
  targetVisible: boolean;
  hostileCreeps: number;
  hostileStructures: number;
  hostileReservation: boolean;
  sourceEnergyAvailable?: number;
  sourceEnergyCapacity?: number;
  creeps: WarStatusCreepSnapshot[];
  queuedConfigs: string[];
}

export interface WarStatusSnapshot {
  ok: true;
  tick: number;
  tasks: WarStatusTaskSnapshot[];
}

const MELEE_COUNT = 2;
const HEALER_COUNT = 1;
const T3_DUO_MELEE_COUNT = 1;
const T3_DUO_HEALER_COUNT = 1;
const MAX_STAGING_TICKS = 2500;
const WAR_CLEAR_DEBOUNCE_TICKS = 20;

const WAR_T3_TOUGH = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
const WAR_T3_ATTACK = RESOURCE_CATALYZED_UTRIUM_ACID;
const WAR_T3_HEAL = RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE;
const WAR_T3_MOVE = RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE;

const T3_ATTACKER_BODY: BodyPartConstant[] = [
  TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
  ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
  ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
  ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
  MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
];

const T3_HEALER_BODY: BodyPartConstant[] = [
  TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
  HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL,
  HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL,
  MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
];

const T3_ATTACKER_BOOSTS: ResourceConstant[] = [WAR_T3_MOVE, WAR_T3_TOUGH, WAR_T3_ATTACK];
const T3_HEALER_BOOSTS: ResourceConstant[] = [WAR_T3_MOVE, WAR_T3_TOUGH, WAR_T3_HEAL];
const T3_DUO_BOOST_AMOUNTS = new Map<ResourceConstant, number>([
  [WAR_T3_TOUGH, 20 * LAB_BOOST_MINERAL],
  [WAR_T3_ATTACK, 30 * LAB_BOOST_MINERAL],
  [WAR_T3_HEAL, 20 * LAB_BOOST_MINERAL],
  [WAR_T3_MOVE, 18 * LAB_BOOST_MINERAL],
]);

function ensureWarStore(): Record<string, WarTask> {
  const data = getMemoryService().ensureData();
  if (!data.war) {
    data.war = {};
  }

  return data.war;
}

function ensureConfigStore(): Record<string, CreepConfig> {
  return getMemoryService().getCreepConfigStore();
}

function getSpawnsForRoom(roomName: string): StructureSpawn[] {
  return getTickContextService().getSpawnsByRoom(roomName);
}

function isConfigQueuedInSpawns(spawns: StructureSpawn[], configName: string): boolean {
  return spawns.some((spawn) => spawn.memory.spawnList?.includes(configName) ?? false);
}

function getSpawnQueueLoad(spawn: StructureSpawn): number {
  return (spawn.spawning ? 1 : 0) + (spawn.memory.spawnList?.length ?? 0);
}

function selectLeastLoadedSpawn(spawns: StructureSpawn[]): StructureSpawn | undefined {
  if (spawns.length === 0) return undefined;

  return [...spawns].sort((left, right) => {
    const loadDiff = getSpawnQueueLoad(left) - getSpawnQueueLoad(right);
    if (loadDiff !== 0) return loadDiff;
    return left.name.localeCompare(right.name);
  })[0];
}

function getConfigName(task: WarTask, role: WarRole, index: number): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:${role}:${index}`;
}

function isT3DuoTask(task: WarTask): boolean {
  return task.squad === "t3Duo" || task.boostTier === "t3";
}

function getMeleeCount(task: WarTask): number {
  return isT3DuoTask(task) ? T3_DUO_MELEE_COUNT : MELEE_COUNT;
}

function getHealerCount(task: WarTask): number {
  return isT3DuoTask(task) ? T3_DUO_HEALER_COUNT : HEALER_COUNT;
}

function getWarBoostTaskId(task: WarTask): string {
  return `war:${task.sourceRoom}:${task.targetRoom}`;
}

function encodeBoosts(compounds: ResourceConstant[]): string {
  return compounds.join("|");
}

function getRoleArgs(task: WarTask, role: WarRole, encodedRoute: string): string[] {
  if (!isT3DuoTask(task)) {
    return [task.targetRoom, encodedRoute];
  }

  return [
    task.targetRoom,
    encodedRoute,
    getWarBoostTaskId(task),
    encodeBoosts(role === "meleeAttacker" ? T3_ATTACKER_BOOSTS : T3_HEALER_BOOSTS),
  ];
}

function getRoleBody(task: WarTask, role: WarRole): BodyPartConstant[] | undefined {
  if (!isT3DuoTask(task)) return undefined;
  return role === "meleeAttacker" ? [...T3_ATTACKER_BODY] : [...T3_HEALER_BODY];
}

function getExpectedTaskConfigNames(task: WarTask): string[] {
  const names: string[] = [];
  for (let i = 0; i < getMeleeCount(task); i++) {
    names.push(getConfigName(task, "meleeAttacker", i));
  }
  for (let i = 0; i < getHealerCount(task); i++) {
    names.push(getConfigName(task, "healer", i));
  }
  return names;
}

function getTaskConfigNames(task: WarTask): string[] {
  const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
  const names = new Set<string>(getExpectedTaskConfigNames(task));
  for (const configName of Object.keys(getCreepConfigService().list(prefix))) {
    names.add(configName);
  }
  for (const creepMemory of Object.values(Memory.creeps || {})) {
    if (creepMemory.configName?.startsWith(prefix)) {
      names.add(creepMemory.configName);
    }
  }
  return [...names];
}

function getLiveCreepsByConfig(configName: string): Creep[] {
  return getTickContextService().getCreepsByConfigName(configName);
}

function isConfigSpawning(configName: string): boolean {
  const creepMemory = Memory.creeps || {};
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) {
        continue;
      }

      if (creepMemory[spawn.spawning.name]?.configName === configName) {
        return true;
      }
    }
  }

  return false;
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
  for (const spawn of getTickContextService().getSpawnsByRoom(task.sourceRoom)) {
    if (spawn.memory.spawnList) {
      spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
    }
  }
}

function removeQueuedConfigByName(configName: string): number {
  let removed = 0;
  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      const queue = spawn.memory.spawnList;
      if (!queue) {
        continue;
      }

      const next = queue.filter((name) => name !== configName);
      if (next.length !== queue.length) {
        spawn.memory.spawnList = next;
        removed += queue.length - next.length;
      }
    }
  }
  return removed;
}

function cancelSpawnIfSpawningConfig(configName: string): number {
  const creepMemory = Memory.creeps || {};
  let cancelled = 0;
  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) {
        continue;
      }

      const spawningName = spawn.spawning.name;
      if (creepMemory[spawningName]?.configName !== configName) {
        continue;
      }

      if (spawn.spawning.cancel() === OK) {
        cancelled += 1;
      }
    }
  }
  return cancelled;
}

function suicideCreepsByConfig(configName: string): number {
  let suicided = 0;
  for (const creep of getLiveCreepsByConfig(configName)) {
    if (creep.memory.configName !== configName) {
      continue;
    }

    if (creep.suicide() === OK) {
      suicided += 1;
    }
  }
  return suicided;
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

function removeConfig(configName: string): number {
  const store = ensureConfigStore();
  if (!store[configName]) {
    return 0;
  }

  delete store[configName];
  return 1;
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

function getHostilePresence(room: Room): HostilePresenceSnapshot {
  const hostileCreeps = room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) => creep.owner.username !== "Source Keeper",
  });

  const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) =>
      structure.structureType !== STRUCTURE_CONTROLLER && structure.structureType !== STRUCTURE_KEEPER_LAIR,
  });

  const hostileReservation = isHostileReservation(room);
  return {
    present: hostileCreeps.length > 0 || hostileStructures.length > 0 || hostileReservation,
    hostileCreeps: hostileCreeps.length,
    hostileStructures: hostileStructures.length,
    hostileReservation,
  };
}

function setTaskStatus(task: WarTask, status: WarStatus): void {
  if (task.status === status) {
    return;
  }

  task.status = status;
  task.statusSince = Game.time;
}

function ensureCombatConfigs(task: WarTask): void {
  const store = ensureConfigStore();
  const encodedRoute = task.routeRooms?.join("|") || "";

  for (let i = 0; i < getMeleeCount(task); i++) {
    const configName = getConfigName(task, "meleeAttacker", i);
    store[configName] = {
      role: "meleeAttacker",
      args: getRoleArgs(task, "meleeAttacker", encodedRoute),
      roomName: task.sourceRoom,
      body: getRoleBody(task, "meleeAttacker"),
    };
  }

  for (let i = 0; i < getHealerCount(task); i++) {
    const configName = getConfigName(task, "healer", i);
    store[configName] = {
      role: "healer",
      args: getRoleArgs(task, "healer", encodedRoute),
      roomName: task.sourceRoom,
      body: getRoleBody(task, "healer"),
    };
  }

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (spawns.length === 0) {
    return;
  }

  for (let i = 0; i < getMeleeCount(task); i++) {
    const configName = getConfigName(task, "meleeAttacker", i);
    const hasLive = getLiveCreepsByConfig(configName).length > 0;
    const queued = isConfigQueuedInSpawns(spawns, configName);
    const spawning = isConfigSpawning(configName);
    if (!hasLive && !queued && !spawning) {
      const targetSpawn = selectLeastLoadedSpawn(spawns);
      if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
    }
  }

  for (let i = 0; i < getHealerCount(task); i++) {
    const configName = getConfigName(task, "healer", i);
    const hasLive = getLiveCreepsByConfig(configName).length > 0;
    const queued = isConfigQueuedInSpawns(spawns, configName);
    const spawning = isConfigSpawning(configName);
    if (!hasLive && !queued && !spawning) {
      const targetSpawn = selectLeastLoadedSpawn(spawns);
      if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
    }
  }
}

function prepareT3DuoBoosts(task: WarTask): boolean {
  if (!isT3DuoTask(task)) return true;

  const result = prepareBoosts(getWarBoostTaskId(task), task.sourceRoom, 0, T3_DUO_BOOST_AMOUNTS);
  task.boostLabs = result.labs;
  task.boostStatus = result.status;
  task.failReason = result.reason;

  if (result.status === "failed") {
    setTaskStatus(task, "failed");
    releaseBoostLabs(getWarBoostTaskId(task), task.sourceRoom);
    clearTaskConfigs(task);
    return false;
  }

  return result.status === "ready";
}

function releaseWarBoosts(task: WarTask): void {
  if (!isT3DuoTask(task)) return;
  releaseBoostLabs(getWarBoostTaskId(task), task.sourceRoom);
  task.boostLabs = [];
}

function clearTaskConfigs(task: WarTask): void {
  const configNames = getTaskConfigNames(task);
  for (const configName of configNames) {
    removeQueuedConfig(task, configName);
    removeConfigWhenIdle(configName);
  }
}

function getQueuedConfigs(task: WarTask): string[] {
  const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
  const queued = new Set<string>();
  for (const spawn of getSpawnsForRoom(task.sourceRoom)) {
    for (const configName of spawn.memory.spawnList || []) {
      if (configName.startsWith(prefix)) {
        queued.add(configName);
      }
    }
  }
  return [...queued];
}

function getTaskCreeps(task: WarTask): WarStatusCreepSnapshot[] {
  const configNames = new Set(getTaskConfigNames(task));
  return Object.values(Game.creeps)
    .filter((creep) => creep.memory.configName && configNames.has(creep.memory.configName))
    .map((creep) => ({
      name: creep.name,
      role: creep.memory.role,
      configName: creep.memory.configName,
      roomName: creep.room.name,
      x: creep.pos.x,
      y: creep.pos.y,
      hits: creep.hits,
      hitsMax: creep.hitsMax,
      boostedParts: creep.body.filter((part) => !!part.boost).length,
      spawning: !!creep.spawning,
    }));
}

function buildTaskStatusSnapshot(task: WarTask): WarStatusTaskSnapshot {
  const room = Game.rooms[task.targetRoom];
  const hostile = room ? getHostilePresence(room) : undefined;
  const sourceRoom = Game.rooms[task.sourceRoom];
  return {
    targetRoom: task.targetRoom,
    sourceRoom: task.sourceRoom,
    status: task.status,
    reason: task.reason,
    squad: task.squad,
    boostTier: task.boostTier,
    boostStatus: task.boostStatus,
    attempts: task.attempts,
    age: Math.max(0, Game.time - task.createdAt),
    statusAge: Math.max(0, Game.time - (task.statusSince ?? task.createdAt)),
    clearTicks: task.clearSince === undefined ? 0 : Math.max(0, Game.time - task.clearSince + 1),
    targetVisible: !!room,
    hostileCreeps: hostile?.hostileCreeps ?? 0,
    hostileStructures: hostile?.hostileStructures ?? 0,
    hostileReservation: hostile?.hostileReservation ?? false,
    sourceEnergyAvailable: sourceRoom?.energyAvailable,
    sourceEnergyCapacity: sourceRoom?.energyCapacityAvailable,
    creeps: getTaskCreeps(task),
    queuedConfigs: getQueuedConfigs(task),
  };
}

function writeWarTelemetry(): void {
  const analytics = getMemoryService().ensureAnalytics();
  analytics.war = {
    updatedAt: Game.time,
    clearDebounceTicks: WAR_CLEAR_DEBOUNCE_TICKS,
    tasks: Object.fromEntries(
      Object.values(ensureWarStore()).map((task) => [task.targetRoom, buildTaskStatusSnapshot(task)]),
    ),
  };
}

function processTask(task: WarTask): void {
  const room = Game.rooms[task.targetRoom];
  task.statusSince ??= task.createdAt;
  const stagingTooLong = Game.time - task.createdAt > MAX_STAGING_TICKS;
  if (stagingTooLong && task.status !== "done") {
    setTaskStatus(task, "failed");
    clearTaskConfigs(task);
    releaseWarBoosts(task);
    return;
  }

  if (!room) {
    setTaskStatus(task, "staging");
    task.clearSince = undefined;
    if (!prepareT3DuoBoosts(task)) return;
    ensureCombatConfigs(task);
    return;
  }

  const hostile = getHostilePresence(room);
  if (!hostile.present) {
    task.clearSince ??= Game.time;
    if (Game.time - task.clearSince + 1 < WAR_CLEAR_DEBOUNCE_TICKS) {
      setTaskStatus(task, "clearing");
      if (!prepareT3DuoBoosts(task)) return;
      ensureCombatConfigs(task);
      return;
    }

    setTaskStatus(task, "done");
    task.completedAt = Game.time;
    clearTaskConfigs(task);
    releaseWarBoosts(task);
    return;
  }

  task.lastHostileSeenAt = Game.time;
  task.clearSince = undefined;
  setTaskStatus(task, "clearing");
  if (!prepareT3DuoBoosts(task)) return;
  ensureCombatConfigs(task);
}

export function requestWarRoomClear(
  targetRoom: string,
  sourceRoom: string,
  options?: { routeRooms?: string[]; reason?: "npc_reservation" | "manual"; squad?: WarSquad; boostTier?: "t3" },
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
    squad: options?.squad ?? existing?.squad,
    boostTier: options?.boostTier ?? existing?.boostTier,
    boostLabs: existing?.boostLabs,
    boostStatus: existing?.boostStatus,
    failReason: existing?.failReason,
    attempts: nextAttempts,
    createdAt: restart ? now : (existing?.createdAt ?? now),
    statusSince: restart ? now : (existing?.statusSince ?? now),
    lastHostileSeenAt: existing?.lastHostileSeenAt,
    clearSince: existing?.clearSince,
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

export function stopWarRoom(targetRoom: string, options: StopWarOptions = {}): StopWarResult | string {
  const store = ensureWarStore();
  const task = store[targetRoom];
  if (!task) {
    return `ERR_NO_WAR_TASK:${targetRoom}`;
  }

  const configNames = getTaskConfigNames(task);
  let removedConfigs = 0;
  let removedQueuedTasks = 0;
  let cancelledSpawns = 0;
  let suicidedCreeps = 0;

  for (const configName of configNames) {
    cancelledSpawns += cancelSpawnIfSpawningConfig(configName);
    removedQueuedTasks += removeQueuedConfigByName(configName);
    if (options.suicide) {
      suicidedCreeps += suicideCreepsByConfig(configName);
      removedConfigs += removeConfig(configName);
    } else {
      const hadConfig = !!ensureConfigStore()[configName];
      removeConfigWhenIdle(configName);
      if (hadConfig && !ensureConfigStore()[configName]) {
        removedConfigs += 1;
      }
    }
  }

  const releasedBoosts = isT3DuoTask(task);
  releaseWarBoosts(task);
  delete store[targetRoom];
  writeWarTelemetry();

  return {
    ok: true,
    targetRoom,
    removedTask: true,
    removedConfigs,
    removedQueuedTasks,
    cancelledSpawns,
    suicidedCreeps,
    releasedBoosts,
  };
}

export function getWarStatus(targetRoom?: string): WarStatusSnapshot {
  return {
    ok: true,
    tick: Game.time,
    tasks: Object.values(ensureWarStore())
      .filter((task) => !targetRoom || task.targetRoom === targetRoom)
      .map((task) => buildTaskStatusSnapshot(task)),
  };
}

export function runWarControl(): void {
  const store = ensureWarStore();
  for (const task of Object.values(store)) {
    processTask(task);
    task.updatedAt = Game.time;
  }
  writeWarTelemetry();
}
