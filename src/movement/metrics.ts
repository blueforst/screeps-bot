type MovementMetricName =
  | "pathRequests"
  | "pathCacheHits"
  | "pathRepaths"
  | "yieldPushes"
  | "travelRequests"
  | "travelFallbacks"
  | "travelRepaths"
  | "exitRecoveries"
  | "stateClears";

interface MovementMetricBucket {
  pathRequests: number;
  pathCacheHits: number;
  pathRepaths: number;
  yieldPushes: number;
  travelRequests: number;
  travelFallbacks: number;
  travelRepaths: number;
  exitRecoveries: number;
  stateClears: number;
}

function createEmptyBucket(): MovementMetricBucket {
  return {
    pathRequests: 0,
    pathCacheHits: 0,
    pathRepaths: 0,
    yieldPushes: 0,
    travelRequests: 0,
    travelFallbacks: 0,
    travelRepaths: 0,
    exitRecoveries: 0,
    stateClears: 0,
  };
}

function ensureMovementAnalytics(): NonNullable<NonNullable<Memory["analytics"]>["movement"]> {
  Memory.analytics = Memory.analytics || {};
  Memory.analytics.movement = Memory.analytics.movement || {
    updatedAt: Game.time,
    totals: createEmptyBucket(),
    rooms: {},
  };
  return Memory.analytics.movement;
}

function ensureRoomBucket(roomName: string): MovementMetricBucket {
  const movement = ensureMovementAnalytics();
  const current = movement.rooms[roomName];
  if (current) {
    return current;
  }
  const next = createEmptyBucket();
  movement.rooms[roomName] = next;
  return next;
}

export function recordMovementMetric(metric: MovementMetricName, roomName?: string, count = 1): void {
  if (count <= 0) {
    return;
  }

  const movement = ensureMovementAnalytics();
  movement.updatedAt = Game.time;
  movement.totals[metric] += count;

  if (!roomName) {
    return;
  }

  const roomBucket = ensureRoomBucket(roomName);
  roomBucket[metric] += count;
}

export function getMovementAnalyticsForTest(): NonNullable<NonNullable<Memory["analytics"]>["movement"]> {
  return ensureMovementAnalytics();
}

export function clearMovementAnalyticsForTest(): void {
  if (!Memory.analytics) {
    return;
  }
  delete Memory.analytics.movement;
}
