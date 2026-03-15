export type { MovementOptions, MoveToRoomOptions, MoveToTargetOptions } from "@/movement/types";
export { clearMovementAnalyticsForTest, getMovementAnalyticsForTest } from "@/movement/metrics";
export {
  clearMovementState,
  clearRoomBaseCostMatrixCacheForTest,
  getRoomBaseCostMatrixCacheSizeForTest,
  moveToRemoteWorkTarget,
  moveToTarget,
} from "@/movement/pathing";
export { getCurrentColonizationRoute, getCurrentScoutRoute, moveToTargetRoom } from "@/movement/routing";
