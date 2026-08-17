type MovementMetricName =
  | "pathRequests"
  | "pathCacheHits"
  | "pathRepaths"
  | "yieldPushes"
  | "travelRequests"
  | "travelFallbacks"
  | "travelRepaths"
  | "multiRoomSearches"
  | "multiRoomSegmentHits"
  | "multiRoomSegmentInvalidations"
  | "exitRecoveries"
  | "stateClears";

export interface MovementMetricBucket {
  pathRequests: number;
  pathCacheHits: number;
  pathRepaths: number;
  yieldPushes: number;
  travelRequests: number;
  travelFallbacks: number;
  travelRepaths: number;
  multiRoomSearches: number;
  multiRoomSegmentHits: number;
  multiRoomSegmentInvalidations: number;
  exitRecoveries: number;
  stateClears: number;
}

export interface MovementAnalyticsSnapshot {
  version: 2;
  updatedAt: number;
  totals: MovementMetricBucket;
  rooms: Record<string, MovementMetricBucket>;
  roomUpdatedAt: Record<string, number>;
}

type RuntimeGlobalWithMovementAnalytics = typeof global & {
  __movementAnalytics?: MovementAnalyticsSnapshot;
};

const runtimeGlobal: RuntimeGlobalWithMovementAnalytics = global;
let normalizedMovementAnalytics: MovementAnalyticsSnapshot | undefined;

function createEmptyBucket(): MovementMetricBucket {
  return {
    pathRequests: 0,
    pathCacheHits: 0,
    pathRepaths: 0,
    yieldPushes: 0,
    travelRequests: 0,
    travelFallbacks: 0,
    travelRepaths: 0,
    multiRoomSearches: 0,
    multiRoomSegmentHits: 0,
    multiRoomSegmentInvalidations: 0,
    exitRecoveries: 0,
    stateClears: 0,
  };
}

function ensureMultiRoomMetricShape(bucket: MovementMetricBucket): void {
  if (!Number.isFinite(bucket.multiRoomSearches)) {
    bucket.multiRoomSearches = 0;
  }
  if (!Number.isFinite(bucket.multiRoomSegmentHits)) {
    bucket.multiRoomSegmentHits = 0;
  }
  if (!Number.isFinite(bucket.multiRoomSegmentInvalidations)) {
    bucket.multiRoomSegmentInvalidations = 0;
  }
}

function normalizeExistingMovementAnalytics(snapshot: MovementAnalyticsSnapshot): MovementAnalyticsSnapshot {
  ensureMultiRoomMetricShape(snapshot.totals);
  for (const bucket of Object.values(snapshot.rooms)) {
    ensureMultiRoomMetricShape(bucket);
  }
  if (!snapshot.roomUpdatedAt || typeof snapshot.roomUpdatedAt !== "object") {
    snapshot.roomUpdatedAt = {};
  }
  snapshot.version = 2;
  normalizedMovementAnalytics = snapshot;
  return snapshot;
}

function ensureMovementAnalytics(): MovementAnalyticsSnapshot {
  if (!runtimeGlobal.__movementAnalytics) {
    runtimeGlobal.__movementAnalytics = {
      version: 2,
      updatedAt: Game.time,
      totals: createEmptyBucket(),
      rooms: {},
      roomUpdatedAt: {},
    };
    normalizedMovementAnalytics = runtimeGlobal.__movementAnalytics;
  } else if (
    runtimeGlobal.__movementAnalytics.version !== 2 ||
    normalizedMovementAnalytics !== runtimeGlobal.__movementAnalytics
  ) {
    normalizeExistingMovementAnalytics(runtimeGlobal.__movementAnalytics);
  } else {
    ensureMultiRoomMetricShape(runtimeGlobal.__movementAnalytics.totals);
  }

  return runtimeGlobal.__movementAnalytics;
}

function ensureRoomBucket(roomName: string): MovementMetricBucket {
  const movement = ensureMovementAnalytics();
  const current = movement.rooms[roomName];
  if (current) {
    ensureMultiRoomMetricShape(current);
    return current;
  }
  const next = createEmptyBucket();
  movement.rooms[roomName] = next;
  return next;
}

export function recordMovementMetric(metric: MovementMetricName, roomName?: string, count = 1): void {
  if (!Number.isFinite(count) || count <= 0) {
    return;
  }

  const movement = ensureMovementAnalytics();
  movement.updatedAt = Game.time;
  movement.totals[metric] = Math.min(Number.MAX_SAFE_INTEGER, movement.totals[metric] + count);

  if (!roomName) {
    return;
  }

  const roomBucket = ensureRoomBucket(roomName);
  roomBucket[metric] = Math.min(Number.MAX_SAFE_INTEGER, roomBucket[metric] + count);
  movement.roomUpdatedAt[roomName] = Game.time;
}

export function getMovementAnalyticsForTest(): MovementAnalyticsSnapshot {
  return ensureMovementAnalytics();
}

export function getMovementAnalytics(): MovementAnalyticsSnapshot | undefined {
  const snapshot = runtimeGlobal.__movementAnalytics;
  if (!snapshot) {
    return undefined;
  }
  return normalizedMovementAnalytics === snapshot ? snapshot : normalizeExistingMovementAnalytics(snapshot);
}

export function clearMovementAnalyticsForTest(): void {
  delete runtimeGlobal.__movementAnalytics;
  normalizedMovementAnalytics = undefined;
}
