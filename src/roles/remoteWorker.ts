import { moveToTarget, moveToTargetRoom } from "@/roles/shared";

import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTS = { plainCost: 2, swampCost: 10, travelRange: 3 as const, reusePath: 10 };
const TERMINAL_ENERGY_RESERVE = 10000;

function getHomeRoomName(creep: Creep): string {
  return creep.memory.configName?.split(":")[0] || creep.room.name;
}

function getCarriedEnergy(creep: Creep): number {
  return creep.store.getUsedCapacity(RESOURCE_ENERGY);
}

function isEmpty(creep: Creep): boolean {
  return getCarriedEnergy(creep) === 0;
}

function isFull(creep: Creep): boolean {
  return creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
}

function findRemoteSourceIds(targetRoom: string): string[] {
  return Memory.data?.remoteMining?.[targetRoom]?.sourceIds ?? [];
}

function findSourceContainersInRoom(room: Room, sourceIds: string[]): StructureContainer[] {
  const sourcePositions: RoomPosition[] = [];
  for (const sid of sourceIds) {
    const source = Game.getObjectById(sid as Id<Source>);
    if (source) sourcePositions.push(source.pos);
  }

  return room.find(FIND_STRUCTURES, {
    filter: (s): s is StructureContainer =>
      s.structureType === STRUCTURE_CONTAINER &&
      sourcePositions.some((sp) => sp.getRangeTo(s.pos) <= 2),
  });
}

function findSourceContainerSitesInRoom(room: Room, sourceIds: string[]): ConstructionSite[] {
  const sourcePositions: RoomPosition[] = [];
  for (const sid of sourceIds) {
    const source = Game.getObjectById(sid as Id<Source>);
    if (source) sourcePositions.push(source.pos);
  }

  return room.find(FIND_CONSTRUCTION_SITES, {
    filter: (s): s is ConstructionSite =>
      s.my &&
      s.structureType === STRUCTURE_CONTAINER &&
      sourcePositions.some((sp) => sp.getRangeTo(s.pos) <= 2),
  });
}

export const remoteWorkerRole: RoleFactory = (targetRoom: string) => {
  return {
    source: (creep): boolean => {
      const homeName = getHomeRoomName(creep);

      if (isFull(creep)) {
        return true;
      }

      if (creep.room.name !== homeName) {
        moveToTargetRoom(creep, homeName, undefined, TRAVEL_OPTS);
        return false;
      }

      const homeRoom = Game.rooms[homeName];

      if (homeRoom?.storage) {
        const storageEnergy = homeRoom.storage.store.getUsedCapacity(RESOURCE_ENERGY);
        if (storageEnergy > 0) {
          const code = creep.withdraw(homeRoom.storage, RESOURCE_ENERGY);
          if (code === ERR_NOT_IN_RANGE) {
            moveToTarget(creep, homeRoom.storage, 1);
          }
          return false;
        }
      }

      if (homeRoom?.terminal) {
        const terminalEnergy = homeRoom.terminal.store.getUsedCapacity(RESOURCE_ENERGY);
        if (terminalEnergy > TERMINAL_ENERGY_RESERVE) {
          const surplus = terminalEnergy - TERMINAL_ENERGY_RESERVE;
          const freeCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY);
          const amount = Math.min(freeCapacity, surplus);
          const code = creep.withdraw(homeRoom.terminal, RESOURCE_ENERGY, amount);
          if (code === ERR_NOT_IN_RANGE) {
            moveToTarget(creep, homeRoom.terminal, 1);
          }
          return false;
        }
      }

      return false;
    },

    target: (creep): boolean => {
      const homeName = getHomeRoomName(creep);

      if (isEmpty(creep)) {
        if (creep.room.name === homeName) {
          if (typeof creep.suicide === "function") {
            creep.suicide();
          }
        }
        return true;
      }

      if (creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, undefined, TRAVEL_OPTS);
        return false;
      }

      const sourceIds = findRemoteSourceIds(targetRoom);

      const containerSites = findSourceContainerSitesInRoom(creep.room, sourceIds);
      if (containerSites.length > 0) {
        const site = containerSites[0];
        const range = creep.pos.getRangeTo(site.pos);
        if (range <= 3) {
          creep.build(site);
        } else {
          moveToTarget(creep, site, 3);
        }
        return false;
      }

      const containers = findSourceContainersInRoom(creep.room, sourceIds);
      const damagedContainers = containers.filter((c) => c.hits < c.hitsMax);
      if (damagedContainers.length > 0) {
        damagedContainers.sort((a, b) => (a.hits / a.hitsMax) - (b.hits / b.hitsMax));
        const target = damagedContainers[0];
        const range = creep.pos.getRangeTo(target.pos);
        if (range <= 3) {
          creep.repair(target);
        } else {
          moveToTarget(creep, target, 3);
        }
        return false;
      }

      moveToTargetRoom(creep, homeName, undefined, TRAVEL_OPTS);
      return false;
    },
  };
};
