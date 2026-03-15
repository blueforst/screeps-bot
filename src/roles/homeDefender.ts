import { getSafeZone } from "@/runtime/safeZone";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const DANGEROUS_BODY_PARTS: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, WORK];

function getPlayerHostiles(room: Room): Creep[] {
  return room.find(FIND_HOSTILE_CREEPS, {
    filter: (creep) =>
      creep.owner.username !== "Source Keeper" &&
      (creep.owner.username !== "Invader" || creep.getActiveBodyparts(WORK) > 0) &&
      DANGEROUS_BODY_PARTS.some((part) => creep.getActiveBodyparts(part) > 0),
  });
}

function getRampartsInSafeZone(room: Room, safeZone: Set<number>): StructureRampart[] {
  return room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_RAMPART && safeZone.has(s.pos.x * 50 + s.pos.y),
  }) as StructureRampart[];
}

function findBestEngagement(
  hostiles: Creep[],
  ramparts: StructureRampart[],
): { hostile: Creep; rampart: StructureRampart } | null {
  let bestHostile: Creep | null = null;
  let bestRampart: StructureRampart | null = null;
  let bestRange = Infinity;

  for (const hostile of hostiles) {
    for (const rampart of ramparts) {
      const range = rampart.pos.getRangeTo(hostile.pos);
      if (range < bestRange) {
        bestRange = range;
        bestHostile = hostile;
        bestRampart = rampart;
      }
    }
  }

  if (!bestHostile || !bestRampart) return null;
  return { hostile: bestHostile, rampart: bestRampart };
}

export const homeDefenderRole: RoleFactory = (roomName: string) => ({
  target: (creep): boolean => {
    if (creep.room.name !== roomName) {
      creep.moveTo(new RoomPosition(25, 25, roomName), { reusePath: 5 });
      return false;
    }

    const hostiles = measureCreepDecision(() => getPlayerHostiles(creep.room));
    if (hostiles.length === 0) return false;

    const safeZone = getSafeZone(roomName);
    if (safeZone.size === 0) return false;

    const ramparts = measureCreepDecision(() => getRampartsInSafeZone(creep.room, safeZone));
    if (ramparts.length === 0) return false;

    const engagement = measureCreepDecision(() => findBestEngagement(hostiles, ramparts));
    if (!engagement) return false;

    const { hostile, rampart: targetRampart } = engagement;

    if (!creep.pos.isEqualTo(targetRampart.pos)) {
      creep.moveTo(targetRampart.pos, {
        costCallback: (_name: string, matrix: CostMatrix) => {
          for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
              if (!safeZone.has(x * 50 + y)) {
                matrix.set(x, y, 255);
              }
            }
          }
          return matrix;
        },
        reusePath: 3,
        maxRooms: 1,
      });
    }

    if (creep.pos.getRangeTo(hostile.pos) <= 1) {
      measureCreepIntent(() => creep.attack(hostile));
    }

    return false;
  },
});
