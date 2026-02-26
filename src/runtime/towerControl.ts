const TOWER_MIN_REPAIR_ENERGY = 400;

function runTower(tower: StructureTower): void {
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
    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_TOWER,
    }) as StructureTower[];

    for (const tower of towers) {
      runTower(tower);
    }
  }
}
