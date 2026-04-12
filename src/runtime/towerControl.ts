import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";

const TOWER_MIN_REPAIR_ENERGY = 400;
const TOWER_MIN_EMERGENCY_REPAIR_ENERGY = 200;
const RAMPART_EMERGENCY_TRIGGER_HITS = 3000;
const RAMPART_EMERGENCY_TARGET_HITS = 6000;
const TOWER_FOCUS_STALL_HITS_DELTA = 40;
const TOWER_FOCUS_STALL_TICKS = 2;
const TOWER_SPREAD_PROBE_DURATION = 3;
const TOWER_SPREAD_PROBE_INTERVAL = 7;

interface TowerCombatRoomState {
  focusTargetId?: string;
  lastFocusHits?: number;
  stalledTicks?: number;
  spreadUntil?: number;
}

interface TowerCombatAnalysis {
  totalTowerAttackByHostileId: Map<Id<Creep>, number>;
  incomingHealByHostileId: Map<Id<Creep>, number>;
  towerAttackByTowerId: Map<Id<StructureTower>, Map<Id<Creep>, number>>;
}

function ensureTowerCombatRoomState(roomName: string): TowerCombatRoomState {
  const runtime = getMemoryService().ensureRuntime();
  runtime.towerCombat = runtime.towerCombat || {};
  runtime.towerCombat[roomName] = runtime.towerCombat[roomName] || {};
  return runtime.towerCombat[roomName];
}

function getTowerAttackPowerByRange(range: number): number {
  if (range <= TOWER_OPTIMAL_RANGE) {
    return TOWER_POWER_ATTACK;
  }

  if (range >= TOWER_FALLOFF_RANGE) {
    return Math.floor(TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF));
  }

  const falloffRange = TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE;
  const beyondOptimal = range - TOWER_OPTIMAL_RANGE;
  const falloffRatio = beyondOptimal / falloffRange;
  const power = TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF * falloffRatio);
  return Math.floor(power);
}

function getHealPartPower(part: BodyPartDefinition, ranged: boolean): number {
  if (part.type !== HEAL || part.hits <= 0) {
    return 0;
  }

  const base = ranged ? RANGED_HEAL_POWER : HEAL_POWER;
  if (!part.boost) {
    return base;
  }

  const boostEntry = (BOOSTS[HEAL] as Record<string, { heal?: number; rangedHeal?: number } | undefined> | undefined)?.[
    part.boost
  ];
  if (!boostEntry) {
    return base;
  }

  const multiplier = ranged ? boostEntry.rangedHeal : boostEntry.heal;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) {
    return base;
  }

  return Math.floor(base * multiplier);
}

function getCreepHealPowerAtRange(creep: Creep, rangeToTarget: number): number {
  if (rangeToTarget > 3) {
    return 0;
  }

  const ranged = rangeToTarget > 1;
  return creep.body.reduce((sum, part) => sum + getHealPartPower(part, ranged), 0);
}

function createTowerCombatAnalysis(towers: StructureTower[], hostiles: Creep[]): TowerCombatAnalysis {
  const totalTowerAttackByHostileId = new Map<Id<Creep>, number>();
  const incomingHealByHostileId = new Map<Id<Creep>, number>();
  const towerAttackByTowerId = new Map<Id<StructureTower>, Map<Id<Creep>, number>>();

  for (const tower of towers) {
    const damageByHostileId = new Map<Id<Creep>, number>();
    for (const hostile of hostiles) {
      const damage = getTowerAttackPowerByRange(tower.pos.getRangeTo(hostile.pos));
      damageByHostileId.set(hostile.id, damage);
      totalTowerAttackByHostileId.set(hostile.id, (totalTowerAttackByHostileId.get(hostile.id) || 0) + damage);
    }
    towerAttackByTowerId.set(tower.id, damageByHostileId);
  }

  for (const target of hostiles) {
    let totalHeal = 0;
    for (const hostile of hostiles) {
      totalHeal += getCreepHealPowerAtRange(hostile, hostile.pos.getRangeTo(target.pos));
    }
    incomingHealByHostileId.set(target.id, totalHeal);
  }

  return {
    totalTowerAttackByHostileId,
    incomingHealByHostileId,
    towerAttackByTowerId,
  };
}

function chooseFocusTarget(hostiles: Creep[], analysis: TowerCombatAnalysis): Creep | null {
  let best: Creep | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const hostile of hostiles) {
    const totalDamage = analysis.totalTowerAttackByHostileId.get(hostile.id) || 0;
    const heal = analysis.incomingHealByHostileId.get(hostile.id) || 0;
    const net = totalDamage - heal;
    const score = net * 1000 - hostile.hits * 0.2;
    if (score > bestScore) {
      best = hostile;
      bestScore = score;
    }
  }

  return best;
}

function assignSpreadTargets(
  towers: StructureTower[],
  hostiles: Creep[],
  analysis: TowerCombatAnalysis,
): Map<Id<StructureTower>, Creep> {
  const assignments = new Map<Id<StructureTower>, Creep>();
  const appliedPressure: Record<string, number> = {};
  const assignedTargetIds = new Set<string>();

  const sortedTowers = [...towers].sort((left, right) => left.id.localeCompare(right.id));
  for (const tower of sortedTowers) {
    let best: Creep | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const candidatePool = hostiles.filter((hostile) => !assignedTargetIds.has(hostile.id));
    const candidates = candidatePool.length > 0 ? candidatePool : hostiles;
    const towerDamageByHostileId = analysis.towerAttackByTowerId.get(tower.id);

    for (const hostile of candidates) {
      const range = tower.pos.getRangeTo(hostile.pos);
      const damage = towerDamageByHostileId?.get(hostile.id) || 0;
      const heal = analysis.incomingHealByHostileId.get(hostile.id) || 0;
      const currentPressure = appliedPressure[hostile.id] || 0;
      const projectedNet = damage - Math.max(0, heal - currentPressure);
      const finishingBonus = hostile.hits <= damage * 1.2 ? 120 : 0;
      const score = projectedNet * 1000 + finishingBonus - range * 2 - hostile.hits * 0.02;

      if (score > bestScore) {
        best = hostile;
        bestScore = score;
      }
    }

    if (!best) {
      continue;
    }

    assignments.set(tower.id, best);
    assignedTargetIds.add(best.id);
    appliedPressure[best.id] = (appliedPressure[best.id] || 0) + (towerDamageByHostileId?.get(best.id) || 0);
  }

  return assignments;
}

function ensureEmergencyRampartStore(roomName: string): Record<string, number> {
  const runtime = getMemoryService().ensureRuntime();
  runtime.towerEmergencyRamparts = runtime.towerEmergencyRamparts || {};
  runtime.towerEmergencyRamparts[roomName] = runtime.towerEmergencyRamparts[roomName] || {};
  return runtime.towerEmergencyRamparts[roomName];
}

function collectEmergencyRamparts(room: Room): StructureRampart[] {
  const store = ensureEmergencyRampartStore(room.name);
  const roomContext = getTickContextService().getRoomContext(room);

  const ramparts = roomContext?.getRamparts() || [];
  const rampartById = new Map(ramparts.map((rampart) => [rampart.id, rampart]));

  for (const [rampartId] of Object.entries(store)) {
    const rampart = rampartById.get(rampartId as Id<StructureRampart>);
    if (!rampart || rampart.hits >= RAMPART_EMERGENCY_TARGET_HITS) {
      delete store[rampartId];
    }
  }

  for (const rampart of ramparts) {
    if (rampart.hits < RAMPART_EMERGENCY_TRIGGER_HITS) {
      store[rampart.id] = Game.time;
    }
  }

  return Object.keys(store)
    .map((rampartId) => rampartById.get(rampartId as Id<StructureRampart>) || null)
    .filter((rampart): rampart is StructureRampart => !!rampart && rampart.hits < RAMPART_EMERGENCY_TARGET_HITS);
}

function runTowerPeaceFlow(
  tower: StructureTower,
  emergencyRamparts: StructureRampart[],
  woundedCreeps: Creep[],
  damagedStructures: Structure<StructureConstant>[],
): void {
  const wounded = woundedCreeps.length > 0 ? tower.pos.findClosestByRange(woundedCreeps) : null;
  if (wounded) {
    const code = tower.heal(wounded);
    if (code === OK) {
      recordFixedCpuAction("towerControl");
    }
    return;
  }

  if (emergencyRamparts.length > 0 && tower.store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_MIN_EMERGENCY_REPAIR_ENERGY) {
    const emergencyRampart = tower.pos.findClosestByRange(emergencyRamparts);
    if (emergencyRampart) {
      const code = tower.repair(emergencyRampart);
      if (code === OK) {
        recordFixedCpuAction("towerControl");
      }
      return;
    }
  }

  if (tower.store.getUsedCapacity(RESOURCE_ENERGY) < TOWER_MIN_REPAIR_ENERGY) {
    return;
  }

  const damaged = damagedStructures.length > 0 ? tower.pos.findClosestByRange(damagedStructures) : null;

  if (damaged) {
    const code = tower.repair(damaged);
    if (code === OK) {
      recordFixedCpuAction("towerControl");
    }
  }
}

function isAllHostilesImmune(analysis: TowerCombatAnalysis, hostiles: Creep[]): boolean {
  return hostiles.every(
    (hostile) =>
      (analysis.totalTowerAttackByHostileId.get(hostile.id) || 0) <=
      (analysis.incomingHealByHostileId.get(hostile.id) || 0),
  );
}

export function canTowersHandleHostiles(room: Room, hostiles: Creep[]): boolean {
  if (hostiles.length === 0) {
    return true;
  }

  const towers = (getTickContextService().getRoomContext(room)?.getTowers() || []).filter(
    (tower) => tower.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  );
  if (towers.length === 0) {
    return false;
  }

  const analysis = createTowerCombatAnalysis(towers, hostiles);
  return hostiles.every(
    (hostile) =>
      (analysis.totalTowerAttackByHostileId.get(hostile.id) || 0) >
      (analysis.incomingHealByHostileId.get(hostile.id) || 0),
  );
}

function isDefenderOnRampart(room: Room): boolean {
  const defenders = room.find(FIND_MY_CREEPS, {
    filter: (creep) => creep.memory.role === "homeDefender",
  });

  for (const defender of defenders) {
    const onRampart = defender.pos
      .lookFor(LOOK_STRUCTURES)
      .some((s) => s.structureType === STRUCTURE_RAMPART && (s as StructureRampart).my);
    if (onRampart) return true;
  }

  return false;
}

function runTowerCombat(room: Room, towers: StructureTower[], hostiles: Creep[], woundedCreeps: Creep[]): boolean {
  if (hostiles.length <= 0 || towers.length <= 0) {
    return false;
  }

  const attackTowers: StructureTower[] = [];
  for (const tower of towers) {
    if (woundedCreeps.length > 0) {
      const target = tower.pos.findClosestByRange(woundedCreeps);
      if (target) {
        const code = tower.heal(target);
        if (code === OK) {
          recordFixedCpuAction("towerControl");
        }
        continue;
      }
    }
    attackTowers.push(tower);
  }

  if (attackTowers.length === 0) {
    return true;
  }

  const state = ensureTowerCombatRoomState(room.name);
  const analysis = createTowerCombatAnalysis(attackTowers, hostiles);

  if (isAllHostilesImmune(analysis, hostiles) && !isDefenderOnRampart(room)) {
    delete state.focusTargetId;
    delete state.lastFocusHits;
    delete state.stalledTicks;
    delete state.spreadUntil;
    return true;
  }
  const focusTarget = chooseFocusTarget(hostiles, analysis);
  if (!focusTarget) {
    const spreadAssignments = assignSpreadTargets(attackTowers, hostiles, analysis);
    for (const tower of attackTowers) {
      const target = spreadAssignments.get(tower.id);
      if (target) {
        const code = tower.attack(target);
        if (code === OK) {
          recordFixedCpuAction("towerControl");
        }
      }
    }
    return true;
  }

  const focusTotalNet =
    (analysis.totalTowerAttackByHostileId.get(focusTarget.id) || 0) -
    (analysis.incomingHealByHostileId.get(focusTarget.id) || 0);
  const sameFocusAsLastTick = state.focusTargetId === focusTarget.id;
  const previousFocusHits = state.lastFocusHits;
  const focusDamageDelta =
    sameFocusAsLastTick && typeof previousFocusHits === "number" ? previousFocusHits - focusTarget.hits : TOWER_FOCUS_STALL_HITS_DELTA;

  if (sameFocusAsLastTick && focusDamageDelta < TOWER_FOCUS_STALL_HITS_DELTA) {
    state.stalledTicks = (state.stalledTicks || 0) + 1;
  } else {
    state.stalledTicks = 0;
  }

  const shouldForceSpread = (state.spreadUntil || 0) >= Game.time;
  const shouldProbeSpread =
    focusTotalNet <= 0 ||
    (hostiles.length > 1 && focusTotalNet < TOWER_POWER_ATTACK * 0.6) ||
    (state.stalledTicks || 0) >= TOWER_FOCUS_STALL_TICKS ||
    (Game.time % TOWER_SPREAD_PROBE_INTERVAL === 0 && focusTotalNet < TOWER_POWER_ATTACK);

  if (shouldProbeSpread) {
    state.spreadUntil = Game.time + TOWER_SPREAD_PROBE_DURATION;
  }

  const useSpread = shouldForceSpread || shouldProbeSpread;
  if (useSpread) {
    const spreadAssignments = assignSpreadTargets(attackTowers, hostiles, analysis);
    for (const tower of attackTowers) {
      const target = spreadAssignments.get(tower.id);
      if (target) {
        const code = tower.attack(target);
        if (code === OK) {
          recordFixedCpuAction("towerControl");
        }
      }
    }
  } else {
    for (const tower of attackTowers) {
      const code = tower.attack(focusTarget);
      if (code === OK) {
        recordFixedCpuAction("towerControl");
      }
    }
  }

  state.focusTargetId = focusTarget.id;
  state.lastFocusHits = focusTarget.hits;
  return true;
}

export function runTowerControl(): void {
  const tickContext = getTickContextService();
  const rooms = tickContext.getMyRooms();
  for (const room of rooms) {
    const roomContext = tickContext.getRoomContext(room);
    const emergencyRamparts = collectEmergencyRamparts(room);
    const hostiles = roomContext?.getHostileCreeps() || [];
    const towers = roomContext?.getTowers() || [];
    const woundedCreeps = (roomContext?.getMyCreeps() || []).filter((creep) => creep.hits < creep.hitsMax);
    const damagedStructures = (roomContext?.getStructures() || []).filter(
      (structure) =>
        structure.hits < structure.hitsMax &&
        structure.structureType !== STRUCTURE_WALL &&
        structure.structureType !== STRUCTURE_RAMPART,
    );

    if (runTowerCombat(room, towers, hostiles, woundedCreeps)) {
      continue;
    }

    const state = ensureTowerCombatRoomState(room.name);
    delete state.focusTargetId;
    delete state.lastFocusHits;
    delete state.stalledTicks;
    delete state.spreadUntil;

    for (const tower of towers) {
      runTowerPeaceFlow(tower, emergencyRamparts, woundedCreeps, damagedStructures);
    }
  }
}
