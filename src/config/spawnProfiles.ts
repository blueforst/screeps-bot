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

export const spawnProfiles: Record<RoleName, SpawnBodyGenerator> = {
  harvester: (room) => clampByCapacity([WORK, WORK, MOVE, WORK, MOVE], room),
  carrier: (room) => clampByCapacity([CARRY, CARRY, CARRY, MOVE, MOVE], room),
  worker: oneOneOneBody,
  upgrader: oneOneOneBody,
  builder: oneOneOneBody,
};
