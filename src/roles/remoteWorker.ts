import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";

import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTS = { plainCost: 2, swampCost: 10, travelRange: 3 as const, reusePath: 10 };

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

function findDroppedEnergyInRoom(room: Room, sourceIds: string[]): Resource[] {
  const sourcePositions: RoomPosition[] = [];
  for (const sid of sourceIds) {
    const source = Game.getObjectById(sid as Id<Source>);
    if (source) sourcePositions.push(source.pos);
  }

  return room.find(FIND_DROPPED_RESOURCES, {
    filter: (r): r is Resource =>
      r.resourceType === RESOURCE_ENERGY &&
      r.amount > 0 &&
      sourcePositions.some((sp) => sp.getRangeTo(r.pos) <= 2),
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

type RemoteEnergyCandidate =
  | { kind: "container"; target: StructureContainer; energy: number; pos: RoomPosition }
  | { kind: "dropped"; target: Resource; energy: number; pos: RoomPosition };

function findRemoteEnergyCandidates(room: Room, sourceIds: string[]): RemoteEnergyCandidate[] {
  const containers = findSourceContainersInRoom(room, sourceIds)
    .map((container): RemoteEnergyCandidate => ({
      kind: "container",
      target: container,
      energy: container.store.getUsedCapacity(RESOURCE_ENERGY),
      pos: container.pos,
    }))
    .filter((candidate) => candidate.energy > 0);

  const droppedEnergy = findDroppedEnergyInRoom(room, sourceIds)
    .map((resource): RemoteEnergyCandidate => ({
      kind: "dropped",
      target: resource,
      energy: resource.amount,
      pos: resource.pos,
    }));

  return [...containers, ...droppedEnergy];
}

function compareRemoteEnergyCandidates(creep: Creep, a: RemoteEnergyCandidate, b: RemoteEnergyCandidate): number {
  const byEnergy = b.energy - a.energy;
  if (byEnergy !== 0) return byEnergy;
  return creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos);
}

export const remoteWorkerRole: RoleFactory = (targetRoom: string) => {
  return {
    source: (creep): boolean => {
      if (isFull(creep)) {
        return true;
      }

      if (creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, undefined, TRAVEL_OPTS);
        return false;
      }

      if (!isEmpty(creep)) {
        return true;
      }

      const sourceIds = findRemoteSourceIds(targetRoom);
      const candidates = findRemoteEnergyCandidates(creep.room, sourceIds)
        .sort((a, b) => compareRemoteEnergyCandidates(creep, a, b));
      if (candidates.length > 0) {
        const candidate = candidates[0];
        const code = candidate.kind === "container"
          ? creep.withdraw(candidate.target, RESOURCE_ENERGY)
          : creep.pickup(candidate.target);
        if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, candidate.target, 1);
        return false;
      }

      clearMovementState(creep);
      return false;
    },

    target: (creep): boolean => {
      const homeName = getHomeRoomName(creep);

      if (creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, undefined, TRAVEL_OPTS);
        return false;
      }

      if (isEmpty(creep)) {
        return true;
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
