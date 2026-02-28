import type { RoleName } from "@/types/system";

type SpawnBodyGenerator = (room: Room) => BodyPartConstant[];

function clampByCapacity(parts: BodyPartConstant[], room: Room): BodyPartConstant[] {
  const result: BodyPartConstant[] = [];
  let total = 0;

  for (const part of parts) {
    const cost = BODYPART_COST[part];
    if (total + cost > room.energyCapacityAvailable) {
      break;
    }
    total += cost;
    result.push(part);
  }

  return result.length > 0 ? result : [WORK, CARRY, MOVE];
}

function oneOneOneBody(room: Room): BodyPartConstant[] {
  const tripletCost = BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const tripletCount = Math.max(1, Math.floor(room.energyCapacityAvailable / tripletCost));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < tripletCount; i++) {
    parts.push(WORK, CARRY, MOVE);
  }

  return clampByCapacity(parts, room);
}

function twoToOneWorkMoveBody(room: Room): BodyPartConstant[] {
  const unitCost = BODYPART_COST[WORK] * 2 + BODYPART_COST[MOVE];
  const unitCount = Math.max(1, Math.floor(room.energyCapacityAvailable / unitCost));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < unitCount; i++) {
    parts.push(WORK, WORK, MOVE);
  }

  return clampByCapacity(parts, room);
}

const FIXED_MINER_BODY: BodyPartConstant[] = [WORK, WORK, WORK, WORK, WORK, MOVE, MOVE];
const LINK_MINER_BODY: BodyPartConstant[] = [
  WORK,
  WORK,
  WORK,
  WORK,
  WORK,
  WORK,
  CARRY,
  CARRY,
  CARRY,
  CARRY,
  CARRY,
  CARRY,
  MOVE,
  MOVE,
  MOVE,
];
const COLONIZER_HARVESTER_BODY: BodyPartConstant[] = [
  WORK,
  WORK,
  WORK,
  WORK,
  WORK,
  MOVE,
  MOVE,
  MOVE,
  MOVE,
  MOVE,
];

function hasContainerNearSource(sourceId?: string): boolean {
  if (!sourceId) {
    return false;
  }

  const source = Game.getObjectById(sourceId as Id<Source>);
  if (!source) {
    return false;
  }

  const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
  });

  return containers.length > 0;
}

export function getHarvesterBody(room: Room, sourceId?: string): BodyPartConstant[] {
  if (hasContainerNearSource(sourceId)) {
    const fixedBodyCost = FIXED_MINER_BODY.reduce((sum, part) => sum + BODYPART_COST[part], 0);
    if (room.energyCapacityAvailable >= fixedBodyCost) {
      return [...FIXED_MINER_BODY];
    }
  }

  return twoToOneWorkMoveBody(room);
}

function carryMoveBody(room: Room): BodyPartConstant[] {
  const pairCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(16, Math.floor(room.energyCapacityAvailable / pairCost)));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < pairCount; i++) {
    parts.push(CARRY, MOVE);
  }

  return clampByCapacity(parts, room);
}

export const spawnProfiles: Record<RoleName, SpawnBodyGenerator> = {
  harvester: (room) => getHarvesterBody(room),
  miner: () => [...LINK_MINER_BODY],
  carrier: carryMoveBody,
  worker: oneOneOneBody,
  scout: () => [MOVE],
  claimer: () => [CLAIM, MOVE],
  colonizerHarvester: () => [...COLONIZER_HARVESTER_BODY],
  colonizerWorker: oneOneOneBody,
};
