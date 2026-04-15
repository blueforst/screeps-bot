import { getSafeZone } from "@/runtime/safeZone";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { DEFENSE_BOOST_COMPOUND } from "@/runtime/boostControl";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { createSafeZoneCostCallback, getBoundaryRamparts } from "@/runtime/safeZoneHelpers";
import type { RoleFactory } from "@/types/system";

function isAttackBoosted(creep: Creep): boolean {
  return creep.body.some((part) => part.type === ATTACK && !!part.boost);
}

function findBoostLab(room: Room): StructureLab | null {
  const labs = room.find(FIND_MY_STRUCTURES, {
    filter: (s): s is StructureLab =>
      s.structureType === STRUCTURE_LAB &&
      (s as StructureLab).store.getUsedCapacity(DEFENSE_BOOST_COMPOUND) >= LAB_BOOST_MINERAL,
  });
  return labs[0] ?? null;
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

    const safeZone = getSafeZone(roomName);
    if (safeZone.size === 0) return false;

    // Boost phase: seek lab before engaging if boost compound is available
    if (!isAttackBoosted(creep)) {
      const lab = measureCreepDecision(() => findBoostLab(creep.room));
      if (lab) {
        if (!creep.pos.isNearTo(lab)) {
          creep.moveTo(lab, {
            costCallback: createSafeZoneCostCallback(safeZone),
            reusePath: 3,
            maxRooms: 1,
          });
        } else {
          measureCreepIntent(() => lab.boostCreep(creep));
        }
        return false;
      }
    }

    const hostiles = measureCreepDecision(() => getPlayerHostiles(creep.room));
    if (hostiles.length === 0) return false;

    const safeZoneCostCallback = createSafeZoneCostCallback(safeZone);

    const insideHostiles = measureCreepDecision(() =>
      hostiles.filter((h) => safeZone.has(h.pos.x * 50 + h.pos.y)),
    );
    if (insideHostiles.length > 0) {
      const target = creep.pos.findClosestByRange(insideHostiles);
      if (!target) return false;
      if (creep.pos.getRangeTo(target) <= 1) {
        measureCreepIntent(() => creep.attack(target));
      } else {
        creep.moveTo(target, { costCallback: safeZoneCostCallback, reusePath: 2, maxRooms: 1 });
      }
      return false;
    }

    // Hostiles are outside the perimeter — position at the boundary rampart closest to them
    const ramparts = measureCreepDecision(() => getBoundaryRamparts(creep.room, safeZone));
    if (ramparts.length === 0) return false;

    const engagement = measureCreepDecision(() => findBestEngagement(hostiles, ramparts));
    if (!engagement) return false;

    const { hostile, rampart: targetRampart } = engagement;

    if (!creep.pos.isEqualTo(targetRampart.pos)) {
      creep.moveTo(targetRampart.pos, {
        costCallback: safeZoneCostCallback,
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
