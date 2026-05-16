import { POWER_BANK_STATUS, POWER_BANK_BODY_TIERS, POWER_BANK_BOOST_REQUIREMENTS, POWER_BANK_PATROL_ROOMS, getPowerBankConfigName } from "@/runtime/powerBankConstants";
import { selectBodyTier, assessViability } from "@/runtime/powerBankViability";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import { ensureDiscoveryStore } from "@/runtime/powerBankDiscovery";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

const PATROL_SCOUT_CONFIG_NAME = "powerbank:patrol:scout:0";

const TERMINAL_STATE_CLEANUP_DELAY = 100;

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

function removeSpawnQueueEntries(task: PowerBankHarvestTask): void {
  const spawn = getTickContextService().getPrimarySpawnByRoom(task.sourceRoom);
  if (!spawn?.memory.spawnList) return;
  const prefix = `${task.sourceRoom}:powerbank:${task.targetRoom}:`;
  spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => !name.startsWith(prefix));
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

function cleanupTaskConfigs(task: PowerBankHarvestTask): void {
  const configNames = getTaskConfigNames(task);
  removeSpawnQueueEntries(task);
  for (const configName of configNames) {
    removeConfigWhenIdle(configName);
  }
}

function transitionToTerminal(task: PowerBankHarvestTask, status: "failed" | "aborted" | "complete", reason?: string): void {
  task.status = status;
  task.failReason = reason;
  task.terminalTick = Game.time;
}

function findNearestEligibleRoom(targetRoom: string): { roomName: string; energyCapacity: number; distance: number } | null {
  let best: { roomName: string; energyCapacity: number; distance: number } | null = null;
  const tickContext = getTickContextService();

  for (const room of tickContext.getMyRooms()) {
    if (!room.controller || room.controller.level < 6) continue;

    const spawns = tickContext.getSpawnsByRoom(room.name);
    if (spawns.length === 0) continue;

    if (isDefenseMode(room.name)) continue;

    const energyCapacity = room.energyCapacityAvailable;
    const distance = Game.map.getRoomLinearDistance(room.name, targetRoom);

    if (!best || distance < best.distance) {
      best = { roomName: room.name, energyCapacity, distance };
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

  const haulerCapacity = (Math.floor(nearest.energyCapacity / (BODYPART_COST[CARRY] + BODYPART_COST[MOVE])) || 1) * CARRY_CAPACITY;

  const viability = assessViability({
    energyCapacity: nearest.energyCapacity,
    bankHits: task.hits,
    bankPower: task.power,
    ticksToDecay: task.ticksToDecay,
    freeTiles: task.freeTiles,
    routeDistance: nearest.distance,
    currentTick: Game.time,
    hasCompounds: {
      xgho2: getLocalCompoundStock(room, RESOURCE_CATALYZED_GHODIUM_ACID) > 0,
      xuh2o: getLocalCompoundStock(room, RESOURCE_CATALYZED_UTRIUM_ACID) > 0,
      xlho2: getLocalCompoundStock(room, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE) > 0,
    },
    isDefenseMode: false,
    haulerCapacity,
  });

  if (!viability.viable) {
    transitionToTerminal(task, "failed", viability.reasons.join(","));
    return;
  }

  task.sourceRoom = nearest.roomName;
  task.tier = tierKindToNumber(tierResult.attackerTier);
  task.routeDistance = nearest.distance;
  task.status = POWER_BANK_STATUS.PREPARING_BOOSTS;
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

  if (result.status === "ready") {
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

  const tierBodies = POWER_BANK_BODY_TIERS[task.tier];
  if (!tierBodies) {
    transitionToTerminal(task, "failed", "invalid_tier");
    return;
  }

  const configStore = getConfigStore();
  const encodedRoute = "";

  const attackerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "attacker", 0);
  configStore[attackerConfigName] = {
    role: "powerBankAttacker",
    args: [task.targetRoom, encodedRoute],
    roomName: task.sourceRoom,
    body: tierBodies.attacker,
  };

  const healerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "healer", 0);
  configStore[healerConfigName] = {
    role: "powerBankHealer",
    args: [task.targetRoom, encodedRoute],
    roomName: task.sourceRoom,
    body: tierBodies.healer,
  };

  task.status = POWER_BANK_STATUS.BOOSTING;
}

function isCreepBoosted(creep: Creep): boolean {
  return creep.body.some((part) => !!part.boost);
}

function isBoostRequiredForRole(tier: number, role: "attacker" | "healer"): boolean {
  const requirements = POWER_BANK_BOOST_REQUIREMENTS[tier];
  if (!requirements) return false;
  return requirements[role].length > 0;
}

function processBoosting(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  const attackerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "attacker", 0);
  const healerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "healer", 0);

  const attackerCreeps = getTickContextService().getCreepsByConfigName(attackerConfigName);
  const healerCreeps = getTickContextService().getCreepsByConfigName(healerConfigName);

  if (attackerCreeps.length === 0 && healerCreeps.length === 0) return;

  if (attackerCreeps.length === 0 || healerCreeps.length === 0) {
    return;
  }

  const attacker = attackerCreeps[0];
  const healer = healerCreeps[0];
  const tier = task.tier ?? 8;

  if (!task.attackerReady) {
    if (isBoostRequiredForRole(tier, "attacker")) {
      task.attackerReady = isCreepBoosted(attacker);
    } else {
      task.attackerReady = true;
    }
  }

  if (!task.healerReady) {
    if (isBoostRequiredForRole(tier, "healer")) {
      task.healerReady = isCreepBoosted(healer);
    } else {
      task.healerReady = true;
    }
  }

  if (task.attackerReady && task.healerReady) {
    task.status = POWER_BANK_STATUS.RENEWING;
  }
}

function processRenewing(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  const attackerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "attacker", 0);
  const healerConfigName = getPowerBankConfigName(task.sourceRoom, task.targetRoom, "healer", 0);

  const attackerCreeps = getTickContextService().getCreepsByConfigName(attackerConfigName);
  const healerCreeps = getTickContextService().getCreepsByConfigName(healerConfigName);

  if (attackerCreeps.length === 0 || healerCreeps.length === 0) {
    transitionToTerminal(task, "aborted", "creep_died_during_renewing");
    return;
  }

  const attacker = attackerCreeps[0];
  const healer = healerCreeps[0];

  const distance = task.routeDistance ?? 5;
  const MIN_TTL = distance * 2 + 50;

  const spawn = getTickContextService().getPrimarySpawnByRoom(task.sourceRoom);
  if (!spawn) return;

  const attackerTTL = attacker.ticksToLive ?? 1500;
  const healerTTL = healer.ticksToLive ?? 1500;

  if (attackerTTL < MIN_TTL) {
    spawn.renewCreep(attacker);
    task.attackerReady = false;
  } else {
    task.attackerReady = true;
  }

  if (healerTTL < MIN_TTL) {
    spawn.renewCreep(healer);
    task.healerReady = false;
  } else {
    task.healerReady = true;
  }

  if (task.attackerReady && task.healerReady) {
    task.attackerId = attacker.id as string;
    task.healerId = healer.id as string;
    task.status = POWER_BANK_STATUS.TRAVELLING;
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

  if (attacker.room.name === task.targetRoom && healer.room.name === task.targetRoom) {
    task.status = POWER_BANK_STATUS.ATTACKING;
  }
}

function processAttacking(task: PowerBankHarvestTask): void {
  if (isDefenseMode(task.sourceRoom)) {
    transitionToTerminal(task, "aborted", "defense_mode");
    return;
  }

  const bank = Game.getObjectById(task.bankId as Id<StructurePowerBank>);

  if (!bank) {
    task.status = POWER_BANK_STATUS.HAULING;
    return;
  }

  if (!task.attackerId) {
    transitionToTerminal(task, "aborted", "no_attacker");
    return;
  }

  const attacker = Game.getObjectById(task.attackerId as Id<Creep>);
  if (!attacker) {
    transitionToTerminal(task, "aborted", "attacker_died");
    return;
  }

  const toughBroken = attacker.body.every((p) => p.type !== TOUGH || p.hits <= 0);
  if (toughBroken && attacker.body.some((p) => p.type === TOUGH)) {
    transitionToTerminal(task, "aborted", "tough_broken");
  }
}

function processHauling(task: PowerBankHarvestTask): void {
  const targetRoom = Game.rooms[task.targetRoom];
  if (!targetRoom) return;

  const droppedPower = targetRoom.find(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_POWER,
  });

  const totalDropped = droppedPower.reduce((sum, r) => sum + r.amount, 0);

  if (totalDropped <= 0) {
    transitionToTerminal(task, "complete");
  }
}

function processTerminalCleanup(task: PowerBankHarvestTask): void {
  if (task.boostLabs.length > 0 && task.sourceRoom) {
    releaseBoostLabs(task.id, task.sourceRoom);
    task.boostLabs = [];
  }

  cleanupTaskConfigs(task);
}

function processTask(task: PowerBankHarvestTask): void {
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
    const dist = Game.map.getRoomLinearDistance(room.name, firstPatrolRoom);
    const bestDist = Game.map.getRoomLinearDistance(best.name, firstPatrolRoom);
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
}
