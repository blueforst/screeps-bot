import type { RoleFactory } from "@/types/system";
import { moveToTarget } from "@/roles/shared";

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
        creep.moveTo(container.pos, { range: 0, visualizePathStyle: { stroke: "#ffaa00" } });
        return false;
      }
    }

    const harvestCode = creep.harvest(source);
    if (harvestCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, source);
    }

    return false;
  },
  target: (): boolean => false,
});
