export type { MovementOptions, MoveToRoomOptions, MoveToTargetOptions } from "@/movement/types";
export { clearMovementAnalyticsForTest, getMovementAnalytics, getMovementAnalyticsForTest } from "@/movement/metrics";
export { clearCreepMovementStateForTest, getCreepMovementState, ensureCreepMovementState } from "@/movement/creepState";
export {
  clearMovementState,
  clearRoomBaseCostMatrixCacheForTest,
  getRoomBaseCostMatrixCacheSizeForTest,
  moveToRemoteWorkTarget,
  moveToTarget,
} from "@/movement/pathing";
export { getCurrentColonizationRoute, getCurrentScoutRoute, moveToTargetRoom } from "@/movement/routing";
