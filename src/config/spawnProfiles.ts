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

export const spawnProfiles: Record<RoleName, SpawnBodyGenerator> = {
  harvester: (room) => clampByCapacity([WORK, WORK, MOVE, WORK, MOVE], room),
  carrier: (room) => clampByCapacity([CARRY, CARRY, CARRY, MOVE, MOVE], room),
  upgrader: (room) => clampByCapacity([WORK, WORK, CARRY, MOVE], room),
  builder: (room) => clampByCapacity([WORK, CARRY, CARRY, MOVE, MOVE], room),
};
