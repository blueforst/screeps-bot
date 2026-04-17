import { getSafeZone } from "@/runtime/safeZone";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { DEFENSE_BOOST_COMPOUND } from "@/runtime/boostControl";
import { getAssignedDefenseFront, getDefenderRole, getTowerFocusFront, type DefenseFrontSummary } from "@/runtime/defenseCoordination";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { chooseBoundaryBurstEngagement, chooseInsideBurstTarget } from "@/runtime/hostilePriorities";
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

function findEngagedHostileIdByOtherDefenders(creep: Creep, hostiles: Creep[]): Id<Creep> | null {
  for (const other of creep.room.find(FIND_MY_CREEPS)) {
    if (other.name === creep.name || other.memory.role !== "homeDefender") {
      continue;
    }

    for (const hostile of hostiles) {
      if (other.pos.getRangeTo(hostile.pos) <= 1) {
        return hostile.id;
      }
    }
  }

  return null;
}

function findNearestUnoccupiedRampartToFront(
  front: DefenseFrontSummary | null,
  ramparts: StructureRampart[],
  occupiedRampartIds: Set<Id<StructureRampart>>,
): StructureRampart | null {
  let best: StructureRampart | null = null;
  let bestRange = Infinity;
  const anchor = front ? new RoomPosition(front.centroid.x, front.centroid.y, ramparts[0]?.pos.roomName || "") : null;

  for (const rampart of ramparts) {
    if (occupiedRampartIds.has(rampart.id)) {
      continue;
    }

    if (!anchor) {
      return rampart;
    }

    const range = rampart.pos.getRangeTo(anchor);
    if (range < bestRange) {
      bestRange = range;
      best = rampart;
    }
  }

  return best;
}

export const homeDefenderRole: RoleFactory = (roomName: string, slot?: string) => ({
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

    const allHostiles = measureCreepDecision(() => getPlayerHostiles(creep.room));
    const assignedFront = getAssignedDefenseFront(roomName, slot) || getTowerFocusFront(roomName);
    const defenderRole = getDefenderRole(roomName, slot);
    const hostiles = assignedFront
      ? allHostiles.filter((hostile) => assignedFront.hostileIds.includes(hostile.id))
      : allHostiles;
    if (hostiles.length === 0) return false;

    const safeZoneCostCallback = createSafeZoneCostCallback(safeZone);

    const insideHostiles = measureCreepDecision(() =>
      hostiles.filter((h) => safeZone.has(h.pos.x * 50 + h.pos.y)),
    );
    if (insideHostiles.length > 0) {
      const engagedHostileId = defenderRole === "secondary"
        ? measureCreepDecision(() => findEngagedHostileIdByOtherDefenders(creep, insideHostiles))
        : null;
      const targetPool = engagedHostileId ? insideHostiles.filter((hostile) => hostile.id !== engagedHostileId) : insideHostiles;
      const target = measureCreepDecision(() => chooseInsideBurstTarget(targetPool.length > 0 ? targetPool : insideHostiles));
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

    const occupiedRampartIds = measureCreepDecision(() => {
      const occupied = new Set<Id<StructureRampart>>();
      for (const other of creep.room.find(FIND_MY_CREEPS)) {
        if (other.name === creep.name || other.memory.role !== "homeDefender") {
          continue;
        }

        const structures = other.pos.lookFor(LOOK_STRUCTURES);
        for (const structure of structures) {
          if (structure.structureType === STRUCTURE_RAMPART && (structure as StructureRampart).my) {
            occupied.add(structure.id as Id<StructureRampart>);
          }
        }
      }
      return occupied;
    });

    const engagedHostileId = defenderRole === "secondary"
      ? measureCreepDecision(() => findEngagedHostileIdByOtherDefenders(creep, hostiles))
      : null;
    const targetHostiles = engagedHostileId ? hostiles.filter((hostile) => hostile.id !== engagedHostileId) : hostiles;
    const engagement = measureCreepDecision(() =>
      chooseBoundaryBurstEngagement(targetHostiles.length > 0 ? targetHostiles : hostiles, ramparts, occupiedRampartIds),
    );
    if (!engagement) return false;

    const { hostile, rampart: targetRampart } = engagement;

    if (defenderRole === "secondary" && targetHostiles.length === 0) {
      const coverageRampart = measureCreepDecision(() =>
        findNearestUnoccupiedRampartToFront(assignedFront, ramparts, occupiedRampartIds),
      );
      if (coverageRampart && !creep.pos.isEqualTo(coverageRampart.pos)) {
        creep.moveTo(coverageRampart.pos, {
          costCallback: safeZoneCostCallback,
          reusePath: 3,
          maxRooms: 1,
        });
        return false;
      }
    }

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
