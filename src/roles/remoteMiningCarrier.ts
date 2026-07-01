import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getMyUsername } from "@/runtime/remoteMining";

import type { RoleFactory } from "@/types/system";

const MAINTENANCE_RESERVE_ENERGY = 100;
const MAINTAINABLE_TYPES = new Set<string>([STRUCTURE_ROAD, STRUCTURE_CONTAINER]);

function getHomeRoomName(creep: Creep): string {
  return creep.memory.configName?.split(":")[0] || creep.room.name;
}

function isRemoteSuspendedOrDangerous(targetRoom: string): boolean {
  const remoteTask = Memory.data?.remoteMining?.[targetRoom];
  if (remoteTask?.status === "suspended") {
    return true;
  }
  const visibleRoom = Game.rooms[targetRoom];
  if (visibleRoom && !isRemoteRoomVisibleSafe(visibleRoom)) {
    return true;
  }
  return false;
}

function isRemoteRoomVisibleSafe(room: Room): boolean {
  const controller = room.controller;
  if (controller?.owner && !controller.my) return false;
  if (controller?.reservation && controller.reservation.username !== getMyUsername()) return false;

  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  if (hostiles.length > 0) {
    const dangerousParts: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, HEAL];
    for (const creep of hostiles) {
      for (const part of dangerousParts) {
        if (typeof creep.getActiveBodyparts === "function") {
          if (creep.getActiveBodyparts(part) > 0) return false;
        } else if (creep.body && Array.isArray(creep.body)) {
          if (creep.body.some((bp: BodyPartDefinition) => bp.type === part && bp.hits > 0)) return false;
        }
      }
    }
  }

  const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (s) => s.structureType !== STRUCTURE_CONTROLLER,
  });
  if (hostileStructures.length > 0) return false;

  const keeperLairs = room.find(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_KEEPER_LAIR,
  });
  if (keeperLairs.length > 0) return false;

  return true;
}

function getCarriedEnergy(creep: Creep): number {
  return creep.store.getUsedCapacity(RESOURCE_ENERGY);
}

function getFreeCapacity(creep: Creep): number {
  return creep.store.getFreeCapacity(RESOURCE_ENERGY);
}

function isFull(creep: Creep): boolean {
  return getFreeCapacity(creep) <= 0;
}

function isEmpty(creep: Creep): boolean {
  return getCarriedEnergy(creep) === 0;
}

function retireIfLowTtl(creep: Creep): void {
  if (typeof creep.ticksToLive === "number" && creep.ticksToLive < 150) {
    if (typeof creep.suicide === "function") {
      creep.suicide();
    }
  }
}

function findSourceContainer(room: Room, sourcePos: RoomPosition): StructureContainer | null {
  const containers = room.find(FIND_STRUCTURES, {
    filter: (s): s is StructureContainer =>
      s.structureType === STRUCTURE_CONTAINER && sourcePos.getRangeTo(s.pos) <= 2,
  });
  return containers[0] || null;
}

function findSourceContainerSite(room: Room, sourcePos: RoomPosition): ConstructionSite | null {
  const sites = room.find(FIND_CONSTRUCTION_SITES, {
    filter: (s): s is ConstructionSite =>
      s.my &&
      s.structureType === STRUCTURE_CONTAINER &&
      sourcePos.getRangeTo(s.pos) <= 2,
  });
  return sites[0] || null;
}

function findDroppedEnergyNear(room: Room, pos: RoomPosition): Resource | null {
  const resources = room.find(FIND_DROPPED_RESOURCES, {
    filter: (r): r is Resource =>
      r.resourceType === RESOURCE_ENERGY && r.amount > 0 && pos.getRangeTo(r.pos) <= 2,
  });
  return resources[0] || null;
}


interface SourceEnergyTarget {
  sourceId: string;
  sourcePos: RoomPosition;
  container: StructureContainer | null;
  dropped: Resource | null;
  energy: number;
}

function selectBestSourceTarget(room: Room, targetRoom: string): { sourceId: string; sourcePos: RoomPosition; container: StructureContainer | null; dropped: Resource | null } | null {
  const sourceIds: string[] = Memory.data?.remoteMining?.[targetRoom]?.sourceIds ?? [];
  if (sourceIds.length === 0) return null;

  const candidates: SourceEnergyTarget[] = [];
  for (const sourceId of sourceIds) {
    const source = Game.getObjectById(sourceId as Id<Source>);
    if (!source) continue;
    const container = findSourceContainer(room, source.pos);
    const dropped = findDroppedEnergyNear(room, source.pos);
    const containerEnergy = container?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
    const droppedEnergy = dropped?.amount ?? 0;
    const totalEnergy = containerEnergy + droppedEnergy;
    candidates.push({ sourceId, sourcePos: source.pos, container, dropped, energy: totalEnergy });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.energy - a.energy);
  return candidates[0];
}

/** Build the source container construction site near the assigned source.
 *  Only builds when the carrier has surplus energy (above reserve) and a WORK part.
 *  Returns true if a build intent was issued. */
function buildSourceContainerSite(creep: Creep, sourcePos: RoomPosition): boolean {
  const surplus = getCarriedEnergy(creep) - MAINTENANCE_RESERVE_ENERGY;
  if (surplus <= 0) return false;

  const workParts = creep.getActiveBodyparts(WORK);
  if (workParts <= 0) return false;

  const site = findSourceContainerSite(creep.room, sourcePos);
  if (!site) return false;

  const range = creep.pos.getRangeTo(site.pos);
  if (range > 3) return false;

  const code = measureCreepIntent(() => creep.build(site));
  return code === OK;
}

/** One maintenance intent per tick: repair roads/containers or build road/container sites within range 3.
 *  Never spends below MAINTENANCE_RESERVE_ENERGY. Returns true if an intent was issued. */
function runMaintenance(creep: Creep): boolean {
  const surplus = getCarriedEnergy(creep) - MAINTENANCE_RESERVE_ENERGY;
  if (surplus <= 0) {
    return false;
  }

  const workParts = creep.getActiveBodyparts(WORK);
  if (workParts <= 0) {
    return false;
  }

  const pos = creep.pos;

  const repairTargets = creep.room.find(FIND_STRUCTURES, {
    filter: (s): s is StructureRoad | StructureContainer =>
      MAINTAINABLE_TYPES.has(s.structureType) &&
      s.hits < s.hitsMax &&
      pos.getRangeTo(s.pos) <= 3,
  });
  if (repairTargets.length > 0) {
    repairTargets.sort((a, b) => a.hits - b.hits);
    const code = measureCreepIntent(() => creep.repair(repairTargets[0]));
    if (code === OK) {
      return true;
    }
  }

  const buildTargets = creep.room.find(FIND_CONSTRUCTION_SITES, {
    filter: (s): s is ConstructionSite =>
      s.my &&
      MAINTAINABLE_TYPES.has(s.structureType) &&
      pos.getRangeTo(s.pos) <= 3,
  });
  if (buildTargets.length > 0) {
    const code = measureCreepIntent(() => creep.build(buildTargets[0]));
    if (code === OK) {
      return true;
    }
  }

  return false;
}

/** Get delivery target: terminal first, then storage. */
function getDeliveryTarget(homeRoomName: string): AnyStoreStructure | null {
  const homeRoom = Game.rooms[homeRoomName];
  if (!homeRoom) {
    return null;
  }

  if (homeRoom.terminal && homeRoom.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    return homeRoom.terminal;
  }

  if (homeRoom.storage && homeRoom.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    return homeRoom.storage;
  }

  return null;
}

export const remoteMiningCarrierRole: RoleFactory = (targetRoom: string, sourceId?: string) => {
  return {
    source: (creep): boolean => {
      const homeRoomName = getHomeRoomName(creep);

      if (isRemoteSuspendedOrDangerous(targetRoom)) {
        if (creep.room.name !== homeRoomName) {
          moveToTargetRoom(creep, homeRoomName, undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
        }
        return false;
      }

      if (isFull(creep)) {
        delete creep.memory._rmcSelectedSource;
        return true;
      }

      if (creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
        if (getCarriedEnergy(creep) > MAINTENANCE_RESERVE_ENERGY) {
          runMaintenance(creep);
        }
        return false;
      }

      let resolvedSourcePos: RoomPosition | null = null;
      let resolvedContainer: StructureContainer | null = null;
      let resolvedDropped: Resource | null = null;

      if (sourceId) {
        const source = Game.getObjectById(sourceId as Id<Source>);
        resolvedSourcePos = source?.pos || creep.pos;
        resolvedContainer = source ? findSourceContainer(creep.room, source.pos) : null;
      } else {
        const best = selectBestSourceTarget(creep.room, targetRoom);
        if (best) {
          creep.memory._rmcSelectedSource = best.sourceId;
          resolvedSourcePos = best.sourcePos;
          resolvedContainer = best.container;
          resolvedDropped = best.dropped;
        } else {
          resolvedSourcePos = creep.pos;
        }
      }

      const sourcePos = resolvedSourcePos || creep.pos;
      const container = resolvedContainer;

      if (container) {
        const containerEnergy = container.store.getUsedCapacity(RESOURCE_ENERGY);

        if (containerEnergy > 0) {
          const code = measureCreepIntent(() => creep.withdraw(container, RESOURCE_ENERGY));
          if (code === ERR_NOT_IN_RANGE) {
            moveToTarget(creep, container, 1);
            if (getCarriedEnergy(creep) > MAINTENANCE_RESERVE_ENERGY) {
              runMaintenance(creep);
            }
            return false;
          }
          if (code === OK) {
            if (getCarriedEnergy(creep) > MAINTENANCE_RESERVE_ENERGY) {
              runMaintenance(creep);
            }
            return true;
          }
        }
      }

      const containerSite = findSourceContainerSite(creep.room, sourcePos);

      if (buildSourceContainerSite(creep, sourcePos)) {
        return true;
      }

      const dropPos = container?.pos || containerSite?.pos || sourcePos;
      const dropped = resolvedDropped ?? findDroppedEnergyNear(creep.room, dropPos);
      if (dropped) {
        const code = measureCreepIntent(() => creep.pickup(dropped));
        if (code === ERR_NOT_IN_RANGE) {
          moveToTarget(creep, dropped, 1);
          return false;
        }
        if (code === OK) {
          return true;
        }
      }

      if (getCarriedEnergy(creep) > 0) {
        return true;
      }

      if (containerSite && creep.pos.getRangeTo(containerSite.pos) > 3) {
        moveToTarget(creep, containerSite.pos, 2);
      } else if (creep.pos.getRangeTo(sourcePos) > 3) {
        moveToTarget(creep, sourcePos, 3);
      }

      if (getCarriedEnergy(creep) > MAINTENANCE_RESERVE_ENERGY) {
        runMaintenance(creep);
      }

      return false;
    },

    target: (creep): boolean => {
      const homeRoomName = getHomeRoomName(creep);
      const suspended = isRemoteSuspendedOrDangerous(targetRoom);

      if (isEmpty(creep)) {
        if (suspended) {
          if (creep.room.name !== homeRoomName) {
            moveToTargetRoom(creep, homeRoomName, undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
          }
          return false;
        }
        if (creep.room.name === homeRoomName) {
          retireIfLowTtl(creep);
        }
        return true;
      }

      if (suspended && creep.room.name !== homeRoomName) {
        moveToTargetRoom(creep, homeRoomName, undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
        return false;
      }

      if (!suspended && creep.room.name !== homeRoomName) {
        moveToTargetRoom(creep, homeRoomName, undefined, { plainCost: 2, swampCost: 10, travelRange: 3, reusePath: 10 });
        if (getCarriedEnergy(creep) > MAINTENANCE_RESERVE_ENERGY) {
          runMaintenance(creep);
        }
        return false;
      }

      const target = measureCreepDecision(() => getDeliveryTarget(homeRoomName));
      if (!target) {
        return false;
      }

      const code = measureCreepIntent(() => creep.transfer(target, RESOURCE_ENERGY));
      if (code === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, target, 1);
        return false;
      }

      if (isEmpty(creep)) {
        retireIfLowTtl(creep);
      }

      return isEmpty(creep);
    },
  };
};
