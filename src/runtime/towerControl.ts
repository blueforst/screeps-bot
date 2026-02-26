const TOWER_MIN_REPAIR_ENERGY = 400;
const TOWER_MIN_EMERGENCY_REPAIR_ENERGY = 200;
const RAMPART_EMERGENCY_TRIGGER_HITS = 3000;
const RAMPART_EMERGENCY_TARGET_HITS = 6000;

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

function runTower(tower: StructureTower, emergencyRamparts: StructureRampart[]): void {
  const hostile = tower.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
  if (hostile) {
    tower.attack(hostile);
    return;
  }

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

export function runTowerControl(): void {
  const rooms = Object.values(Game.rooms).filter((room) => room.controller?.my);
  for (const room of rooms) {
    const emergencyRamparts = collectEmergencyRamparts(room);
    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_TOWER,
    }) as StructureTower[];

    for (const tower of towers) {
      runTower(tower, emergencyRamparts);
    }
  }
}
