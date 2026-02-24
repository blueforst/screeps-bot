import type { RoleFactory } from "@/types/system";
import { moveToTarget } from "@/roles/shared";

export const harvesterRole: RoleFactory = (sourceId?: string) => ({
  source: (creep): boolean => {
    const source = sourceId ? Game.getObjectById(sourceId as Id<Source>) : creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (!source) {
      return false;
    }

    const harvestCode = creep.harvest(source);
    if (harvestCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, source);
    }

    return false;
  },
  target: (): boolean => false,
});
