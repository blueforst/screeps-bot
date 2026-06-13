import { POWER_BANK_STATUS, POWER_BANK_BODY_TIERS, POWER_BANK_BOOST_REQUIREMENTS, POWER_BANK_PATROL_ROOMS, getPowerBankConfigName, isPowerBankPatrolRoom } from "@/runtime/powerBankConstants";
import { ATTACK_POWER, POWER_BANK_ROOM_TRAVEL_TICKS, selectBodyTier, assessViability } from "@/runtime/powerBankViability";
import { prepareBoosts, releaseBoostLabs, type BoostPrepResult } from "@/runtime/powerBankBoost";
import { getAssignedPowerBankBoostLabId, getPowerBankBoostPrep } from "@/runtime/powerBankBoostMemory";
import { cleanupStaleDiscoveries, ensureDiscoveryStore } from "@/runtime/powerBankDiscovery";
import { hasPowerBankObserverCoverage } from "@/runtime/powerBankObserver";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { moveToTarget } from "@/roles/shared";
import type { CreepConfig } from "@/types/system";

const PATROL_SCOUT_CONFIG_NAME = "powerbank:patrol:scout:0";

const TERMINAL_STATE_CLEANUP_DELAY = 100;
const MAX_POWER_BANK_HAULER_PAIRS = 25;
const POWER_BANK_HAULER_ARRIVAL_BUFFER = 200;
const HAULING_EMPTY_CONFIRM_TICKS = 100;
const REINFORCEMENT_INDEX = 1;
const REINFORCEMENT_TTL_BUFFER = 75;
const BOOST_FINISHED_STATUSES = new Set<string>([
  POWER_BANK_STATUS.TRAVELLING,
  POWER_BANK_STATUS.ATTACKING,
  POWER_BANK_STATUS.HAULING,
]);

type PowerBankCreepMemory = CreepMemory & { taskId?: string };
type PowerBankReinforcementCreepMemory = PowerBankCreepMemory & { powerBankReinforcementStage?: PowerBankReinforcementStage };
type PowerBankTravelMemory = PowerBankCreepMemory & { powerBankTravelTaskId?: string };

const POWER_BANK_BOOST_PARTS: Partial<Record<ResourceConstant, BodyPartConstant>> = {
  [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: TOUGH,
  [RESOURCE_CATALYZED_UTRIUM_ACID]: ATTACK,
  [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: HEAL,
};

function tierKindToNumber(tierKind: string): number {
  if (tierKind === "rcl8") return 8;
  if (tierKind === "rcl7") return 7;
  return 6;
}

function getTaskStore(): Record<string, PowerBankHarvestTask> {
  return ensureDiscoveryStore();
}

function getConfigStore(): Record<string, CreepConfig> {
  return getMemoryService().getCreepConfigStore();
}

function getTaskConfigNames(task: PowerBankHarvestTask): string[] {
  const prefix = `${task.sourceRoom}:powerbank:${task.targetRoom}:`;
  const all = getCreepConfigService().list(prefix);
  return Object.keys(all);
}

function getCombatConfigName(task: PowerBankHarvestTask, role: "attacker" | "healer", index: number): string {
  return getPowerBankConfigName(task.sourceRoom, task.targetRoom, role, index);
}

function ensureCombatConfigs(task: PowerBankHarvestTask, index: number): boolean {
  if (!task.tier) return false;

  const tierBodies = POWER_BANK_BODY_TIERS[task.tier];
  if (!tierBodies) return false;

  const configStore = getConfigStore();
  const encodedRoute = "";

  configStore[getCombatConfigName(task, "attacker", index)] = {
    role: "powerBankAttacker",
    args: [task.targetRoom, encodedRoute],
    roomName: task.sourceRoom,
    body: tierBodies.attacker,
  };

  configStore[getCombatConfigName(task, "healer", index)] = {
    role: "powerBankHealer",
    args: [task.targetRoom, encodedRoute],
    roomName: task.sourceRoom,
    body: tierBodies.healer,
  };

  return true;
}

function getCombatCreep(task: PowerBankHarvestTask, role: "attacker" | "healer", index: number): Creep | undefined {
  return getAssignableCreepByConfigName(getCombatConfigName(task, role, index), task.id);
}

function setReinforcementStage(creep: Creep | undefined, stage?: PowerBankReinforcementStage): void {
  if (!creep) return;
  const mem = creep.memory as PowerBankReinforcementCreepMemory;
  if (stage) {
    mem.powerBankReinforcementStage = stage;
  } else {
    delete mem.powerBankReinforcementStage;
  }
}

function ensureCombatTaskIds(task: PowerBankHarvestTask, index: number, stage?: PowerBankReinforcementStage): void {
  for (const role of ["attacker", "healer"] as const) {
    for (const creep of getTickContextService().getCreepsByConfigName(getCombatConfigName(task, role, index))) {
      const mem = creep.memory as PowerBankReinforcementCreepMemory;
      if (mem.taskId === undefined || mem.taskId === task.id) {
        mem.taskId = task.id;
        if (stage) mem.powerBankReinforcementStage = stage;
      }
    }
  }
}

function removeSpawnQueueEntries(task: PowerBankHarvestTask): void {
  const prefix = `${task.sourceRoom}:powerbank:${task.targetRoom}:`;
  for (const spawn of getTickContextService().getSpawnsByRoom(task.sourceRoom)) {
    if (!spawn.memory.spawnList) continue;
    spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => !name.startsWith(prefix));
  }
}

function removeSpawnQueueEntry(configName: string): void {
  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      if (!spawn.memory.spawnList) continue;
      spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
    }
  }
}

function removeConfigWhenIdle(configName: string): void {
  const liveCreeps = getTickContextService().getCreepsByConfigName(configName);
  if (liveCreeps.length > 0) return;

  const creepMemory = Memory.creeps || {};
  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) continue;
      if (creepMemory[spawn.spawning.name]?.configName === configName) return;
    }
  }

  const store = getConfigStore();
  delete store[configName];
}

function cleanupCombatConfig(task: PowerBankHarvestTask, role: "attacker" | "healer", index: number): void {
  const configName = getCombatConfigName(task, role, index);
  removeSpawnQueueEntry(configName);
  removeConfigWhenIdle(configName);
}

function cleanupReinforcement(task: PowerBankHarvestTask): void {
  const index = task.reinforcement?.index ?? REINFORCEMENT_INDEX;
  cleanupCombatConfig(task, "attacker", index);
  cleanupCombatConfig(task, "healer", index);
  delete task.reinforcement;
}

function cleanupPrimaryCombat(task: PowerBankHarvestTask): void {
  cleanupCombatConfig(task, "attacker", 0);
  cleanupCombatConfig(task, "healer", 0);
}

function cleanupAllCombatConfigs(task: PowerBankHarvestTask): void {
  for (const configName of getTaskConfigNames(task)) {
    const parts = configName.split(":");
    const role = parts[3];
    if (role !== "attacker" && role !== "healer") continue;

    removeSpawnQueueEntry(configName);
    removeConfigWhenIdle(configName);
  }
}

function cleanupInactiveCombatConfigs(task: PowerBankHarvestTask): void {
  const activeConfigNames = new Set<string>();
  const attacker = task.attackerId ? Game.getObjectById(task.attackerId as Id<Creep>) : null;
  const healer = task.healerId ? Game.getObjectById(task.healerId as Id<Creep>) : null;

  if (attacker?.memory.configName) activeConfigNames.add(attacker.memory.configName);
  if (healer?.memory.configName) activeConfigNames.add(healer.memory.configName);

  for (const configName of getTaskConfigNames(task)) {
    if (activeConfigNames.has(configName)) continue;

    const parts = configName.split(":");
    const role = parts[3];
    if (role !== "attacker" && role !== "healer") continue;

    removeSpawnQueueEntry(configName);
    removeConfigWhenIdle(configName);
  }
}

function cleanupOrphanPowerBankConfigs(tasks: PowerBankHarvestTask[]): void {
  const activePrefixes = new Set(
    tasks
      .filter((task) =>
        task.status !== POWER_BANK_STATUS.FAILED &&
        task.status !== POWER_BANK_STATUS.ABORTED &&
        task.status !== POWER_BANK_STATUS.COMPLETE,
      )
      .map((task) => `${task.sourceRoom}:powerbank:${task.targetRoom}:`),
  );

  const configs = getCreepConfigService().list();
  for (const configName of Object.keys(configs)) {
    const parts = configName.split(":");
    if (parts[1] !== "powerbank") continue;
    if (configName === PATROL_SCOUT_CONFIG_NAME) continue;

    const prefix = `${parts[0]}:powerbank:${parts[2]}:`;
    if (activePrefixes.has(prefix)) continue;

    removeSpawnQueueEntry(configName);
    removeConfigWhenIdle(configName);
  }
}

function cleanupTaskConfigs(task: PowerBankHarvestTask): void {
  const configNames = getTaskConfigNames(task);
  removeSpawnQueueEntries(task);
  for (const configName of configNames) {
    removeConfigWhenIdle(configName);
  }
}

function neutralizeTaskCreeps(task: PowerBankHarvestTask): void {
  const seen = new Set<string>();
  const creepIds = [task.attackerId, task.healerId].filter(Boolean);
  for (const creepId of creepIds) {
    const creep = Game.getObjectById(creepId as Id<Creep>);
    if (!creep) continue;
    seen.add(creep.name);
    const mem = creep.memory as PowerBankReinforcementCreepMemory;
    delete mem.taskId;
    delete mem.powerBankReinforcementStage;
    creep.memory.working = false;
  }

  for (const configName of getTaskConfigNames(task)) {
    for (const creep of getTickContextService().getCreepsByConfigName(configName)) {
      if (seen.has(creep.name)) continue;
      const mem = creep.memory as PowerBankReinforcementCreepMemory;
      delete mem.taskId;
      delete mem.powerBankReinforcementStage;
      creep.memory.working = false;
    }
  }
}

function transitionToTerminal(task: PowerBankHarvestTask, status: "failed" | "aborted" | "complete", reason?: string): void {
  task.status = status;
  task.failReason = reason;
  task.terminalTick = Game.time;
}

function getRouteDistance(fromRoom: string, toRoom: string): number {
  const route = Game.map.findRoute(fromRoom, toRoom);
  if (route === ERR_NO_PATH) return Infinity;
  return route.length;
}

function findNearestEligibleRoom(targetRoom: string): { roomName: string; energyCapacity: number; distance: number; spawnCount: number } | null {
  let best: { roomName: string; energyCapacity: number; distance: number; spawnCount: number } | null = null;
  const tickContext = getTickContextService();

  for (const room of tickContext.getMyRooms()) {
    if (!room.controller || room.controller.level < 6) continue;

    const spawns = tickContext.getSpawnsByRoom(room.name);
    if (spawns.length === 0) continue;

    if (isDefenseMode(room.name)) continue;

    const energyCapacity = room.energyCapacityAvailable;
    const distance = getRouteDistance(room.name, targetRoom);
    const spawnCount = spawns.filter((spawn) => typeof spawn.isActive !== "function" || spawn.isActive()).length;

    if (!best || distance < best.distance) {
      best = { roomName: room.name, energyCapacity, distance, spawnCount };
    }
  }

  return best;
}

function getLocalCompoundStock(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) total += room.storage.store.getUsedCapacity(resource);
  if (room.terminal) total += room.terminal.store.getUsedCapacity(resource);
  return total;
}

function getPowerBankHaulerCapacity(energyCapacity: number): number {
  const pairCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(MAX_POWER_BANK_HAULER_PAIRS, Math.floor(energyCapacity / pairCost)));
  return pairCount * CARRY_CAPACITY;
}

function getPowerBankHaulerSpawnTime(energyCapacity: number): number {
  const pairCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(MAX_POWER_BANK_HAULER_PAIRS, Math.floor(energyCapacity / pairCost)));
  return pairCount * 2 * CREEP_SPAWN_TIME;
}

function getActiveSpawnCount(roomName: string): number {
  const spawns = getTickContextService().getSpawnsByRoom(roomName)
    .filter((spawn) => typeof spawn.isActive !== "function" || spawn.isActive());
  return Math.max(1, spawns.length);
}

function estimateHaulerBatchSpawnTicks(task: PowerBankHarvestTask, energyCapacity: number): number {
  const haulerCount = getRequiredHaulerCount(task);
  const singleHaulerSpawnTime = getPowerBankHaulerSpawnTime(energyCapacity);
  const spawnCount = getActiveSpawnCount(task.sourceRoom);
  return Math.ceil((haulerCount * singleHaulerSpawnTime) / spawnCount);
}

function estimateOneWayRoomTravelTicks(task: PowerBankHarvestTask): number {
  const routeDistance = task.routeDistance ?? getRouteDistance(task.sourceRoom, task.targetRoom);
  if (!Number.isFinite(routeDistance)) {
    return Infinity;
  }
  return Math.ceil(routeDistance * POWER_BANK_ROOM_TRAVEL_TICKS);
}

function estimateRemainingAttackTicks(task: PowerBankHarvestTask, bank: StructurePowerBank): number {
  const tier = task.tier ?? 6;
  const tierBody = POWER_BANK_BODY_TIERS[tier] ?? POWER_BANK_BODY_TIERS[6];
  const attackParts = tierBody.attacker.filter((part) => part === ATTACK).length;
  const boostedDamage = attackParts * ATTACK_POWER * 4;
  if (boostedDamage <= 0) {
    return Infinity;
  }
  return Math.ceil(bank.hits / boostedDamage);
}

function shouldSpawnHaulers(task: PowerBankHarvestTask, bank: StructurePowerBank): boolean {
  const sourceRoom = Game.rooms[task.sourceRoom];
  const energyCapacity = sourceRoom?.energyCapacityAvailable ?? 0;
  const spawnTime = estimateHaulerBatchSpawnTicks(task, energyCapacity);
  const travelTime = estimateOneWayRoomTravelTicks(task);
  const remainingAttackTicks = estimateRemainingAttackTicks(task, bank);
  if (!Number.isFinite(travelTime) || !Number.isFinite(remainingAttackTicks)) {
    return false;
  }

  return remainingAttackTicks <= spawnTime + travelTime + POWER_BANK_HAULER_ARRIVAL_BUFFER;
}

function getRequiredHaulerCount(task: PowerBankHarvestTask): number {
  if (task.haulerCount !== undefined) return task.haulerCount;

  const room = Game.rooms[task.sourceRoom];
  const energyCapacity = room?.energyCapacityAvailable ?? 0;
  const haulerCapacity = getPowerBankHaulerCapacity(energyCapacity);
  return Math.max(1, Math.ceil(task.power / haulerCapacity));
}

function getTaskHaulers(task: PowerBankHarvestTask): Creep[] {
  const haulers: Creep[] = [];
  for (const configName of getTaskConfigNames(task)) {
    if (!configName.includes(":hauler:")) continue;
    haulers.push(...getTickContextService().getCreepsByConfigName(configName));
  }
  return haulers;
}

function ensureHaulerConfigs(task: PowerBankHarvestTask): void {
  if (!task.sourceRoom) return;

  const configStore = getConfigStore();
  const haulerCount = getRequiredHaulerCount(task);
  task.haulerCount = haulerCount;

  for (let index = 0; index < haulerCount; index += 1) {
    const configName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "hauler", index);
    configStore[configName] = {
      role: "powerBankHauler",
      args: [task.targetRoom, ""],
      roomName: task.sourceRoom,
    };

    for (const creep of getTickContextService().getCreepsByConfigName(configName)) {
      const mem = creep.memory as PowerBankCreepMemory;
      if (mem.taskId === undefined || mem.taskId === task.id) {
        mem.taskId = task.id;
      }
    }
  }
}

function getAssignableCreepByConfigName(configName: string, taskId: string): Creep | undefined {
  return getTickContextService().getCreepsByConfigName(configName).find((creep) => {
    const mem = creep.memory as PowerBankCreepMemory;
    return mem.taskId === undefined || mem.taskId === taskId;
  });
}

function processDiscovered(task: PowerBankHarvestTask): void {
  const nearest = findNearestEligibleRoom(task.targetRoom);
  if (!nearest) {
    transitionToTerminal(task, "failed", "no_eligible_source_room");
    return;
  }

  const room = Game.rooms[nearest.roomName];
  if (!room) {
    transitionToTerminal(task, "failed", "source_room_not_visible");
    return;
  }

  const tierResult = selectBodyTier(nearest.energyCapacity);
  if (!tierResult) {
    transitionToTerminal(task, "failed", "insufficient_energy_capacity");
    return;
  }

  const haulerCapacity = getPowerBankHaulerCapacity(nearest.energyCapacity);

  const viability = assessViability({
    energyCapacity: nearest.energyCapacity,
    bankHits: task.hits,
    bankPower: task.power,
    ticksToDecay: task.ticksToDecay,
    freeTiles: task.freeTiles,
    routeDistance: nearest.distance,
    currentTick: Game.time,
    hasCompounds: {
      xgho2: getLocalCompoundStock(room, RESOURCE_CATALYZED_GHODIUM_ALKALIDE) > 0,
      xuh2o: getLocalCompoundStock(room, RESOURCE_CATALYZED_UTRIUM_ACID) > 0,
      xlho2: getLocalCompoundStock(room, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE) > 0,
    },
    isDefenseMode: false,
    haulerCapacity,
    spawnCount: nearest.spawnCount,
  });

  if (!viability.viable) {
    transitionToTerminal(task, "failed", viability.reasons.join(","));
    return;
  }

  task.sourceRoom = nearest.roomName;
  task.tier = tierKindToNumber(tierResult.attackerTier);
  task.routeDistance = nearest.distance;
  task.haulerCount = viability.estimates.haulerCount;
  task.status = POWER_BANK_STATUS.PREPARING_BOOSTS;
}

function refreshPowerBankBoostPrep(
  task: PowerBankHarvestTask,
  requiredAmounts?: ReadonlyMap<ResourceConstant, number>,
): BoostPrepResult {
  if (!task.tier) return { status: "ready", labs: [] };
  const result = prepareBoosts(task.id, task.sourceRoom, task.tier, requiredAmounts);
  task.boostLabs = result.labs;
  return result;
}

function processPreparingBoosts(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  if (!task.tier) {
    transitionToTerminal(task, "failed", "missing_tier");
    return;
  }

  const result = prepareBoosts(task.id, task.sourceRoom, task.tier);
  task.boostLabs = result.labs;

  if (result.status === "ready" || (result.status === "preparing" && result.labs.length > 0)) {
    task.status = POWER_BANK_STATUS.SPAWNING;
  } else if (result.status === "failed") {
    transitionToTerminal(task, "failed", result.reason ?? "boost_prep_failed");
  }
}

function processSpawning(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  if (!task.tier) {
    transitionToTerminal(task, "failed", "missing_tier");
    return;
  }

  const boostResult = refreshPowerBankBoostPrep(task);
  if (boostResult.status === "failed") {
    transitionToTerminal(task, "failed", boostResult.reason ?? "boost_prep_failed_during_spawning");
    return;
  }

  if (!ensureCombatConfigs(task, 0)) {
    transitionToTerminal(task, "failed", "invalid_tier");
    return;
  }

  task.status = POWER_BANK_STATUS.RENEWING;
}

function getRequiredBoostsForRole(tier: number, role: "attacker" | "healer"): ResourceConstant[] {
  const requirements = POWER_BANK_BOOST_REQUIREMENTS[tier];
  if (!requirements) return [];
  return requirements[role];
}

function getBoostedPartType(compound: ResourceConstant): BodyPartConstant | undefined {
  return POWER_BANK_BOOST_PARTS[compound];
}

function countBodyPartsForBoost(body: BodyPartConstant[], compound: ResourceConstant): number {
  const partType = getBoostedPartType(compound);
  if (!partType) return 0;
  return body.filter((part) => part === partType).length;
}

function countRemainingBoostParts(creep: Creep, compound: ResourceConstant): number {
  const partType = getBoostedPartType(compound);
  if (!partType) return 0;
  return creep.body.filter((part) => part.type === partType && part.hits > 0 && part.boost !== compound).length;
}

function addRemainingBoostAmountsForRole(
  amounts: Map<ResourceConstant, number>,
  tier: number,
  role: "attacker" | "healer",
  creep: Creep | null,
): void {
  const requirements = getRequiredBoostsForRole(tier, role);
  const tierBodies = POWER_BANK_BODY_TIERS[tier];
  if (!tierBodies) return;

  for (const compound of requirements) {
    const partCount = creep
      ? countRemainingBoostParts(creep, compound)
      : countBodyPartsForBoost(tierBodies[role], compound);
    if (partCount <= 0) continue;
    amounts.set(compound, (amounts.get(compound) ?? 0) + partCount * LAB_BOOST_MINERAL);
  }
}

function getRemainingBoostAmounts(
  tier: number,
  attacker: Creep | null,
  healer: Creep | null,
): Map<ResourceConstant, number> {
  const amounts = new Map<ResourceConstant, number>();
  addRemainingBoostAmountsForRole(amounts, tier, "attacker", attacker);
  addRemainingBoostAmountsForRole(amounts, tier, "healer", healer);
  return amounts;
}

function isBoostSatisfied(creep: Creep, requiredCompounds: ResourceConstant[]): boolean {
  if (requiredCompounds.length === 0) return true;
  return requiredCompounds.every((compound) =>
    countRemainingBoostParts(creep, compound) === 0,
  );
}

function getNextMissingBoost(creep: Creep, requiredCompounds: ResourceConstant[]): ResourceConstant | undefined {
  return requiredCompounds.find((compound) =>
    countRemainingBoostParts(creep, compound) > 0,
  );
}

function applyNextBoost(
  creep: Creep,
  taskId: string,
  requiredCompounds: ResourceConstant[],
): "boosted" | "moving" | "waiting" | "no_lab" | "no_compound" {
  if (isBoostSatisfied(creep, requiredCompounds)) return "boosted";

  const nextCompound = getNextMissingBoost(creep, requiredCompounds);
  if (!nextCompound) return "boosted";

  const labId = getAssignedPowerBankBoostLabId(taskId, nextCompound);
  if (!labId) return "no_lab";

  const lab = Game.getObjectById(labId as Id<StructureLab>);
  if (!lab) return "no_lab";

  if ((lab.store.getUsedCapacity(nextCompound) ?? 0) < LAB_BOOST_MINERAL) return "no_compound";

  if (creep.pos.isNearTo(lab)) {
    lab.boostCreep(creep);
    return "boosted";
  } else {
    moveToTarget(creep, lab, 1, { reusePath: 3, maxRooms: 1 });
    return "moving";
  }
}

function processBoosting(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  const attackerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "attacker", 0);
  const healerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "healer", 0);

  const attacker = getAssignableCreepByConfigName(attackerConfigName, task.id);
  const healer = getAssignableCreepByConfigName(healerConfigName, task.id);

  const tier = task.tier ?? 8;
  const boostResult = refreshPowerBankBoostPrep(task, getRemainingBoostAmounts(tier, attacker ?? null, healer ?? null));
  if (boostResult.status === "failed") {
    transitionToTerminal(task, "failed", boostResult.reason ?? "boost_prep_failed_during_boosting");
    return;
  }
  if (!attacker && !healer) return;

  const attackerCompounds = getRequiredBoostsForRole(tier, "attacker");
  const healerCompounds = getRequiredBoostsForRole(tier, "healer");

  if (attacker) {
    applyNextBoost(attacker, task.id, attackerCompounds);
  }
  if (healer) {
    applyNextBoost(healer, task.id, healerCompounds);
  }

  const attackerReady = !!attacker && isBoostSatisfied(attacker, attackerCompounds);
  const healerReady = !!healer && isBoostSatisfied(healer, healerCompounds);

  task.attackerReady = attackerReady;
  task.healerReady = healerReady;

  if (attacker && healer && attackerReady && healerReady) {
    task.attackerId = attacker.id as string;
    task.healerId = healer.id as string;
    (attacker.memory as any).taskId = task.id;
    (healer.memory as any).taskId = task.id;
    releaseFinishedBoostLabs(task);
    task.status = POWER_BANK_STATUS.TRAVELLING;
  }
}

function releaseFinishedBoostLabs(task: PowerBankHarvestTask): void {
  if (!task.sourceRoom) return;
  if (task.boostLabs.length === 0 && !getPowerBankBoostPrep(task.id)) return;

  releaseBoostLabs(task.id, task.sourceRoom);
  task.boostLabs = [];
}

function isCreepBoosted(creep: Creep): boolean {
  return creep.body.some((part) => !!part.boost);
}

function processRenewing(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  const boostResult = refreshPowerBankBoostPrep(task);
  if (boostResult.status === "failed") {
    transitionToTerminal(task, "failed", boostResult.reason ?? "boost_prep_failed_during_renewing");
    return;
  }

  const attackerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "attacker", 0);
  const healerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "healer", 0);

  const attacker = getAssignableCreepByConfigName(attackerConfigName, task.id);
  const healer = getAssignableCreepByConfigName(healerConfigName, task.id);

  // Wait patiently if neither creep exists yet (may still be queued/spawning).
  if (!attacker && !healer) return;

  // Regression guard: creeps should not be boosted at this stage
  if ((attacker && isCreepBoosted(attacker)) || (healer && isCreepBoosted(healer))) {
    transitionToTerminal(task, "aborted", "invalid_lifecycle_already_boosted");
    return;
  }

  const distance = task.routeDistance ?? 5;
  const MIN_TTL = distance * 2 + 50;

  const spawn = getTickContextService().getPrimarySpawnByRoom(task.sourceRoom);
  if (!spawn) return;

  let needsRenew = false;

  if (attacker && (attacker.ticksToLive ?? 1500) < MIN_TTL) {
    spawn.renewCreep(attacker);
    task.attackerReady = false;
    needsRenew = true;
  } else if (attacker) {
    task.attackerReady = true;
  } else {
    task.attackerReady = false;
  }

  if (healer && (healer.ticksToLive ?? 1500) < MIN_TTL) {
    spawn.renewCreep(healer);
    task.healerReady = false;
    needsRenew = true;
  } else if (healer) {
    task.healerReady = true;
  } else {
    task.healerReady = false;
  }

  if (!needsRenew) {
    task.attackerReady = false;
    task.healerReady = false;
    task.status = POWER_BANK_STATUS.BOOSTING;
  }
}

function processTravelling(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  if (!task.attackerId || !task.healerId) {
    transitionToTerminal(task, "aborted", "missing_creep_ids");
    return;
  }

  const attacker = Game.getObjectById(task.attackerId as Id<Creep>);
  const healer = Game.getObjectById(task.healerId as Id<Creep>);

  if (!attacker || !healer) {
    transitionToTerminal(task, "aborted", "creep_died_in_transit");
    return;
  }

  clearBoostMovementState(attacker, task.id);
  clearBoostMovementState(healer, task.id);

  if (attacker.room.name === task.targetRoom && healer.room.name === task.targetRoom) {
    task.status = POWER_BANK_STATUS.ATTACKING;
  }
}

function clearBoostMovementState(creep: Creep, taskId: string): void {
  const memory = creep.memory as PowerBankTravelMemory;
  if (memory.powerBankTravelTaskId === taskId) return;

  delete memory._move;
  memory.powerBankTravelTaskId = taskId;
}

function processAttacking(task: PowerBankHarvestTask): void {
  if (!task.reinforcement) {
    cleanupInactiveCombatConfigs(task);
  }

  const bank = Game.getObjectById(task.bankId as Id<StructurePowerBank>);

  if (!bank) {
    if (!Game.rooms[task.targetRoom]) {
      return;
    }

    task.haulingStartedTick ??= Game.time;
    task.status = POWER_BANK_STATUS.HAULING;
    cleanupAllCombatConfigs(task);
    cleanupReinforcement(task);
    ensureHaulerConfigs(task);
    retireCombatCreeps(task);
    return;
  }

  const attacker = getActiveAttacker(task);
  if (!attacker) {
    cleanupReinforcement(task);
    transitionToTerminal(task, "aborted", "attacker_died");
    return;
  }

  maybeRequestReinforcement(task, attacker, bank);
  processReinforcement(task);
  if (!task.reinforcement) {
    cleanupInactiveCombatConfigs(task);
  }

  if (shouldSpawnHaulers(task, bank)) {
    ensureHaulerConfigs(task);
  }

}

function getActiveAttacker(task: PowerBankHarvestTask): Creep | null {
  if (task.attackerId) {
    const attacker = Game.getObjectById(task.attackerId as Id<Creep>);
    if (attacker) return attacker;
  }

  const reinforcement = task.reinforcement;
  if (!reinforcement?.attackerId) return null;

  const replacement = Game.getObjectById(reinforcement.attackerId as Id<Creep>);
  if (!replacement) return null;

  task.attackerId = reinforcement.attackerId;
  if (reinforcement.healerId) task.healerId = reinforcement.healerId;
  task.reinforcement = undefined;
  setReinforcementStage(replacement);
  cleanupPrimaryCombat(task);
  return replacement;
}

function maybeRequestReinforcement(task: PowerBankHarvestTask, attacker: Creep, bank: StructurePowerBank): void {
  if (task.reinforcement) return;
  if (attacker.ticksToLive === undefined) return;

  const remainingAttackTicks = estimateRemainingAttackTicks(task, bank);
  if (!Number.isFinite(remainingAttackTicks)) return;

  if (attacker.ticksToLive > remainingAttackTicks + REINFORCEMENT_TTL_BUFFER) return;

  task.reinforcement = {
    index: REINFORCEMENT_INDEX,
    stage: "spawning",
    attackerReady: false,
    healerReady: false,
  };
}

function processReinforcement(task: PowerBankHarvestTask): void {
  const reinforcement = task.reinforcement;
  if (!reinforcement) return;

  if (!ensureCombatConfigs(task, reinforcement.index)) {
    delete task.reinforcement;
    return;
  }

  ensureCombatTaskIds(task, reinforcement.index, reinforcement.stage);
  const attacker = getCombatCreep(task, "attacker", reinforcement.index);
  const healer = getCombatCreep(task, "healer", reinforcement.index);

  if (reinforcement.stage === "spawning") {
    if (attacker && healer) reinforcement.stage = "renewing";
    return;
  }

  if (reinforcement.stage === "renewing") {
    processReinforcementRenewing(task, reinforcement, attacker, healer);
    return;
  }

  if (reinforcement.stage === "boosting") {
    processReinforcementBoosting(task, reinforcement, attacker, healer);
    return;
  }

  if (reinforcement.stage === "travelling") {
    if (!attacker || !healer) return;
    setReinforcementStage(attacker);
    setReinforcementStage(healer);
    if (attacker.room.name === task.targetRoom && healer.room.name === task.targetRoom) {
      reinforcement.stage = "attacking";
    }
  }
}

function processReinforcementRenewing(
  task: PowerBankHarvestTask,
  reinforcement: PowerBankReinforcementState,
  attacker?: Creep,
  healer?: Creep,
): void {
  if (!attacker && !healer) return;

  const boostResult = refreshPowerBankBoostPrep(task);
  if (boostResult.status === "failed") return;

  const distance = task.routeDistance ?? 5;
  const minTtl = distance * 2 + 50;
  const spawn = getTickContextService().getPrimarySpawnByRoom(task.sourceRoom);
  if (!spawn) return;

  let needsRenew = false;
  if (attacker && (attacker.ticksToLive ?? 1500) < minTtl) {
    spawn.renewCreep(attacker);
    reinforcement.attackerReady = false;
    needsRenew = true;
  } else if (attacker) {
    reinforcement.attackerReady = true;
  }

  if (healer && (healer.ticksToLive ?? 1500) < minTtl) {
    spawn.renewCreep(healer);
    reinforcement.healerReady = false;
    needsRenew = true;
  } else if (healer) {
    reinforcement.healerReady = true;
  }

  if (!needsRenew && attacker && healer) {
    reinforcement.attackerReady = false;
    reinforcement.healerReady = false;
    reinforcement.stage = "boosting";
    setReinforcementStage(attacker, "boosting");
    setReinforcementStage(healer, "boosting");
  }
}

function processReinforcementBoosting(
  task: PowerBankHarvestTask,
  reinforcement: PowerBankReinforcementState,
  attacker?: Creep,
  healer?: Creep,
): void {
  if (!attacker && !healer) return;

  const tier = task.tier ?? 8;
  const boostResult = refreshPowerBankBoostPrep(task, getRemainingBoostAmounts(tier, attacker ?? null, healer ?? null));
  if (boostResult.status === "failed") return;

  const attackerCompounds = getRequiredBoostsForRole(tier, "attacker");
  const healerCompounds = getRequiredBoostsForRole(tier, "healer");

  if (attacker) applyNextBoost(attacker, task.id, attackerCompounds);
  if (healer) applyNextBoost(healer, task.id, healerCompounds);

  const attackerReady = !!attacker && isBoostSatisfied(attacker, attackerCompounds);
  const healerReady = !!healer && isBoostSatisfied(healer, healerCompounds);
  reinforcement.attackerReady = attackerReady;
  reinforcement.healerReady = healerReady;

  if (attacker && healer && attackerReady && healerReady) {
    reinforcement.attackerId = attacker.id as string;
    reinforcement.healerId = healer.id as string;
    setReinforcementStage(attacker);
    setReinforcementStage(healer);
    clearBoostMovementState(attacker, task.id);
    clearBoostMovementState(healer, task.id);
    releaseFinishedBoostLabs(task);
    reinforcement.stage = "travelling";
  }
}

function retireCombatCreeps(task: PowerBankHarvestTask): void {
  const attacker = task.attackerId ? Game.getObjectById(task.attackerId as Id<Creep>) : null;
  const healer = task.healerId ? Game.getObjectById(task.healerId as Id<Creep>) : null;

  attacker?.suicide();
  healer?.suicide();
}

function processHauling(task: PowerBankHarvestTask): void {
  task.haulingStartedTick ??= Game.time;
  cleanupAllCombatConfigs(task);

  const targetRoom = Game.rooms[task.targetRoom];
  if (!targetRoom) {
    ensureHaulerConfigs(task);
    return;
  }

  const droppedPower = targetRoom.find(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_POWER,
  });

  const totalDropped = droppedPower.reduce((sum, r) => sum + r.amount, 0);
  if (totalDropped > 0) {
    delete task.haulingEmptySince;
    ensureHaulerConfigs(task);
    return;
  }

  task.haulingEmptySince ??= Game.time;

  const carriedPower = getTaskHaulers(task).reduce(
    (sum, creep) => sum + creep.store.getUsedCapacity(RESOURCE_POWER),
    0,
  );

  const emptyConfirmed = Game.time - task.haulingEmptySince >= HAULING_EMPTY_CONFIRM_TICKS;
  if (carriedPower <= 0 && emptyConfirmed) {
    transitionToTerminal(task, "complete");
  }
}

function processTerminalCleanup(task: PowerBankHarvestTask): void {
  if (task.sourceRoom && (task.boostLabs.length > 0 || !!getPowerBankBoostPrep(task.id))) {
    releaseBoostLabs(task.id, task.sourceRoom);
    task.boostLabs = [];
  }

  neutralizeTaskCreeps(task);
  cleanupTaskConfigs(task);
}

/**
 * Idempotent early task ownership: assigns taskId to currently spawned
 * attacker/healer creeps before role `.work()` can run.  Assigns independently
 * per role when `taskId` is absent or already equals `task.id`.  Never
 * overwrites a different existing taskId.
 */
function ensureCreepTaskIds(task: PowerBankHarvestTask): void {
  const attackerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "attacker", 0);
  const healerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "healer", 0);

  for (const creep of getTickContextService().getCreepsByConfigName(attackerConfigName)) {
    const mem = creep.memory as PowerBankCreepMemory;
    if (mem.taskId === undefined || mem.taskId === task.id) {
      mem.taskId = task.id;
    }
  }

  for (const creep of getTickContextService().getCreepsByConfigName(healerConfigName)) {
    const mem = creep.memory as PowerBankCreepMemory;
    if (mem.taskId === undefined || mem.taskId === task.id) {
      mem.taskId = task.id;
    }
  }
}

function processTask(task: PowerBankHarvestTask): void {
  if (!isPowerBankPatrolRoom(task.targetRoom)) {
    if (
      task.status !== POWER_BANK_STATUS.FAILED &&
      task.status !== POWER_BANK_STATUS.ABORTED &&
      task.status !== POWER_BANK_STATUS.COMPLETE
    ) {
      transitionToTerminal(task, "aborted", "outside_powerbank_patrol_rooms");
    }
    return;
  }

  if (BOOST_FINISHED_STATUSES.has(task.status)) {
    releaseFinishedBoostLabs(task);
  }

  // Assign task ownership before early returns in pre-travel statuses
  if (
    task.status === POWER_BANK_STATUS.SPAWNING ||
    task.status === POWER_BANK_STATUS.RENEWING ||
    task.status === POWER_BANK_STATUS.BOOSTING
  ) {
    ensureCreepTaskIds(task);
  }

  switch (task.status) {
    case POWER_BANK_STATUS.DISCOVERED:
      processDiscovered(task);
      break;
    case POWER_BANK_STATUS.PREPARING_BOOSTS:
      processPreparingBoosts(task);
      break;
    case POWER_BANK_STATUS.SPAWNING:
      processSpawning(task);
      break;
    case POWER_BANK_STATUS.BOOSTING:
      processBoosting(task);
      break;
    case POWER_BANK_STATUS.RENEWING:
      processRenewing(task);
      break;
    case POWER_BANK_STATUS.TRAVELLING:
      processTravelling(task);
      break;
    case POWER_BANK_STATUS.ATTACKING:
      processAttacking(task);
      break;
    case POWER_BANK_STATUS.HAULING:
      processHauling(task);
      break;
    case POWER_BANK_STATUS.FAILED:
    case POWER_BANK_STATUS.ABORTED:
    case POWER_BANK_STATUS.COMPLETE:
      break;
  }
}

function maintainPatrolScout(): void {
  const configStore = getConfigStore();
  if (hasPowerBankObserverCoverage()) {
    if (configStore[PATROL_SCOUT_CONFIG_NAME]) {
      delete configStore[PATROL_SCOUT_CONFIG_NAME];
    }
    return;
  }

  const existingScouts = getTickContextService().getCreepsByConfigName(PATROL_SCOUT_CONFIG_NAME);
  if (existingScouts.length > 0) return;

  if (configStore[PATROL_SCOUT_CONFIG_NAME]) {
    const creepMemory = Memory.creeps || {};
    for (const room of getTickContextService().getMyRooms()) {
      for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
        if (!spawn.spawning) continue;
        if (creepMemory[spawn.spawning.name]?.configName === PATROL_SCOUT_CONFIG_NAME) return;
      }
    }
    delete configStore[PATROL_SCOUT_CONFIG_NAME];
  }

  const eligibleRooms = getTickContextService().getMyRooms().filter(r => {
    if ((r.controller?.level ?? 0) < 6) return false;
    const spawns = getTickContextService().getSpawnsByRoom(r.name);
    return spawns.length > 0;
  });

  if (eligibleRooms.length === 0) return;

  const firstPatrolRoom = POWER_BANK_PATROL_ROOMS[0];
  const sourceRoom = eligibleRooms.reduce((best, room) => {
    const dist = getRouteDistance(room.name, firstPatrolRoom);
    const bestDist = getRouteDistance(best.name, firstPatrolRoom);
    return dist < bestDist ? room : best;
  }).name;

  configStore[PATROL_SCOUT_CONFIG_NAME] = {
    role: "powerBankScout",
    args: [],
    roomName: sourceRoom,
  };
}

export function runPowerBankHarvest(): void {
  maintainPatrolScout();
  cleanupStaleDiscoveries();

  const store = getTaskStore();
  const tasks = Object.values(store);

  for (const task of tasks) {
    processTask(task);
  }

  for (const task of tasks) {
    const isTerminal =
      task.status === POWER_BANK_STATUS.FAILED ||
      task.status === POWER_BANK_STATUS.ABORTED ||
      task.status === POWER_BANK_STATUS.COMPLETE;

    if (isTerminal) {
      processTerminalCleanup(task);
    }
  }

  const toDelete: string[] = [];
  for (const id of Object.keys(store)) {
    const task = store[id];
    if (!task) continue;
    const isTerminal =
      task.status === POWER_BANK_STATUS.FAILED ||
      task.status === POWER_BANK_STATUS.ABORTED ||
      task.status === POWER_BANK_STATUS.COMPLETE;
    if (!isTerminal) continue;
    if (task.terminalTick === undefined) continue;

    if (Game.time - task.terminalTick > TERMINAL_STATE_CLEANUP_DELAY) {
      toDelete.push(id);
    }
  }

  for (const id of toDelete) {
    delete store[id];
  }

  cleanupOrphanPowerBankConfigs(Object.values(store));
}
