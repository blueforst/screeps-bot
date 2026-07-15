import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import type { CreepConfig } from "@/types/system";

type WarStatus = "staging" | "clearing" | "downgrading" | "done" | "failed";
export type WarSquad = "standard" | "t3Duo";
export type WarBoostTier = "t3";
type WarRole = "meleeAttacker" | "healer";
type WarGenerationPhase = "preparing" | "assembling" | "deployed";

interface WarGenerationState {
  id: number;
  phase: WarGenerationPhase;
  createdAt: number;
  boostTaskId: string;
  boostGateOpenedAt?: number;
  deployedAt?: number;
  configNames: Record<WarRole, string>;
}

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
  oneShot?: boolean;
  failReason?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  statusSince?: number;
  lastHostileSeenAt?: number;
  clearSince?: number;
  completedAt?: number;
  generationCounter?: number;
  activeGeneration?: WarGenerationState;
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

export interface StartWarOptions {
  routeRooms?: string[];
  squad?: WarSquad;
  boostTier?: WarBoostTier;
  oneShot?: boolean;
}

export interface StartWarResult {
  ok: true;
  targetRoom: string;
  sourceRoom: string;
  status: WarStatus;
  reason: "manual";
  squad?: WarSquad;
  boostTier?: WarBoostTier;
  oneShot: boolean;
  attempts: number;
  createdAt: number;
  updatedAt: number;
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
  oneShot: boolean;
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
const WAR_CONTROLLER_ATTACK_CONFIG_SUFFIX = "controllerAttacker:0";
const WAR_CONTROLLER_ATTACK_BODY: BodyPartConstant[] = [
  ...Array(20).fill(CLAIM),
  ...Array(18).fill(MOVE),
];
const WAR_CONTROLLER_CORE_STRUCTURES = new Set<StructureConstant>([
  STRUCTURE_SPAWN,
  STRUCTURE_TOWER,
  STRUCTURE_STORAGE,
  STRUCTURE_TERMINAL,
  STRUCTURE_INVADER_CORE,
]);

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
const T3_BOOST_PARTS: Partial<Record<ResourceConstant, BodyPartConstant>> = {
  [WAR_T3_MOVE]: MOVE,
  [WAR_T3_TOUGH]: TOUGH,
  [WAR_T3_ATTACK]: ATTACK,
  [WAR_T3_HEAL]: HEAL,
};
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

function getGenerationConfigName(task: WarTask, generationId: number, role: WarRole): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:g${generationId}:${role}:0`;
}

function getGenerationBoostTaskId(task: WarTask, generationId: number): string {
  return `war:${task.sourceRoom}:${task.targetRoom}:g${generationId}`;
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

function getLegacyWarBoostTaskId(task: WarTask): string {
  return `war:${task.sourceRoom}:${task.targetRoom}`;
}

function encodeBoosts(compounds: ResourceConstant[]): string {
  return compounds.join("|");
}

function getRoleArgs(
  task: WarTask,
  role: WarRole,
  encodedRoute: string,
  boostTaskId = getLegacyWarBoostTaskId(task),
): string[] {
  if (!isT3DuoTask(task)) {
    return [task.targetRoom, encodedRoute];
  }

  return [
    task.targetRoom,
    encodedRoute,
    boostTaskId,
    encodeBoosts(role === "meleeAttacker" ? T3_ATTACKER_BOOSTS : T3_HEALER_BOOSTS),
  ];
}

function getRoleBody(task: WarTask, role: WarRole): BodyPartConstant[] | undefined {
  if (!isT3DuoTask(task)) return undefined;
  return role === "meleeAttacker" ? [...T3_ATTACKER_BODY] : [...T3_HEALER_BODY];
}

function getExpectedTaskConfigNames(task: WarTask): string[] {
  if (isT3DuoTask(task) && task.activeGeneration) {
    return Object.values(task.activeGeneration.configNames);
  }

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
  const config = ensureConfigStore()[configName];
  if (toFront) {
    spawn.memory.spawnList = [configName, ...queue.filter((name) => name !== configName)];
    if (config?.spawnOnce && config.spawnOnce.queuedAt === undefined) {
      config.spawnOnce.queuedAt = Game.time;
    }
    return;
  }

  if (!queue.includes(configName)) {
    spawn.addTask(configName);
    if (config?.spawnOnce && config.spawnOnce.queuedAt === undefined) {
      config.spawnOnce.queuedAt = Game.time;
    }
  }
}

function shouldQueueWarConfig(config: CreepConfig | undefined): boolean {
  return config?.spawnOnce?.queuedAt === undefined;
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

function createGeneration(task: WarTask, id: number): WarGenerationState {
  return {
    id,
    phase: "preparing",
    createdAt: Game.time,
    boostTaskId: getGenerationBoostTaskId(task, id),
    configNames: {
      meleeAttacker: getGenerationConfigName(task, id, "meleeAttacker"),
      healer: getGenerationConfigName(task, id, "healer"),
    },
  };
}

function hasConfigActivity(task: WarTask, configName: string): boolean {
  const spawns = getSpawnsForRoom(task.sourceRoom);
  return getLiveCreepsByConfig(configName).length > 0
    || isConfigQueuedInSpawns(spawns, configName)
    || isConfigSpawning(configName);
}

function ensureActiveGeneration(task: WarTask): WarGenerationState {
  if (task.activeGeneration) return task.activeGeneration;

  const legacyConfigNames = {
    meleeAttacker: getConfigName(task, "meleeAttacker", 0),
    healer: getConfigName(task, "healer", 0),
  };
  const hasLegacyActivity = Object.values(legacyConfigNames).some((configName) =>
    hasConfigActivity(task, configName)
  );

  if (hasLegacyActivity) {
    const liveLegacyCreeps = Object.values(legacyConfigNames).flatMap((configName) =>
      getLiveCreepsByConfig(configName)
    );
    const deployed = liveLegacyCreeps.some((creep) => creep.room.name !== task.sourceRoom);
    task.generationCounter = Math.max(task.generationCounter ?? 0, 0);
    task.activeGeneration = {
      id: 0,
      phase: deployed ? "deployed" : "assembling",
      createdAt: Game.time,
      boostTaskId: getLegacyWarBoostTaskId(task),
      boostGateOpenedAt: Game.time,
      deployedAt: deployed ? Game.time : undefined,
      configNames: legacyConfigNames,
    };
    return task.activeGeneration;
  }

  for (const configName of Object.values(legacyConfigNames)) {
    removeConfigWhenIdle(configName);
  }
  const nextId = Math.max(task.generationCounter ?? 0, 0) + 1;
  task.generationCounter = nextId;
  task.activeGeneration = createGeneration(task, nextId);
  return task.activeGeneration;
}

function getCombatConfigName(task: WarTask, role: WarRole, index: number): string {
  if (isT3DuoTask(task)) {
    return ensureActiveGeneration(task).configNames[role];
  }
  return getConfigName(task, role, index);
}

function getControllerAttackConfigName(task: WarTask): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:${WAR_CONTROLLER_ATTACK_CONFIG_SUFFIX}`;
}

function isDangerousHostileCreep(creep: Creep): boolean {
  if (typeof creep.getActiveBodyparts !== "function") return true;
  return creep.getActiveBodyparts(ATTACK) > 0
    || creep.getActiveBodyparts(RANGED_ATTACK) > 0
    || creep.getActiveBodyparts(HEAL) > 0;
}

function hasControllerAttackBlockers(room: Room): boolean {
  const dangerousHostiles = room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) =>
      creep.owner.username !== "Source Keeper" && isDangerousHostileCreep(creep),
  });
  if (dangerousHostiles.length > 0) return true;

  return room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) => WAR_CONTROLLER_CORE_STRUCTURES.has(structure.structureType),
  }).length > 0;
}

function isControllerDowngradeReady(room: Room): boolean {
  const controller = room.controller;
  if (!controller?.owner || controller.my || controller.level <= 0) return false;
  return !hasControllerAttackBlockers(room);
}

function isControllerDefeated(room: Room): boolean {
  const controller = room.controller;
  return !!controller && (controller.my || !controller.owner || controller.level <= 0);
}

function ensureControllerAttackConfig(task: WarTask): void {
  const configName = getControllerAttackConfigName(task);
  const encodedRoute = task.routeRooms?.join("|") || "";
  ensureConfigStore()[configName] = {
    role: "claimer",
    args: [task.targetRoom, encodedRoute, "attack"],
    roomName: task.sourceRoom,
    body: [...WAR_CONTROLLER_ATTACK_BODY],
  };

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (
    spawns.length === 0
    || getLiveCreepsByConfig(configName).length > 0
    || isConfigQueuedInSpawns(spawns, configName)
    || isConfigSpawning(configName)
  ) {
    return;
  }

  const spawn = selectLeastLoadedSpawn(spawns);
  if (spawn) enqueueConfig(spawn, configName, true);
}

function clearControllerAttackConfig(task: WarTask): void {
  const configName = getControllerAttackConfigName(task);
  removeQueuedConfig(task, configName);
  removeConfig(configName);
}

function ensureCombatConfigs(task: WarTask): void {
  const store = ensureConfigStore();
  const encodedRoute = task.routeRooms?.join("|") || "";
  const generation = isT3DuoTask(task) ? ensureActiveGeneration(task) : undefined;
  if (generation?.phase === "deployed") return;

  for (let i = 0; i < getMeleeCount(task); i++) {
    const configName = getCombatConfigName(task, "meleeAttacker", i);
    const existing = store[configName];
    store[configName] = {
      role: "meleeAttacker",
      args: getRoleArgs(task, "meleeAttacker", encodedRoute, generation?.boostTaskId),
      roomName: task.sourceRoom,
      body: getRoleBody(task, "meleeAttacker"),
      spawnOnce: task.oneShot ? (existing?.spawnOnce ?? {}) : undefined,
    };
  }

  for (let i = 0; i < getHealerCount(task); i++) {
    const configName = getCombatConfigName(task, "healer", i);
    const existing = store[configName];
    store[configName] = {
      role: "healer",
      args: getRoleArgs(task, "healer", encodedRoute, generation?.boostTaskId),
      roomName: task.sourceRoom,
      body: getRoleBody(task, "healer"),
      spawnOnce: task.oneShot ? (existing?.spawnOnce ?? {}) : undefined,
    };
  }

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (spawns.length === 0) {
    return;
  }

  for (let i = 0; i < getMeleeCount(task); i++) {
    const configName = getCombatConfigName(task, "meleeAttacker", i);
    const hasLive = getLiveCreepsByConfig(configName).length > 0;
    const queued = isConfigQueuedInSpawns(spawns, configName);
    const spawning = isConfigSpawning(configName);
    if (!hasLive && !queued && !spawning && shouldQueueWarConfig(store[configName])) {
      const targetSpawn = selectLeastLoadedSpawn(spawns);
      if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
    }
  }

  for (let i = 0; i < getHealerCount(task); i++) {
    const configName = getCombatConfigName(task, "healer", i);
    const hasLive = getLiveCreepsByConfig(configName).length > 0;
    const queued = isConfigQueuedInSpawns(spawns, configName);
    const spawning = isConfigSpawning(configName);
    if (!hasLive && !queued && !spawning && shouldQueueWarConfig(store[configName])) {
      const targetSpawn = selectLeastLoadedSpawn(spawns);
      if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
    }
  }
}

function getGenerationCreeps(generation: WarGenerationState): Creep[] {
  return Object.values(generation.configNames).flatMap((configName) =>
    getLiveCreepsByConfig(configName)
  );
}

function cleanupGenerationConfigs(task: WarTask, generation: WarGenerationState): void {
  for (const configName of Object.values(generation.configNames)) {
    removeQueuedConfig(task, configName);
    removeConfig(configName);
  }
}

function reconcileGenerationLifecycle(task: WarTask): boolean {
  if (!isT3DuoTask(task)) return false;

  const generation = ensureActiveGeneration(task);
  const generationCreeps = getGenerationCreeps(generation);

  if (
    generation.phase === "assembling"
    && generationCreeps.some((creep) => creep.room.name !== task.sourceRoom)
  ) {
    generation.phase = "deployed";
    generation.deployedAt = Game.time;
    releaseBoostLabs(generation.boostTaskId, task.sourceRoom);
    task.boostLabs = [];
    cleanupGenerationConfigs(task, generation);
  }

  if (generation.phase !== "deployed" || generationCreeps.length >= 2) {
    return false;
  }

  for (const survivor of generationCreeps) {
    survivor.memory._warDetached = true;
  }
  cleanupGenerationConfigs(task, generation);

  if (task.oneShot) {
    return true;
  }

  const nextId = Math.max(task.generationCounter ?? generation.id, generation.id) + 1;
  task.generationCounter = nextId;
  task.activeGeneration = createGeneration(task, nextId);
  task.boostStatus = "preparing";
  task.failReason = undefined;
  return true;
}

function getGenerationRemainingBoostAmounts(
  task: WarTask,
  generation: WarGenerationState,
): Map<ResourceConstant, number> {
  const amounts = new Map<ResourceConstant, number>();
  const spawns = getSpawnsForRoom(task.sourceRoom);

  for (const role of ["meleeAttacker", "healer"] as const) {
    const configName = generation.configNames[role];
    const creep = getLiveCreepsByConfig(configName)[0];
    if (!creep && task.oneShot) {
      const config = ensureConfigStore()[configName];
      const active = isConfigQueuedInSpawns(spawns, configName) || isConfigSpawning(configName);
      if (!active && config?.spawnOnce?.queuedAt !== undefined) {
        continue;
      }
    }

    const body = creep?.body ?? (getRoleBody(task, role) ?? []).map((type) => ({
      type,
      hits: 100,
    } as BodyPartDefinition));
    const compounds = role === "meleeAttacker" ? T3_ATTACKER_BOOSTS : T3_HEALER_BOOSTS;
    for (const compound of compounds) {
      const partType = T3_BOOST_PARTS[compound];
      if (!partType) continue;
      const partCount = body.filter((part) =>
        part.type === partType && part.hits > 0 && part.boost !== compound
      ).length;
      if (partCount <= 0) continue;
      amounts.set(compound, (amounts.get(compound) ?? 0) + partCount * LAB_BOOST_MINERAL);
    }
  }

  return amounts;
}

function prepareT3DuoBoosts(task: WarTask): boolean {
  if (!isT3DuoTask(task)) return true;

  const generation = ensureActiveGeneration(task);
  if (generation.phase === "deployed") return true;
  if (generation.boostGateOpenedAt !== undefined) {
    const remainingAmounts = getGenerationRemainingBoostAmounts(task, generation);
    const result = prepareBoosts(
      generation.boostTaskId,
      task.sourceRoom,
      0,
      remainingAmounts,
      { requireLabEnergy: true },
    );
    task.boostLabs = result.labs;
    task.boostStatus = result.status;
    task.failReason = result.reason;
    return true;
  }

  const result = prepareBoosts(
    generation.boostTaskId,
    task.sourceRoom,
    0,
    T3_DUO_BOOST_AMOUNTS,
    { requireLabEnergy: true },
  );
  task.boostLabs = result.labs;
  task.boostStatus = result.status;
  task.failReason = result.reason;

  if (result.status === "failed") {
    setTaskStatus(task, "failed");
    releaseBoostLabs(generation.boostTaskId, task.sourceRoom);
    clearTaskConfigs(task);
    return false;
  }

  if (result.status === "preparing") {
    return false;
  }

  generation.boostGateOpenedAt = Game.time;
  generation.phase = "assembling";
  return true;
}

function releaseWarBoosts(task: WarTask): void {
  if (!isT3DuoTask(task)) return;
  releaseBoostLabs(
    task.activeGeneration?.boostTaskId ?? getLegacyWarBoostTaskId(task),
    task.sourceRoom,
  );
  task.boostLabs = [];
}

function clearTaskConfigs(task: WarTask): void {
  const configNames = getTaskConfigNames(task);
  for (const configName of configNames) {
    removeQueuedConfig(task, configName);
    removeConfigWhenIdle(configName);
  }
}

function disableTaskProduction(task: WarTask): void {
  for (const configName of getTaskConfigNames(task)) {
    removeQueuedConfig(task, configName);
    removeConfig(configName);
  }
}

function processControllerVictory(task: WarTask): void {
  task.clearSince ??= Game.time;
  setTaskStatus(task, "clearing");
  disableTaskProduction(task);
  releaseWarBoosts(task);

  if (Game.time - task.clearSince + 1 < WAR_CLEAR_DEBOUNCE_TICKS) {
    return;
  }

  setTaskStatus(task, "done");
  task.completedAt = Game.time;
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
    oneShot: task.oneShot === true,
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
  const stagingTooLong =
    task.status === "staging" && Game.time - task.statusSince > MAX_STAGING_TICKS;
  if (stagingTooLong) {
    setTaskStatus(task, "failed");
    clearTaskConfigs(task);
    releaseWarBoosts(task);
    return;
  }

  if (
    room
    && task.reason === "manual"
    && isControllerDefeated(room)
    && !hasControllerAttackBlockers(room)
  ) {
    processControllerVictory(task);
    return;
  }

  if (reconcileGenerationLifecycle(task)) {
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
  if (task.reason === "manual" && isControllerDowngradeReady(room)) {
    task.clearSince = undefined;
    const combatReady = prepareT3DuoBoosts(task);
    if (combatReady) ensureCombatConfigs(task);
    setTaskStatus(task, "downgrading");
    ensureControllerAttackConfig(task);
    return;
  }

  clearControllerAttackConfig(task);
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
  options?: { routeRooms?: string[]; reason?: "npc_reservation" | "manual"; squad?: WarSquad; boostTier?: WarBoostTier; oneShot?: boolean },
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
    oneShot: options?.oneShot ?? existing?.oneShot,
    failReason: existing?.failReason,
    attempts: nextAttempts,
    createdAt: restart ? now : (existing?.createdAt ?? now),
    statusSince: restart ? now : (existing?.statusSince ?? now),
    lastHostileSeenAt: existing?.lastHostileSeenAt,
    clearSince: existing?.clearSince,
    updatedAt: now,
    completedAt: existing?.completedAt,
    generationCounter: restart
      ? (existing?.sourceRoom === sourceRoom ? existing?.generationCounter : undefined)
      : existing?.generationCounter,
    activeGeneration: restart ? undefined : existing?.activeGeneration,
  };
}

export function startWarRoom(targetRoom: string, sourceRoom: string, options: StartWarOptions = {}): StartWarResult | string {
  if (!targetRoom || !sourceRoom) {
    return "ERR_INVALID_ARGS:startWar(targetRoom, sourceRoom)";
  }

  const squad = options.squad ?? "t3Duo";
  const boostTier = options.boostTier ?? (squad === "t3Duo" ? "t3" : undefined);
  const oneShot = options.oneShot ?? true;

  requestWarRoomClear(targetRoom, sourceRoom, {
    routeRooms: options.routeRooms,
    reason: "manual",
    squad,
    boostTier,
    oneShot,
  });

  const task = ensureWarStore()[targetRoom];
  return {
    ok: true,
    targetRoom: task.targetRoom,
    sourceRoom: task.sourceRoom,
    status: task.status,
    reason: "manual",
    squad: task.squad,
    boostTier: task.boostTier,
    oneShot: task.oneShot === true,
    attempts: task.attempts,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
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
      removedConfigs += removeConfig(configName);
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
