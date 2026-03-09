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

function ensureTowerCombatRoomState(roomName: string): TowerCombatRoomState {
  Memory.runtime = Memory.runtime || {};
  Memory.runtime.towerCombat = Memory.runtime.towerCombat || {};
  Memory.runtime.towerCombat[roomName] = Memory.runtime.towerCombat[roomName] || {};
  return Memory.runtime.towerCombat[roomName];
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

function getIncomingHealPower(target: Creep, hostiles: Creep[]): number {
  let total = 0;
  for (const hostile of hostiles) {
    total += getCreepHealPowerAtRange(hostile, hostile.pos.getRangeTo(target.pos));
  }

  return total;
}

function getTotalTowerAttackPower(target: Creep, towers: StructureTower[]): number {
  let total = 0;
  for (const tower of towers) {
    total += getTowerAttackPowerByRange(tower.pos.getRangeTo(target.pos));
  }

  return total;
}

function chooseFocusTarget(towers: StructureTower[], hostiles: Creep[]): Creep | null {
  let best: Creep | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const hostile of hostiles) {
    const totalDamage = getTotalTowerAttackPower(hostile, towers);
    const heal = getIncomingHealPower(hostile, hostiles);
    const net = totalDamage - heal;
    const score = net * 1000 - hostile.hits * 0.2;
    if (score > bestScore) {
      best = hostile;
      bestScore = score;
    }
  }

  return best;
}

function assignSpreadTargets(towers: StructureTower[], hostiles: Creep[]): Map<Id<StructureTower>, Creep> {
  const assignments = new Map<Id<StructureTower>, Creep>();
  const appliedPressure: Record<string, number> = {};

  const sortedTowers = [...towers].sort((left, right) => left.id.localeCompare(right.id));
  for (const tower of sortedTowers) {
    let best: Creep | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const hostile of hostiles) {
      const range = tower.pos.getRangeTo(hostile.pos);
      const damage = getTowerAttackPowerByRange(range);
      const heal = getIncomingHealPower(hostile, hostiles);
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
    appliedPressure[best.id] = (appliedPressure[best.id] || 0) + getTowerAttackPowerByRange(tower.pos.getRangeTo(best.pos));
  }

  return assignments;
}

function ensureEmergencyRampartStore(roomName: string): Record<string, number> {
  Memory.runtime = Memory.runtime || {};
  Memory.runtime.towerEmergencyRamparts = Memory.runtime.towerEmergencyRamparts || {};
  Memory.runtime.towerEmergencyRamparts[roomName] = Memory.runtime.towerEmergencyRamparts[roomName] || {};
  return Memory.runtime.towerEmergencyRamparts[roomName];
}

function collectEmergencyRamparts(room: Room): StructureRampart[] {
  const store = ensureEmergencyRampartStore(room.name);

  const ramparts = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) => structure.structureType === STRUCTURE_RAMPART,
  }) as StructureRampart[];
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

function runTowerPeaceFlow(tower: StructureTower, emergencyRamparts: StructureRampart[]): void {

  const wounded = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
    filter: (creep) => creep.hits < creep.hitsMax,
  });
  if (wounded) {
    tower.heal(wounded);
    return;
  }

  if (emergencyRamparts.length > 0 && tower.store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_MIN_EMERGENCY_REPAIR_ENERGY) {
    const emergencyRampart = tower.pos.findClosestByRange(emergencyRamparts);
    if (emergencyRampart) {
      tower.repair(emergencyRampart);
      return;
    }
  }

  if (tower.store.getUsedCapacity(RESOURCE_ENERGY) < TOWER_MIN_REPAIR_ENERGY) {
    return;
  }

  const damaged = tower.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: (structure) => {
      if (structure.hits >= structure.hitsMax) {
        return false;
      }

      return structure.structureType !== STRUCTURE_WALL && structure.structureType !== STRUCTURE_RAMPART;
    },
  });

  if (damaged) {
    tower.repair(damaged);
  }
}

function runTowerCombat(room: Room, towers: StructureTower[], hostiles: Creep[]): boolean {
  if (hostiles.length <= 0 || towers.length <= 0) {
    return false;
  }

  const state = ensureTowerCombatRoomState(room.name);
  const focusTarget = chooseFocusTarget(towers, hostiles);
  if (!focusTarget) {
    const spreadAssignments = assignSpreadTargets(towers, hostiles);
    for (const tower of towers) {
      const target = spreadAssignments.get(tower.id);
      if (target) {
        tower.attack(target);
      }
    }
    return true;
  }

  const focusTotalNet = getTotalTowerAttackPower(focusTarget, towers) - getIncomingHealPower(focusTarget, hostiles);
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
    (state.stalledTicks || 0) >= TOWER_FOCUS_STALL_TICKS ||
    (Game.time % TOWER_SPREAD_PROBE_INTERVAL === 0 && focusTotalNet < TOWER_POWER_ATTACK);

  if (shouldProbeSpread) {
    state.spreadUntil = Game.time + TOWER_SPREAD_PROBE_DURATION;
  }

  const useSpread = shouldForceSpread || shouldProbeSpread;
  if (useSpread) {
    const spreadAssignments = assignSpreadTargets(towers, hostiles);
    for (const tower of towers) {
      const target = spreadAssignments.get(tower.id);
      if (target) {
        tower.attack(target);
      }
    }
  } else {
    for (const tower of towers) {
      tower.attack(focusTarget);
    }
  }

  state.focusTargetId = focusTarget.id;
  state.lastFocusHits = focusTarget.hits;
  return true;
}

export function runTowerControl(): void {
  const rooms = Object.values(Game.rooms).filter((room) => room.controller?.my);
  for (const room of rooms) {
    const emergencyRamparts = collectEmergencyRamparts(room);
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_TOWER,
    }) as StructureTower[];

    if (runTowerCombat(room, towers, hostiles)) {
      continue;
    }

    const state = ensureTowerCombatRoomState(room.name);
    delete state.focusTargetId;
    delete state.lastFocusHits;
    delete state.stalledTicks;
    delete state.spreadUntil;

    for (const tower of towers) {
      runTowerPeaceFlow(tower, emergencyRamparts);
    }
  }
}
