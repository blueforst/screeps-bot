import type { RoleFactory } from "@/types/system";
import { moveToTarget } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getPlannedSourceContainerPos } from "@/runtime/roomPlannerConstruction";

export const harvesterRole: RoleFactory = (sourceId?: string) => ({
  source: (creep): boolean => {
    const source = sourceId ? Game.getObjectById(sourceId as Id<Source>) : creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (!source) {
      return false;
    }

    // Primary: MCF-keyed planned position, unique per source ID.  This prevents two
    // harvesters assigned to nearby sources from racing to the same container tile
    // when one container is within range 1 of both sources.
    // Fallback: any existing game-world container adjacent to this source, used when
    // no layout exists yet (room not yet planned / saved) so harvesters still have a
    // stable work tile rather than clustering freely around the source.
    const workPos: RoomPosition | null =
      getPlannedSourceContainerPos(source) ??
      (
        source.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: (s) => s.structureType === STRUCTURE_CONTAINER,
        }) as StructureContainer[]
      )[0]?.pos ??
      null;

    if (workPos) {
      if (!creep.pos.isEqualTo(workPos)) {
        // Do not fight for workPos when another friendly creep (e.g. the expiring
        // harvester during pre-spawn overlap) is already standing on it.  Fall
        // through to harvest in place or move toward the source instead.
        const occupants = workPos.lookFor(LOOK_CREEPS);
        if (!occupants.some((c) => (c as Creep).my)) {
          moveToTarget(creep, workPos, 0, { reusePath: 5 });
          return false;
        }
      }
    }

    const harvestCode = measureCreepIntent(() => creep.harvest(source));
    if (harvestCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, source);
    }

    return false;
  },
  target: (): boolean => false,
});
