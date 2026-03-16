import { getCpuPhaseHistory } from "@/runtime/cpuPhaseProfiler";
import { getTickContextService } from "@/runtime/runtimeServices";

const DEFAULT_SAMPLE_INTERVAL = 10;
const MIN_SAMPLE_INTERVAL = 5;
const MAX_SAMPLE_INTERVAL = 100;
const DEFAULT_SEGMENT_ID = 90;
const MAX_SEGMENT_PAYLOAD_BYTES = 95_000;

interface RoomCreepTelemetry {
  workerCount: number;
  carrierCount: number;
  harvesterCount: number;
  unassignedWorkers: number;
  carrierStuckTotal: number;
  carrierStuckCount: number;
}

interface RoomTaskTelemetry {
  buildTasks: number;
  repairTasks: number;
  upgradeTasks: number;
}

interface RoomSpawnTelemetry {
  queueDepth: number;
  spawningCount: number;
}

interface ExternalTelemetryRoomSnapshot {
  roomName: string;
  controllerLevel: number;
  controllerProgress: number;
  energyAvailable: number;
  energyCapacity: number;
  workerCount: number;
  carrierCount: number;
  harvesterCount: number;
  unassignedWorkers: number;
  avgCarrierStuckTicks: number;
  taskQueueDepth: number;
  buildTasks: number;
  repairTasks: number;
  upgradeTasks: number;
  spawnQueueDepth: number;
  spawnSpawning: number;
  productionUpdatedAt?: number;
  productionSignal?: {
    looseEnergyTrend: number;
    sourceEnergyTrend: number;
    upgradeRate: number;
    spawnBusy: number;
  };
  movement?: {
    pathRequests: number;
    pathCacheHits: number;
    pathRepaths: number;
    yieldPushes: number;
    travelRequests: number;
    travelFallbacks: number;
    travelRepaths: number;
    exitRecoveries: number;
    stateClears: number;
  };
}

interface ExternalTelemetrySnapshot {
  version: 1;
  tick: number;
  shard: string;
  sampleInterval: number;
  segmentId: number;
  cpu: {
    used: number;
    bucket: number;
    limit: number;
    tickLimit: number;
  };
  gcl: {
    level: number;
    progress: number;
    progressTotal: number;
  };
  totals: {
    rooms: number;
    workers: number;
    carriers: number;
    harvesters: number;
    unassignedWorkers: number;
    taskQueueDepth: number;
    spawnQueueDepth: number;
    activeSpawns: number;
    movement?: {
      pathRequests: number;
      pathCacheHits: number;
      pathRepaths: number;
      yieldPushes: number;
      travelRequests: number;
      travelFallbacks: number;
      travelRepaths: number;
      exitRecoveries: number;
      stateClears: number;
    };
  };
  moduleCpu?: {
    tick: number;
    shard: string;
    totalUsed: number;
    bucket: number;
    limit: number;
    tickLimit: number;
    phases: Record<string, number>;
    untracked: number;
    history?: Array<{
      tick: number;
      shard: string;
      totalUsed: number;
      bucket: number;
      limit: number;
      tickLimit: number;
      phases: Record<string, number>;
      untracked: number;
    }>;
  };
  rooms: ExternalTelemetryRoomSnapshot[];
  truncated?: boolean;
}

type ModuleCpuSnapshot = NonNullable<ExternalTelemetrySnapshot["moduleCpu"]>;

function toValidSampleInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SAMPLE_INTERVAL;
  }
  const normalized = Math.floor(value);
  return Math.max(MIN_SAMPLE_INTERVAL, Math.min(MAX_SAMPLE_INTERVAL, normalized));
}

function toValidSegmentId(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SEGMENT_ID;
  }
  const normalized = Math.floor(value);
  return Math.max(0, Math.min(99, normalized));
}

function ensureRoomCreepTelemetry(
  stats: Record<string, RoomCreepTelemetry>,
  roomName: string,
): RoomCreepTelemetry {
  const current = stats[roomName];
  if (current) {
    return current;
  }

  const next: RoomCreepTelemetry = {
    workerCount: 0,
    carrierCount: 0,
    harvesterCount: 0,
    unassignedWorkers: 0,
    carrierStuckTotal: 0,
    carrierStuckCount: 0,
  };
  stats[roomName] = next;
  return next;
}

function ensureRoomTaskTelemetry(stats: Record<string, RoomTaskTelemetry>, roomName: string): RoomTaskTelemetry {
  const current = stats[roomName];
  if (current) {
    return current;
  }

  const next: RoomTaskTelemetry = {
    buildTasks: 0,
    repairTasks: 0,
    upgradeTasks: 0,
  };
  stats[roomName] = next;
  return next;
}

function ensureRoomSpawnTelemetry(
  stats: Record<string, RoomSpawnTelemetry>,
  roomName: string,
): RoomSpawnTelemetry {
  const current = stats[roomName];
  if (current) {
    return current;
  }

  const next: RoomSpawnTelemetry = {
    queueDepth: 0,
    spawningCount: 0,
  };
  stats[roomName] = next;
  return next;
}

function collectCreepTelemetryByRoom(ownedRooms: Room[]): Record<string, RoomCreepTelemetry> {
  const stats: Record<string, RoomCreepTelemetry> = {};
  const tickContext = getTickContextService();

  for (const room of ownedRooms) {
    for (const creep of tickContext.getCreepsByRoom(room.name)) {
      const roomStats = ensureRoomCreepTelemetry(stats, creep.room.name);
      const role = creep.memory.role;

      if (role === "worker") {
        roomStats.workerCount += 1;
        if (!creep.memory.taskId) {
          roomStats.unassignedWorkers += 1;
        }
        continue;
      }

      if (role === "carrier") {
        roomStats.carrierCount += 1;
        const stuckTicks = creep.memory.travelState?.stuckTicks;
        if (typeof stuckTicks === "number" && Number.isFinite(stuckTicks) && stuckTicks >= 0) {
          roomStats.carrierStuckTotal += stuckTicks;
          roomStats.carrierStuckCount += 1;
        }
        continue;
      }

      if (role === "harvester") {
        roomStats.harvesterCount += 1;
      }
    }
  }

  return stats;
}

function collectTaskTelemetryByRoom(): Record<string, RoomTaskTelemetry> {
  const stats: Record<string, RoomTaskTelemetry> = {};
  const memoryRooms = Memory.rooms || {};

  for (const [roomName, roomMemory] of Object.entries(memoryRooms)) {
    const tasks = roomMemory.tasks;
    if (!tasks) {
      continue;
    }

    const roomStats = ensureRoomTaskTelemetry(stats, roomName);
    for (const task of Object.values(tasks)) {
      if (task.type === "build") {
        roomStats.buildTasks += 1;
        continue;
      }
      if (task.type === "repair") {
        roomStats.repairTasks += 1;
        continue;
      }
      if (task.type === "upgrade") {
        roomStats.upgradeTasks += 1;
      }
    }
  }

  return stats;
}

function collectSpawnTelemetryByRoom(ownedRooms: Room[]): Record<string, RoomSpawnTelemetry> {
  const stats: Record<string, RoomSpawnTelemetry> = {};
  const tickContext = getTickContextService();

  for (const room of ownedRooms) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      const roomStats = ensureRoomSpawnTelemetry(stats, spawn.room.name);
      roomStats.queueDepth += spawn.memory.spawnList?.length || 0;
      if (spawn.spawning) {
        roomStats.spawningCount += 1;
      }
    }
  }

  return stats;
}

function getOwnedRooms(): Room[] {
  return getTickContextService().getMyRooms();
}

function buildTelemetrySnapshot(sampleInterval: number, segmentId: number): ExternalTelemetrySnapshot {
  const ownedRooms = getOwnedRooms();
  const creepsByRoom = collectCreepTelemetryByRoom(ownedRooms);
  const tasksByRoom = collectTaskTelemetryByRoom();
  const spawnsByRoom = collectSpawnTelemetryByRoom(ownedRooms);
  const productionRooms = Memory.analytics?.production?.rooms || {};
  const moduleCpuLatest = Memory.analytics?.moduleCpu?.latest;
  const moduleCpuHistory = getCpuPhaseHistory();
  const movementAnalytics = Memory.analytics?.movement;

  const rooms: ExternalTelemetryRoomSnapshot[] = [];
  let totalWorkers = 0;
  let totalCarriers = 0;
  let totalHarvesters = 0;
  let totalUnassignedWorkers = 0;
  let totalTaskQueueDepth = 0;
  let totalSpawnQueueDepth = 0;
  let totalActiveSpawns = 0;

  for (const room of ownedRooms) {
    const roomName = room.name;
    const creepStats =
      creepsByRoom[roomName] ||
      ({
        workerCount: 0,
        carrierCount: 0,
        harvesterCount: 0,
        unassignedWorkers: 0,
        carrierStuckTotal: 0,
        carrierStuckCount: 0,
      } satisfies RoomCreepTelemetry);
    const taskStats =
      tasksByRoom[roomName] ||
      ({
        buildTasks: 0,
        repairTasks: 0,
        upgradeTasks: 0,
      } satisfies RoomTaskTelemetry);
    const spawnStats =
      spawnsByRoom[roomName] ||
      ({
        queueDepth: 0,
        spawningCount: 0,
      } satisfies RoomSpawnTelemetry);
    const taskQueueDepth = taskStats.buildTasks + taskStats.repairTasks + taskStats.upgradeTasks;
    const avgCarrierStuckTicks =
      creepStats.carrierStuckCount > 0 ? creepStats.carrierStuckTotal / creepStats.carrierStuckCount : 0;
    const productionRoom = productionRooms[roomName];
    const movementRoom = movementAnalytics?.rooms[roomName];

    totalWorkers += creepStats.workerCount;
    totalCarriers += creepStats.carrierCount;
    totalHarvesters += creepStats.harvesterCount;
    totalUnassignedWorkers += creepStats.unassignedWorkers;
    totalTaskQueueDepth += taskQueueDepth;
    totalSpawnQueueDepth += spawnStats.queueDepth;
    totalActiveSpawns += spawnStats.spawningCount;

    rooms.push({
      roomName,
      controllerLevel: room.controller?.level || 0,
      controllerProgress: room.controller?.progress || 0,
      energyAvailable: room.energyAvailable,
      energyCapacity: room.energyCapacityAvailable,
      workerCount: creepStats.workerCount,
      carrierCount: creepStats.carrierCount,
      harvesterCount: creepStats.harvesterCount,
      unassignedWorkers: creepStats.unassignedWorkers,
      avgCarrierStuckTicks,
      taskQueueDepth,
      buildTasks: taskStats.buildTasks,
      repairTasks: taskStats.repairTasks,
      upgradeTasks: taskStats.upgradeTasks,
      spawnQueueDepth: spawnStats.queueDepth,
      spawnSpawning: spawnStats.spawningCount,
      productionUpdatedAt: productionRoom?.updatedAt,
      productionSignal: productionRoom?.signal,
      movement: movementRoom,
    });
  }

  return {
    version: 1,
    tick: Game.time,
    shard: Game.shard.name,
    sampleInterval,
    segmentId,
    cpu: {
      used: Game.cpu.getUsed(),
      bucket: Game.cpu.bucket,
      limit: Game.cpu.limit,
      tickLimit: Game.cpu.tickLimit,
    },
    gcl: {
      level: Game.gcl.level,
      progress: Game.gcl.progress,
      progressTotal: Game.gcl.progressTotal,
    },
    totals: {
      rooms: rooms.length,
      workers: totalWorkers,
      carriers: totalCarriers,
      harvesters: totalHarvesters,
      unassignedWorkers: totalUnassignedWorkers,
      taskQueueDepth: totalTaskQueueDepth,
      spawnQueueDepth: totalSpawnQueueDepth,
      activeSpawns: totalActiveSpawns,
      movement: movementAnalytics?.totals,
    },
    moduleCpu: moduleCpuLatest
      ? {
          tick: moduleCpuLatest.tick,
          shard: moduleCpuLatest.shard,
          totalUsed: moduleCpuLatest.totalUsed,
          bucket: moduleCpuLatest.bucket,
          limit: moduleCpuLatest.limit,
          tickLimit: moduleCpuLatest.tickLimit,
          phases: moduleCpuLatest.phases,
          untracked: moduleCpuLatest.untracked,
          history: moduleCpuHistory.slice(-20).map((entry) => ({
            tick: entry.tick,
            shard: entry.shard,
            totalUsed: entry.totalUsed,
            bucket: entry.bucket,
            limit: entry.limit,
            tickLimit: entry.tickLimit,
            phases: entry.phases,
            untracked: entry.untracked,
          })),
        }
      : undefined,
    rooms,
  };
}

function compactPhaseMap(phases: Record<string, number>, limit: number): Record<string, number> {
  const compact: Record<string, number> = {};
  const sorted = Object.entries(phases)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
  for (const [key, value] of sorted) {
    compact[key] = value;
  }

  return compact;
}

function compactModuleCpu(moduleCpu: ModuleCpuSnapshot | undefined, historyLimit: number): ModuleCpuSnapshot | undefined {
  if (!moduleCpu) {
    return undefined;
  }

  return {
    ...moduleCpu,
    phases: compactPhaseMap(moduleCpu.phases, 8),
    history: (moduleCpu.history || []).slice(-historyLimit).map((entry) => ({
      ...entry,
      phases: compactPhaseMap(entry.phases, 5),
    })),
  };
}

function serializeSnapshot(snapshot: ExternalTelemetrySnapshot): string {
  const fullPayload = JSON.stringify(snapshot);
  if (fullPayload.length <= MAX_SEGMENT_PAYLOAD_BYTES) {
    return fullPayload;
  }

  const compactRooms = snapshot.rooms.slice(0, 20).map((room) => ({
    roomName: room.roomName,
    controllerLevel: room.controllerLevel,
    workerCount: room.workerCount,
    carrierCount: room.carrierCount,
    taskQueueDepth: room.taskQueueDepth,
    spawnQueueDepth: room.spawnQueueDepth,
  }));

  const compactPayload = JSON.stringify({
    ...snapshot,
    truncated: true,
    moduleCpu: compactModuleCpu(snapshot.moduleCpu, 20),
    rooms: compactRooms,
  });

  if (compactPayload.length <= MAX_SEGMENT_PAYLOAD_BYTES) {
    return compactPayload;
  }

  return JSON.stringify({
    version: snapshot.version,
    tick: snapshot.tick,
    shard: snapshot.shard,
    sampleInterval: snapshot.sampleInterval,
    segmentId: snapshot.segmentId,
    cpu: snapshot.cpu,
    gcl: snapshot.gcl,
    totals: snapshot.totals,
    moduleCpu: compactModuleCpu(snapshot.moduleCpu, 5),
    rooms: [],
    truncated: true,
  } satisfies ExternalTelemetrySnapshot);
}

export function runExternalTelemetryExport(): void {
  const cfg = Memory.cfg?.telemetry;
  if (!cfg?.enabled) {
    return;
  }

  const sampleInterval = toValidSampleInterval(cfg.sampleInterval);
  if (Game.time % sampleInterval !== 0) {
    return;
  }

  const segmentId = toValidSegmentId(cfg.segmentId);
  const snapshot = buildTelemetrySnapshot(sampleInterval, segmentId);
  const payload = serializeSnapshot(snapshot);

  RawMemory.setActiveSegments([segmentId]);
  RawMemory.segments[segmentId] = payload;
}
