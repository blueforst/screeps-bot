import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

type RemoteHaulTarget = AnyStoreStructure | Ruin;

const T3_RESOURCES = new Set<ResourceConstant>([
  RESOURCE_CATALYZED_UTRIUM_ACID,
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
  RESOURCE_CATALYZED_KEANIUM_ACID,
  RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
  RESOURCE_CATALYZED_LEMERGIUM_ACID,
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
  RESOURCE_CATALYZED_ZYNTHIUM_ACID,
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
  RESOURCE_CATALYZED_GHODIUM_ACID,
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
]);

function getStoredResources(store: StoreDefinition): ResourceConstant[] {
  return (Object.keys(store) as ResourceConstant[]).filter((resource) => store.getUsedCapacity(resource) > 0);
}

function getFirstCarriedResource(creep: Creep): ResourceConstant | null {
  return getStoredResources(creep.store)[0] || null;
}

function getBestResource(store: StoreDefinition): ResourceConstant | null {
  const resources = getStoredResources(store);
  if (resources.length === 0) {
    return null;
  }

  return resources.sort((left, right) => {
    const leftTier = T3_RESOURCES.has(left) ? 1 : 0;
    const rightTier = T3_RESOURCES.has(right) ? 1 : 0;
    if (leftTier !== rightTier) {
      return rightTier - leftTier;
    }

    return store.getUsedCapacity(right) - store.getUsedCapacity(left);
  })[0];
}

function isWithdrawTarget(structure: Structure<StructureConstant>): structure is AnyStoreStructure {
  if (!("store" in structure)) {
    return false;
  }

  if (
    structure.structureType === STRUCTURE_CONTROLLER ||
    structure.structureType === STRUCTURE_SPAWN ||
    structure.structureType === STRUCTURE_EXTENSION
  ) {
    return false;
  }

  return (structure as AnyStoreStructure).store.getUsedCapacity() > 0;
}

function getRemoteHaulTargets(room: Room): RemoteHaulTarget[] {
  const structures = room.find(FIND_STRUCTURES, {
    filter: isWithdrawTarget,
  }) as AnyStoreStructure[];
  const ruins = room.find(FIND_RUINS, {
    filter: (ruin) => ruin.store.getUsedCapacity() > 0,
  });

  return [...structures, ...ruins];
}

function selectPickupTarget(creep: Creep): { target: RemoteHaulTarget; resource: ResourceConstant } | null {
  return measureCreepDecision(() => {
    const candidates = getRemoteHaulTargets(creep.room)
      .map((target) => ({
        target,
        resource: getBestResource(target.store),
      }))
      .filter((entry): entry is { target: RemoteHaulTarget; resource: ResourceConstant } => !!entry.resource)
      .sort((left, right) => {
        const leftTier = T3_RESOURCES.has(left.resource) ? 1 : 0;
        const rightTier = T3_RESOURCES.has(right.resource) ? 1 : 0;
        if (leftTier !== rightTier) {
          return rightTier - leftTier;
        }

        const leftAmount = left.target.store.getUsedCapacity(left.resource);
        const rightAmount = right.target.store.getUsedCapacity(right.resource);
        if (leftAmount !== rightAmount) {
          return rightAmount - leftAmount;
        }

        return creep.pos.getRangeTo(left.target.pos) - creep.pos.getRangeTo(right.target.pos);
      });

    return candidates[0] || null;
  });
}

function getDeliveryTarget(homeRoomName: string, resource: ResourceConstant): AnyStoreStructure | null {
  const homeRoom = Game.rooms[homeRoomName];
  if (!homeRoom) {
    return null;
  }

  if (homeRoom.terminal && homeRoom.terminal.store.getFreeCapacity(resource) > 0) {
    return homeRoom.terminal;
  }

  if (homeRoom.storage && homeRoom.storage.store.getFreeCapacity(resource) > 0) {
    return homeRoom.storage;
  }

  return null;
}

function isCarryStoreFull(creep: Creep): boolean {
  return (creep.store.getFreeCapacity() ?? 0) <= 0;
}

function estimateRemainingRoomTravelTicks(fromRoom: string, homeRoom: string): number {
  if (fromRoom === homeRoom) {
    return 0;
  }

  const route = Game.map.findRoute(fromRoom, homeRoom);
  if (route === ERR_NO_PATH) {
    return Game.map.getRoomLinearDistance(fromRoom, homeRoom) * 50;
  }

  return route.length * 50;
}

function shouldRetireBeforeReturn(creep: Creep, homeRoomName: string): boolean {
  if (creep.room.name === homeRoomName || creep.ticksToLive === undefined) {
    return false;
  }

  return creep.ticksToLive < estimateRemainingRoomTravelTicks(creep.room.name, homeRoomName) + 50;
}

export const remoteCarrierRole: RoleFactory = (targetRoom: string, targetX?: string, targetY?: string) => ({
  prepare: (creep): boolean => {
    if (creep.store.getUsedCapacity() > 0) {
      return true;
    }

    if (creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, undefined, { travelRange: 3, reusePath: 10 });
      return false;
    }

    return true;
  },
  source: (creep): boolean => {
    if (creep.store.getUsedCapacity() > 0 && isCarryStoreFull(creep)) {
      return true;
    }

    if (creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, undefined, { travelRange: 3, reusePath: 10 });
      return false;
    }

    const assignment = selectPickupTarget(creep);
    if (!assignment) {
      if (creep.store.getUsedCapacity() > 0) {
        return true;
      }

      const x = Number(targetX);
      const y = Number(targetY);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        moveToTarget(creep, new RoomPosition(x, y, targetRoom), 3);
      }
      return false;
    }

    const code = measureCreepIntent(() => creep.withdraw(assignment.target, assignment.resource));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, assignment.target);
      return false;
    }

    return isCarryStoreFull(creep);
  },
  target: (creep): boolean => {
    const resource = getFirstCarriedResource(creep);
    if (!resource) {
      return true;
    }

    const homeRoomName = creep.memory.configName?.split(":")[0] || creep.room.name;
    if (creep.room.name !== homeRoomName) {
      if (shouldRetireBeforeReturn(creep, homeRoomName)) {
        creep.suicide();
        return false;
      }

      moveToTargetRoom(creep, homeRoomName, undefined, { travelRange: 3, reusePath: 10 });
      return false;
    }

    const target = getDeliveryTarget(homeRoomName, resource);
    if (!target) {
      return false;
    }

    const code = measureCreepIntent(() => creep.transfer(target, resource));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target);
      return false;
    }

    return creep.store.getUsedCapacity() === 0;
  },
});
