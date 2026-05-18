import type { RoleName } from "@/types/system";
import {
  POWER_BANK_BODY_RCL6,
  POWER_BANK_BODY_RCL7,
  POWER_BANK_BODY_RCL8,
} from "@/runtime/powerBankConstants";

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

const FIXED_MINER_BODY: BodyPartConstant[] = [WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE];
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

export function getHarvesterBody(room: Room): BodyPartConstant[] {
  const fixedBodyCost = FIXED_MINER_BODY.reduce((sum, part) => sum + BODYPART_COST[part], 0);
  if (room.energyCapacityAvailable >= fixedBodyCost) {
    return [...FIXED_MINER_BODY];
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

function homeDefenderBody(room: Room): BodyPartConstant[] {
  const unitCost = BODYPART_COST[ATTACK] + BODYPART_COST[MOVE];
  const unitCount = Math.max(1, Math.min(25, Math.floor(room.energyCapacityAvailable / unitCost)));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < unitCount; i++) {
    parts.push(ATTACK, MOVE);
  }

  return clampByCapacity(parts, room);
}

function meleeAttackBody(room: Room): BodyPartConstant[] {
  const unitCost = BODYPART_COST[TOUGH] + BODYPART_COST[ATTACK] + BODYPART_COST[MOVE] * 2;
  const unitCount = Math.max(1, Math.min(10, Math.floor(room.energyCapacityAvailable / unitCost)));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < unitCount; i++) {
    parts.push(TOUGH, ATTACK, MOVE, MOVE);
  }

  return clampByCapacity(parts, room);
}

function healerBody(room: Room): BodyPartConstant[] {
  const pairCost = BODYPART_COST[HEAL] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(8, Math.floor(room.energyCapacityAvailable / pairCost)));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < pairCount; i++) {
    parts.push(HEAL, MOVE);
  }

  return clampByCapacity(parts, room);
}

function powerBankScoutBody(): BodyPartConstant[] {
  return [MOVE];
}

function powerBankAttackerBody(room: Room): BodyPartConstant[] {
  const rcl = room.controller?.level ?? 0;
  if (rcl >= 8) return [...POWER_BANK_BODY_RCL8.attacker];
  if (rcl >= 7) return [...POWER_BANK_BODY_RCL7.attacker];
  return [...POWER_BANK_BODY_RCL6.attacker];
}

function powerBankHealerBody(room: Room): BodyPartConstant[] {
  const rcl = room.controller?.level ?? 0;
  if (rcl >= 8) return [...POWER_BANK_BODY_RCL8.healer];
  if (rcl >= 7) return [...POWER_BANK_BODY_RCL7.healer];
  return [...POWER_BANK_BODY_RCL6.healer];
}

function powerBankHaulerBody(room: Room): BodyPartConstant[] {
  const pairCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(25, Math.floor(room.energyCapacityAvailable / pairCost)));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < pairCount; i++) {
    parts.push(CARRY, MOVE);
  }

  return clampByCapacity(parts, room);
}

export const spawnProfiles: Record<RoleName, SpawnBodyGenerator> = {
  harvester: (room) => getHarvesterBody(room),
  mineralHarvester: twoToOneWorkMoveBody,
  miner: () => [...LINK_MINER_BODY],
  carrier: carryMoveBody,
  worker: oneOneOneBody,
  scout: () => [MOVE],
  claimer: () => [CLAIM, MOVE],
  colonizerHarvester: () => [...COLONIZER_HARVESTER_BODY],
  colonizerWorker: oneOneOneBody,
  meleeAttacker: meleeAttackBody,
  healer: healerBody,
  homeDefender: homeDefenderBody,
  crossShardClaimer: () => [CLAIM, MOVE],
  crossShardColonizerHarvester: () => [...COLONIZER_HARVESTER_BODY],
  crossShardColonizerWorker: oneOneOneBody,
  flagScout: () => [MOVE],
  remoteCarrier: carryMoveBody,
  powerBankScout: powerBankScoutBody,
  powerBankAttacker: powerBankAttackerBody,
  powerBankHealer: powerBankHealerBody,
  powerBankHauler: powerBankHaulerBody,
};
