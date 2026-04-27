import { getCpuPhaseHistory } from "@/runtime/cpuPhaseProfiler";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getCreepMovementState, getMovementAnalytics } from "@/movement";
import { getAssignedWorkerTaskId } from "@/runtime/workerTaskPool";
import { getWorkerTasksByRoom } from "@/runtime/workerTaskPool";

const DEFAULT_SAMPLE_INTERVAL = 10;
const MIN_SAMPLE_INTERVAL = 5;
const MAX_SAMPLE_INTERVAL = 100;
const DEFAULT_SEGMENT_ID = 90;
const MAX_SEGMENT_PAYLOAD_BYTES = 95_000;
const MAX_DEBUG_CREEPS = 25;
const MAX_DEBUG_ROUTE_ROOMS = 25;
const MAX_DEBUG_VISITED_ROOMS = 20;

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
  debug?: ExternalTelemetryDebugSnapshot;
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

interface ExternalTelemetryDebugSnapshot {
  creeps: DebugCreepTelemetry[];
  colonization: DebugColonizationTelemetry[];
  counts: {
    creepsWithMovementState: number;
    creepsWithTravelState: number;
    stuckCreeps: number;
    colonizationTasks: number;
  };
  truncated?: boolean;
}

interface DebugCreepTelemetry {
  name: string;
  role?: string;
  roomName: string;
  x: number;
  y: number;
  ticksToLive?: number;
  configName?: string;
  targetRoom?: string;
  roleArgs?: unknown[];
  scoutVisitedRooms?: string[];
  travelState?: {
    targetRoom: string;
    stuckTicks: number;
    lastPosKey?: string;
    lastWasExit?: boolean;
  };
  movePathState?: {
    targetRoom: string;
    targetX: number;
    targetY: number;
    range: number;
    stuckTicks: number;
    expiresAt: number;
  };
  workAnchor?: {
    x: number;
    y: number;
    roomName: string;
    range: number;
  };
}

interface DebugColonizationTelemetry {
  targetRoom: string;
  sourceRoom: string;
  status: string;
  mode?: string;
  scoutSafe?: boolean;
  claimCompleted?: boolean;
  scoutedAt?: number;
  scoutRouteRooms?: string[];
  dangerousRooms?: string[];
  safeRouteRetryAt?: number;
  temporaryDangerousRoomCount?: number;
  permanentDangerousRoomCount?: number;
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
        if (!getAssignedWorkerTaskId(creep.name)) {
          roomStats.unassignedWorkers += 1;
        }
        continue;
      }

      if (role === "carrier") {
        roomStats.carrierCount += 1;
        const stuckTicks = getCreepMovementState(creep.name)?.travelState?.stuckTicks;
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

  for (const roomName of Object.keys(Game.rooms)) {
    const tasks = getWorkerTasksByRoom(roomName);
    if (Object.keys(tasks).length === 0) {
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

function getCreepTargetRoom(creep: Creep): string | undefined {
  const args = creep.memory.roleArgs;
  if (!Array.isArray(args) || typeof args[0] !== "string") {
    return undefined;
  }

  return args[0];
}

function isInterestingDebugCreep(creep: Creep): boolean {
  const state = getCreepMovementState(creep.name);
  const role = creep.memory.role;
  if (state?.travelState || state?.movePathState || state?.workAnchor) {
    return true;
  }

  return (
    role === "scout" ||
    role === "claimer" ||
    role === "colonizerHarvester" ||
    role === "colonizerWorker" ||
    role === "flagScout"
  );
}

function scoreDebugCreep(creep: Creep): number {
  const state = getCreepMovementState(creep.name);
  const role = creep.memory.role;
  let score = 0;
  if (role === "scout" || role === "flagScout") score += 100;
  if (role === "claimer" || role === "colonizerHarvester" || role === "colonizerWorker") score += 80;
  if ((state?.travelState?.stuckTicks ?? 0) >= 2) score += 70;
  if ((state?.movePathState?.stuckTicks ?? 0) >= 2) score += 50;
  if (state?.travelState) score += 30;
  if (state?.movePathState) score += 10;
  if (state?.workAnchor) score += 5;
  return score;
}

function collectDebugCreeps(): DebugCreepTelemetry[] {
  return Object.values(Game.creeps)
    .filter(isInterestingDebugCreep)
    .sort((left, right) => scoreDebugCreep(right) - scoreDebugCreep(left) || left.name.localeCompare(right.name))
    .slice(0, MAX_DEBUG_CREEPS)
    .map((creep) => {
      const state = getCreepMovementState(creep.name);
      const movePathState = state?.movePathState;
      return {
        name: creep.name,
        role: creep.memory.role,
        roomName: creep.room.name,
        x: creep.pos.x,
        y: creep.pos.y,
        ticksToLive: creep.ticksToLive,
        configName: creep.memory.configName,
        targetRoom: state?.travelState?.targetRoom || getCreepTargetRoom(creep),
        roleArgs: Array.isArray(creep.memory.roleArgs) ? creep.memory.roleArgs.slice(0, 4) : undefined,
        scoutVisitedRooms: creep.memory.scoutVisitedRooms?.slice(-MAX_DEBUG_VISITED_ROOMS),
        travelState: state?.travelState
          ? {
              targetRoom: state.travelState.targetRoom,
              stuckTicks: state.travelState.stuckTicks,
              lastPosKey: state.travelState.lastPosKey,
              lastWasExit: state.travelState.lastWasExit,
            }
          : undefined,
        movePathState: movePathState
          ? {
              targetRoom: movePathState.targetRoom,
              targetX: movePathState.targetX,
              targetY: movePathState.targetY,
              range: movePathState.range,
              stuckTicks: movePathState.stuckTicks,
              expiresAt: movePathState.expiresAt,
            }
          : undefined,
        workAnchor: state?.workAnchor,
      } satisfies DebugCreepTelemetry;
    });
}

function collectDebugColonization(): DebugColonizationTelemetry[] {
  const colonization = Memory.data?.colonization || {};
  return Object.values(colonization).map((task) => ({
    targetRoom: task.targetRoom,
    sourceRoom: task.sourceRoom,
    status: task.status,
    mode: task.mode,
    scoutSafe: task.scoutSafe,
    claimCompleted: task.claimCompleted,
    scoutedAt: task.scoutedAt,
    scoutRouteRooms: task.scoutRouteRooms?.slice(0, MAX_DEBUG_ROUTE_ROOMS),
    dangerousRooms: task.dangerousRooms?.slice(0, MAX_DEBUG_ROUTE_ROOMS),
    safeRouteRetryAt: task.safeRouteRetryAt,
    temporaryDangerousRoomCount: task.temporaryDangerousRooms ? Object.keys(task.temporaryDangerousRooms).length : undefined,
    permanentDangerousRoomCount: task.permanentDangerousRooms?.length,
  }));
}

function countMovementStates(): ExternalTelemetryDebugSnapshot["counts"] {
  let creepsWithMovementState = 0;
  let creepsWithTravelState = 0;
  let stuckCreeps = 0;

  for (const creep of Object.values(Game.creeps)) {
    const state = getCreepMovementState(creep.name);
    if (!state) {
      continue;
    }
    creepsWithMovementState += 1;
    if (state.travelState) {
      creepsWithTravelState += 1;
    }
    if ((state.travelState?.stuckTicks ?? 0) >= 2 || (state.movePathState?.stuckTicks ?? 0) >= 2) {
      stuckCreeps += 1;
    }
  }

  return {
    creepsWithMovementState,
    creepsWithTravelState,
    stuckCreeps,
    colonizationTasks: Object.keys(Memory.data?.colonization || {}).length,
  };
}

function collectDebugTelemetry(): ExternalTelemetryDebugSnapshot {
  const creeps = collectDebugCreeps();
  const colonization = collectDebugColonization();
  return {
    creeps,
    colonization,
    counts: countMovementStates(),
    truncated: Object.values(Game.creeps).filter(isInterestingDebugCreep).length > creeps.length,
  };
}

function getOwnedRooms(): Room[] {
  return getTickContextService().getMyRooms();
}

function buildTelemetrySnapshot(sampleInterval: number, segmentId: number): ExternalTelemetrySnapshot {
  const ownedRooms = getOwnedRooms();
  const creepsByRoom = collectCreepTelemetryByRoom(ownedRooms);
  const tasksByRoom = collectTaskTelemetryByRoom();
  const spawnsByRoom = collectSpawnTelemetryByRoom(ownedRooms);
  const debug = collectDebugTelemetry();
  const productionRooms = Memory.analytics?.production?.rooms || {};
  const moduleCpuLatest = Memory.analytics?.moduleCpu?.latest;
  const moduleCpuHistory = getCpuPhaseHistory();
  const movementAnalytics = getMovementAnalytics();

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
    debug,
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
    debug: snapshot.debug
      ? {
          counts: snapshot.debug.counts,
          creeps: snapshot.debug.creeps.slice(0, 10),
          colonization: snapshot.debug.colonization.slice(0, 10),
          truncated: true,
        }
      : undefined,
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
    debug: snapshot.debug ? { counts: snapshot.debug.counts, creeps: [], colonization: [], truncated: true } : undefined,
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
