import type { RoleFactory } from "@/types/system";
import { moveToTarget } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";

export const harvesterRole: RoleFactory = (sourceId?: string) => ({
  source: (creep): boolean => {
    const source = sourceId ? Game.getObjectById(sourceId as Id<Source>) : creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (!source) {
      return false;
    }

    const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
    });
    if (containers.length > 0) {
      const container = containers[0] as StructureContainer;
      if (!creep.pos.isEqualTo(container.pos)) {
        moveToTarget(creep, container.pos, 0, { reusePath: 5 });
        return false;
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
