import {
  CPU_PROFILER_DEFAULT_HISTORY_LIMIT,
  CPU_PROFILER_DEFAULT_SAMPLE_INTERVAL,
  CPU_PROFILER_MAX_HISTORY_LIMIT,
  CPU_PROFILER_MAX_SAMPLE_INTERVAL,
  CPU_PROFILER_MIN_HISTORY_LIMIT,
  CPU_PROFILER_MIN_SAMPLE_INTERVAL,
} from "@/runtime/cpuProfilerConfig";
import {
  cancelResourceTransferTask,
  createResourceTransferTask,
  listResourceTransferTasks,
} from "@/runtime/resourceControl";
import { getCpuPhaseHistory } from "@/runtime/cpuPhaseProfiler";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

interface SpawnMaxCarrierResult {
  ok: true;
  roomName: string;
  spawnName: string;
  configName: string;
  energyAvailable: number;
  bodyParts: number;
  pairCount: number;
  queueTop: string[];
}

interface StopColonizationResult {
  ok: true;
  scope: "all" | "room";
  targetRoom?: string;
  stoppedColonizationRooms: string[];
  stoppedCrossShardTasks: string[];
  stoppedWarRooms: string[];
  removedConfigs: number;
  removedQueuedTasks: number;
  cancelledSpawns: number;
  suicidedCreeps: number;
}

interface TelemetryControlResult {
  ok: true;
  enabled: boolean;
  previousEnabled: boolean;
  sampleInterval: number;
  segmentId: number;
}

interface CpuProfilerControlResult {
  ok: true;
  enabled: boolean;
  previousEnabled: boolean;
  sampleInterval: number;
  historyLimit: number;
}

interface CpuMonitorSnapshot {
  tick: number;
  shard: string;
  totalUsed: number;
  bucket: number;
  limit: number;
  tickLimit: number;
  phases: Record<string, number>;
  untracked: number;
}

interface CpuMonitorSummary {
  ticks: number;
  avgTotalUsed: number;
  maxTotalUsed: number;
  minBucket: number;
  maxBucket: number;
  avgBucket: number;
  avgUntracked: number;
  avgPhases: Record<string, number>;
}

interface CpuMonitorResult {
  ok: true;
  enabled: boolean;
  sampleInterval: number;
  historyLimit: number;
  historySize: number;
  latest: CpuMonitorSnapshot | null;
  recentHistory: CpuMonitorSnapshot[];
  summary: CpuMonitorSummary | null;
}

interface SynthesisControlStatusResult {
  ok: true;
  enabled: boolean;
  state:
    | {
        updatedAt: number;
        generatedTaskCount: number;
        failedTaskCount: number;
        successfulRunCount: number;
        lastActions: string[];
      }
    | null;
}

const TELEMETRY_DEFAULT_SAMPLE_INTERVAL = 10;
const TELEMETRY_MIN_SAMPLE_INTERVAL = 5;
const TELEMETRY_MAX_SAMPLE_INTERVAL = 100;
const TELEMETRY_DEFAULT_SEGMENT_ID = 90;

function ensureConfigStore(): Record<string, CreepConfig> {
  return getMemoryService().getCreepConfigStore();
}

function ensureTelemetryConfig(): { enabled?: boolean; sampleInterval?: number; segmentId?: number } {
  Memory.cfg = Memory.cfg || {};
  if (!Memory.cfg.telemetry) {
    Memory.cfg.telemetry = {};
  }

  return Memory.cfg.telemetry;
}

function ensureCpuProfilerConfig(): { enabled?: boolean; sampleInterval?: number; historyLimit?: number } {
  Memory.cfg = Memory.cfg || {};
  if (!Memory.cfg.cpuProfiler) {
    Memory.cfg.cpuProfiler = {};
  }

  return Memory.cfg.cpuProfiler;
}

function sanitizeTelemetrySampleInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEMETRY_DEFAULT_SAMPLE_INTERVAL;
  }
  const normalized = Math.floor(value);
  return Math.max(TELEMETRY_MIN_SAMPLE_INTERVAL, Math.min(TELEMETRY_MAX_SAMPLE_INTERVAL, normalized));
}

function sanitizeTelemetrySegmentId(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEMETRY_DEFAULT_SEGMENT_ID;
  }
  const normalized = Math.floor(value);
  return Math.max(0, Math.min(99, normalized));
}

function sanitizeCpuProfilerSampleInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CPU_PROFILER_DEFAULT_SAMPLE_INTERVAL;
  }
  const normalized = Math.floor(value);
  return Math.max(CPU_PROFILER_MIN_SAMPLE_INTERVAL, Math.min(CPU_PROFILER_MAX_SAMPLE_INTERVAL, normalized));
}

function sanitizeCpuProfilerHistoryLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CPU_PROFILER_DEFAULT_HISTORY_LIMIT;
  }
  const normalized = Math.floor(value);
  return Math.max(CPU_PROFILER_MIN_HISTORY_LIMIT, Math.min(CPU_PROFILER_MAX_HISTORY_LIMIT, normalized));
}

function resolveTelemetrySampleInterval(next?: number): number | string {
  if (next === undefined) {
    return TELEMETRY_DEFAULT_SAMPLE_INTERVAL;
  }
  if (typeof next !== "number" || !Number.isFinite(next)) {
    return `ERR_INVALID_SAMPLE_INTERVAL:${String(next)}`;
  }

  const normalized = Math.floor(next);
  if (normalized < TELEMETRY_MIN_SAMPLE_INTERVAL || normalized > TELEMETRY_MAX_SAMPLE_INTERVAL) {
    return `ERR_SAMPLE_INTERVAL_OUT_OF_RANGE:${normalized}`;
  }

  return normalized;
}

function resolveTelemetrySegmentId(next?: number): number | string {
  if (next === undefined) {
    return TELEMETRY_DEFAULT_SEGMENT_ID;
  }
  if (typeof next !== "number" || !Number.isFinite(next)) {
    return `ERR_INVALID_SEGMENT_ID:${String(next)}`;
  }

  const normalized = Math.floor(next);
  if (normalized < 0 || normalized > 99) {
    return `ERR_SEGMENT_ID_OUT_OF_RANGE:${normalized}`;
  }

  return normalized;
}

function resolveCpuProfilerSampleInterval(next?: number): number | string {
  if (next === undefined) {
    return CPU_PROFILER_DEFAULT_SAMPLE_INTERVAL;
  }
  if (typeof next !== "number" || !Number.isFinite(next)) {
    return `ERR_INVALID_CPU_PROFILER_SAMPLE_INTERVAL:${String(next)}`;
  }

  const normalized = Math.floor(next);
  if (normalized < CPU_PROFILER_MIN_SAMPLE_INTERVAL || normalized > CPU_PROFILER_MAX_SAMPLE_INTERVAL) {
    return `ERR_CPU_PROFILER_SAMPLE_INTERVAL_OUT_OF_RANGE:${normalized}`;
  }

  return normalized;
}

function resolveCpuProfilerHistoryLimit(next?: number): number | string {
  if (next === undefined) {
    return CPU_PROFILER_DEFAULT_HISTORY_LIMIT;
  }
  if (typeof next !== "number" || !Number.isFinite(next)) {
    return `ERR_INVALID_CPU_PROFILER_HISTORY_LIMIT:${String(next)}`;
  }

  const normalized = Math.floor(next);
  if (normalized < CPU_PROFILER_MIN_HISTORY_LIMIT || normalized > CPU_PROFILER_MAX_HISTORY_LIMIT) {
    return `ERR_CPU_PROFILER_HISTORY_LIMIT_OUT_OF_RANGE:${normalized}`;
  }

  return normalized;
}

function buildCarrierBodyByEnergy(energyAvailable: number): BodyPartConstant[] {
  const pairCount = Math.max(1, Math.min(16, Math.floor(energyAvailable / (BODYPART_COST[CARRY] + BODYPART_COST[MOVE]))));
  const body: BodyPartConstant[] = [];

  for (let i = 0; i < pairCount; i++) {
    body.push(CARRY, MOVE);
  }

  return body;
}

function resolveSpawnByRoom(roomName: string): StructureSpawn | null {
  return getTickContextService().getPrimarySpawnByRoom(roomName) || null;
}

function enqueueAtFront(spawn: StructureSpawn, configName: string): void {
  const queue = spawn.memory.spawnList || [];
  spawn.memory.spawnList = [configName, ...queue.filter((name) => name !== configName)];
}

function collectConfigNamesByPrefix(prefix: string): string[] {
  return Object.keys(getCreepConfigService().list(prefix));
}

function removeConfigFromSpawnQueue(configName: string): number {
  let removed = 0;
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      const queue = spawn.memory.spawnList;
      if (!queue || queue.length === 0) {
        continue;
      }

      const next = queue.filter((name) => name !== configName);
      if (next.length !== queue.length) {
        spawn.memory.spawnList = next;
        removed += queue.length - next.length;
      }
    }
  }

  return removed;
}

function cancelSpawnIfSpawningConfig(configName: string): number {
  const creepMemory = Memory.creeps || {};
  let cancelled = 0;
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (!spawn.spawning) {
        continue;
      }

      const spawningName = spawn.spawning.name;
      if (creepMemory[spawningName]?.configName !== configName) {
        continue;
      }

      const code = spawn.spawning.cancel();
      if (code === OK) {
        cancelled += 1;
      }
    }
  }

  return cancelled;
}

function suicideCreepsByConfig(configName: string): number {
  let suicided = 0;
  for (const creep of getTickContextService().getCreepsByConfigName(configName)) {
    if (creep.memory.configName !== configName) {
      continue;
    }

    const code = creep.suicide();
    if (code === OK) {
      suicided += 1;
    }
  }

  return suicided;
}

function removeConfig(configName: string): number {
  const store = ensureConfigStore();
  if (!store[configName]) {
    return 0;
  }

  delete store[configName];
  return 1;
}

function getCrossShardTaskConfigNames(task: NonNullable<Memory["data"]>["crossShardColonization"] extends Record<
  string,
  infer T
>
  ? T
  : never): string[] {
  const names = new Set<string>();

  if (task.claimerConfigName) {
    names.add(task.claimerConfigName);
  }

  for (const configName of task.bootstrapConfigNames || []) {
    names.add(configName);
  }

  if (task.sourceRoom) {
    const prefix = `${task.sourceRoom}:crossShard:${task.targetShard}:${task.targetRoom}:`;
    for (const configName of collectConfigNamesByPrefix(prefix)) {
      names.add(configName);
    }
  }

  return [...names];
}

export function stopColonization(targetRoom?: string): StopColonizationResult | string {
  const data = Memory.data;
  const colonizationStore = data?.colonization || {};
  const crossShardStore = data?.crossShardColonization || {};
  const warStore = data?.war || {};

  const colonizationRooms = Object.keys(colonizationStore).filter((roomName) => !targetRoom || roomName === targetRoom);
  const crossShardTaskEntries = Object.entries(crossShardStore).filter(
    ([, task]) => !targetRoom || task.targetRoom === targetRoom,
  );

  const warRooms = Object.keys(warStore).filter((roomName) => {
    if (targetRoom) {
      return roomName === targetRoom;
    }

    const warTask = warStore[roomName];
    return warTask.reason === "npc_reservation";
  });

  if (colonizationRooms.length === 0 && crossShardTaskEntries.length === 0 && warRooms.length === 0) {
    return targetRoom ? `ERR_NO_COLONIZATION_TASK:${targetRoom}` : "ERR_NO_COLONIZATION_TASK";
  }

  const configNames = new Set<string>();

  for (const roomName of colonizationRooms) {
    const task = colonizationStore[roomName];
    const prefix = `${task.sourceRoom}:colonize:${task.targetRoom}:`;
    for (const configName of collectConfigNamesByPrefix(prefix)) {
      configNames.add(configName);
    }
  }

  for (const roomName of warRooms) {
    const task = warStore[roomName];
    const prefix = `${task.sourceRoom}:war:${task.targetRoom}:`;
    for (const configName of collectConfigNamesByPrefix(prefix)) {
      configNames.add(configName);
    }
  }

  for (const [, task] of crossShardTaskEntries) {
    for (const configName of getCrossShardTaskConfigNames(task)) {
      configNames.add(configName);
    }
  }

  let removedConfigs = 0;
  let removedQueuedTasks = 0;
  let cancelledSpawns = 0;
  let suicidedCreeps = 0;

  for (const configName of configNames) {
    cancelledSpawns += cancelSpawnIfSpawningConfig(configName);
    removedQueuedTasks += removeConfigFromSpawnQueue(configName);
    suicidedCreeps += suicideCreepsByConfig(configName);
    removedConfigs += removeConfig(configName);
  }

  for (const roomName of colonizationRooms) {
    delete colonizationStore[roomName];
  }

  const stoppedCrossShardTasks: string[] = [];
  for (const [taskId] of crossShardTaskEntries) {
    stoppedCrossShardTasks.push(taskId);
    delete crossShardStore[taskId];
  }

  for (const roomName of warRooms) {
    delete warStore[roomName];
  }

  return {
    ok: true,
    scope: targetRoom ? "room" : "all",
    targetRoom,
    stoppedColonizationRooms: colonizationRooms,
    stoppedCrossShardTasks,
    stoppedWarRooms: warRooms,
    removedConfigs,
    removedQueuedTasks,
    cancelledSpawns,
    suicidedCreeps,
  };
}

function formatStopColonizationResult(result: StopColonizationResult | string): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}

export function stopColonizationRaw(targetRoom?: string): StopColonizationResult | string {
  return stopColonization(targetRoom);
}

export function stopColonizationCommand(targetRoom?: string): string {
  return formatStopColonizationResult(stopColonization(targetRoom));
}

export function spawnMaxCarrier(roomName: string): SpawnMaxCarrierResult | string {
  const spawn = resolveSpawnByRoom(roomName);
  if (!spawn) {
    return `ERR_NO_SPAWN:${roomName}`;
  }

  const energyAvailable = spawn.room.energyAvailable;
  if (energyAvailable < BODYPART_COST[CARRY] + BODYPART_COST[MOVE]) {
    return `ERR_NOT_ENOUGH_ENERGY:${energyAvailable}`;
  }

  const body = buildCarrierBodyByEnergy(energyAvailable);
  const pairCount = body.length / 2;
  const configName = `${roomName}:manual:maxcarrier:${Game.time}`;

  const store = ensureConfigStore();
  store[configName] = {
    role: "carrier",
    args: [],
    roomName,
    body,
  };

  enqueueAtFront(spawn, configName);

  return {
    ok: true,
    roomName,
    spawnName: spawn.name,
    configName,
    energyAvailable,
    bodyParts: body.length,
    pairCount,
    queueTop: (spawn.memory.spawnList || []).slice(0, 5),
  };
}

function formatSpawnMaxCarrierResult(result: SpawnMaxCarrierResult | string): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}

export function spawnMaxCarrierRaw(roomName: string): SpawnMaxCarrierResult | string {
  return spawnMaxCarrier(roomName);
}

export function spawnMaxCarrierCommand(roomName: string): string {
  return formatSpawnMaxCarrierResult(spawnMaxCarrier(roomName));
}

export function startTelemetry(
  sampleInterval?: number,
  segmentId?: number,
): TelemetryControlResult | string {
  const cfg = ensureTelemetryConfig();
  const previousEnabled = cfg.enabled === true;

  const resolvedSampleInterval = resolveTelemetrySampleInterval(sampleInterval);
  if (typeof resolvedSampleInterval === "string") {
    return resolvedSampleInterval;
  }
  const resolvedSegmentId = resolveTelemetrySegmentId(segmentId);
  if (typeof resolvedSegmentId === "string") {
    return resolvedSegmentId;
  }

  cfg.enabled = true;
  cfg.sampleInterval = resolvedSampleInterval;
  cfg.segmentId = resolvedSegmentId;

  return {
    ok: true,
    enabled: true,
    previousEnabled,
    sampleInterval: resolvedSampleInterval,
    segmentId: resolvedSegmentId,
  };
}

export function stopTelemetryExport(): TelemetryControlResult {
  const cfg = ensureTelemetryConfig();
  const previousEnabled = cfg.enabled === true;
  const sampleInterval = sanitizeTelemetrySampleInterval(cfg.sampleInterval);
  const segmentId = sanitizeTelemetrySegmentId(cfg.segmentId);

  cfg.enabled = false;
  cfg.sampleInterval = sampleInterval;
  cfg.segmentId = segmentId;

  return {
    ok: true,
    enabled: false,
    previousEnabled,
    sampleInterval,
    segmentId,
  };
}

function formatTelemetryControlResult(result: TelemetryControlResult | string): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}

export function startTelemetryRaw(sampleInterval?: number, segmentId?: number): TelemetryControlResult | string {
  return startTelemetry(sampleInterval, segmentId);
}

export function startTelemetryCommand(sampleInterval?: number, segmentId?: number): string {
  return formatTelemetryControlResult(startTelemetry(sampleInterval, segmentId));
}

export function stopTelemetryRaw(): TelemetryControlResult {
  return stopTelemetryExport();
}

export function stopTelemetryCommand(): string {
  return formatTelemetryControlResult(stopTelemetryExport());
}

export function statusTelemetryRaw(): TelemetryControlResult {
  const cfg = ensureTelemetryConfig();
  return {
    ok: true,
    enabled: cfg.enabled === true,
    previousEnabled: cfg.enabled === true,
    sampleInterval: sanitizeTelemetrySampleInterval(cfg.sampleInterval),
    segmentId: sanitizeTelemetrySegmentId(cfg.segmentId),
  };
}

export function statusTelemetryCommand(): string {
  return formatTelemetryControlResult(statusTelemetryRaw());
}

export function startCpuProfiler(
  sampleInterval?: number,
  historyLimit?: number,
): CpuProfilerControlResult | string {
  const cfg = ensureCpuProfilerConfig();
  const previousEnabled = cfg.enabled === true;

  const resolvedSampleInterval = resolveCpuProfilerSampleInterval(sampleInterval);
  if (typeof resolvedSampleInterval === "string") {
    return resolvedSampleInterval;
  }
  const resolvedHistoryLimit = resolveCpuProfilerHistoryLimit(historyLimit);
  if (typeof resolvedHistoryLimit === "string") {
    return resolvedHistoryLimit;
  }

  cfg.enabled = true;
  cfg.sampleInterval = resolvedSampleInterval;
  cfg.historyLimit = resolvedHistoryLimit;

  return {
    ok: true,
    enabled: true,
    previousEnabled,
    sampleInterval: resolvedSampleInterval,
    historyLimit: resolvedHistoryLimit,
  };
}

export function stopCpuProfilerExport(): CpuProfilerControlResult {
  const cfg = ensureCpuProfilerConfig();
  const previousEnabled = cfg.enabled === true;
  const sampleInterval = sanitizeCpuProfilerSampleInterval(cfg.sampleInterval);
  const historyLimit = sanitizeCpuProfilerHistoryLimit(cfg.historyLimit);

  cfg.enabled = false;
  cfg.sampleInterval = sampleInterval;
  cfg.historyLimit = historyLimit;

  return {
    ok: true,
    enabled: false,
    previousEnabled,
    sampleInterval,
    historyLimit,
  };
}

function formatCpuProfilerControlResult(result: CpuProfilerControlResult | string): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}

function cloneCpuMonitorSnapshot(snapshot: CpuMonitorSnapshot): CpuMonitorSnapshot {
  return {
    tick: snapshot.tick,
    shard: snapshot.shard,
    totalUsed: snapshot.totalUsed,
    bucket: snapshot.bucket,
    limit: snapshot.limit,
    tickLimit: snapshot.tickLimit,
    phases: { ...snapshot.phases },
    untracked: snapshot.untracked,
  };
}

function buildCpuMonitorSummary(history: CpuMonitorSnapshot[]): CpuMonitorSummary | null {
  if (history.length === 0) {
    return null;
  }

  const avgPhases: Record<string, number> = {};
  let totalUsedSum = 0;
  let bucketSum = 0;
  let untrackedSum = 0;
  let maxTotalUsed = Number.NEGATIVE_INFINITY;
  let minBucket = Number.POSITIVE_INFINITY;
  let maxBucket = Number.NEGATIVE_INFINITY;

  for (const entry of history) {
    totalUsedSum += entry.totalUsed;
    bucketSum += entry.bucket;
    untrackedSum += entry.untracked;
    maxTotalUsed = Math.max(maxTotalUsed, entry.totalUsed);
    minBucket = Math.min(minBucket, entry.bucket);
    maxBucket = Math.max(maxBucket, entry.bucket);

    for (const [phase, used] of Object.entries(entry.phases)) {
      avgPhases[phase] = (avgPhases[phase] || 0) + used;
    }
  }

  for (const phase of Object.keys(avgPhases)) {
    avgPhases[phase] = avgPhases[phase] / history.length;
  }

  return {
    ticks: history.length,
    avgTotalUsed: totalUsedSum / history.length,
    maxTotalUsed,
    minBucket,
    maxBucket,
    avgBucket: bucketSum / history.length,
    avgUntracked: untrackedSum / history.length,
    avgPhases,
  };
}

function formatCpuMonitorNumber(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}

function formatTopCpuPhases(phases: Record<string, number>, limit = 5): string {
  const entries = Object.entries(phases)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);

  if (entries.length === 0) {
    return "none";
  }

  return entries.map(([name, value]) => `${name}=${value.toFixed(2)}`).join(" ");
}

function formatCpuMonitorResult(result: CpuMonitorResult): string {
  const lines = [
    `[cpu-monitor] enabled=${result.enabled} sampleInterval=${result.sampleInterval} history=${result.historySize}/${result.historyLimit}`,
  ];

  if (!result.latest) {
    lines.push("[cpu-monitor] latest=none");
  } else {
    lines.push(
      `[cpu-monitor] latest tick=${result.latest.tick} shard=${result.latest.shard} used=${result.latest.totalUsed.toFixed(2)}/${formatCpuMonitorNumber(result.latest.limit)} bucket=${formatCpuMonitorNumber(result.latest.bucket)} tickLimit=${formatCpuMonitorNumber(result.latest.tickLimit)} untracked=${result.latest.untracked.toFixed(2)}`,
    );
    lines.push(`[cpu-monitor] latestPhases ${formatTopCpuPhases(result.latest.phases)}`);
  }

  if (!result.summary) {
    lines.push("[cpu-monitor] summary=none");
  } else {
    lines.push(
      `[cpu-monitor] summary ticks=${result.summary.ticks} avgUsed=${result.summary.avgTotalUsed.toFixed(2)} maxUsed=${result.summary.maxTotalUsed.toFixed(2)} avgBucket=${result.summary.avgBucket.toFixed(2)} bucketRange=${formatCpuMonitorNumber(result.summary.minBucket)}-${formatCpuMonitorNumber(result.summary.maxBucket)} avgUntracked=${result.summary.avgUntracked.toFixed(2)}`,
    );
    lines.push(`[cpu-monitor] summaryPhases ${formatTopCpuPhases(result.summary.avgPhases)}`);
  }

  return lines.join("\n");
}

export function startCpuProfilerRaw(sampleInterval?: number, historyLimit?: number): CpuProfilerControlResult | string {
  return startCpuProfiler(sampleInterval, historyLimit);
}

export function startCpuProfilerCommand(sampleInterval?: number, historyLimit?: number): string {
  return formatCpuProfilerControlResult(startCpuProfiler(sampleInterval, historyLimit));
}

export function stopCpuProfilerRaw(): CpuProfilerControlResult {
  return stopCpuProfilerExport();
}

export function stopCpuProfilerCommand(): string {
  return formatCpuProfilerControlResult(stopCpuProfilerExport());
}

export function statusCpuProfilerRaw(): CpuProfilerControlResult {
  const cfg = ensureCpuProfilerConfig();
  return {
    ok: true,
    enabled: cfg.enabled === true,
    previousEnabled: cfg.enabled === true,
    sampleInterval: sanitizeCpuProfilerSampleInterval(cfg.sampleInterval),
    historyLimit: sanitizeCpuProfilerHistoryLimit(cfg.historyLimit),
  };
}

export function statusCpuProfilerCommand(): string {
  return formatCpuProfilerControlResult(statusCpuProfilerRaw());
}

export function cpuMonitorRaw(): CpuMonitorResult {
  const cfg = ensureCpuProfilerConfig();
  const latest = Memory.analytics?.moduleCpu?.latest || null;
  const history = getCpuPhaseHistory().map((entry) => cloneCpuMonitorSnapshot(entry));
  const recentHistory = history.slice(-10);

  return {
    ok: true,
    enabled: cfg.enabled === true,
    sampleInterval: sanitizeCpuProfilerSampleInterval(cfg.sampleInterval),
    historyLimit: sanitizeCpuProfilerHistoryLimit(cfg.historyLimit),
    historySize: history.length,
    latest: latest ? cloneCpuMonitorSnapshot(latest) : null,
    recentHistory,
    summary: buildCpuMonitorSummary(recentHistory),
  };
}

export function cpuMonitorCommand(): string {
  return formatCpuMonitorResult(cpuMonitorRaw());
}

export function statusSynthesisControlRaw(): SynthesisControlStatusResult {
  const state = Memory.runtime?.synthesisControl;
  return {
    ok: true,
    enabled: Memory.cfg?.synthesisControl?.enabled === true,
    state: state
      ? {
          updatedAt: state.updatedAt,
          generatedTaskCount: state.generatedTaskCount,
          failedTaskCount: state.failedTaskCount,
          successfulRunCount: state.successfulRunCount,
          lastActions: state.lastActions,
        }
      : null,
  };
}

export function statusSynthesisControlCommand(): string {
  return JSON.stringify(statusSynthesisControlRaw());
}

export function addResourceTransferTaskRaw(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason?: string,
): ReturnType<typeof createResourceTransferTask> {
  return createResourceTransferTask(fromRoomName, toRoomName, resource, amount, reason);
}

export function addResourceTransferTaskCommand(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason?: string,
): string {
  return JSON.stringify(addResourceTransferTaskRaw(fromRoomName, toRoomName, resource, amount, reason));
}

export function cancelResourceTransferTaskRaw(taskId: string): ReturnType<typeof cancelResourceTransferTask> {
  return cancelResourceTransferTask(taskId);
}

export function cancelResourceTransferTaskCommand(taskId: string): string {
  return JSON.stringify(cancelResourceTransferTaskRaw(taskId));
}

export function listResourceTransferTasksRaw(): ReturnType<typeof listResourceTransferTasks> {
  return listResourceTransferTasks();
}

export function listResourceTransferTasksCommand(): string {
  return JSON.stringify(listResourceTransferTasksRaw());
}

export function registerConsoleCommands(): void {
  global.spawnMaxCarrier = spawnMaxCarrierCommand;
  global.spawnMaxCarrierRaw = spawnMaxCarrierRaw;
  global.stopColonization = stopColonizationCommand;
  global.stopColonizationRaw = stopColonizationRaw;
  global.startTelemetry = startTelemetryCommand;
  global.startTelemetryRaw = startTelemetryRaw;
  global.stopTelemetry = stopTelemetryCommand;
  global.stopTelemetryRaw = stopTelemetryRaw;
  global.statusTelemetry = statusTelemetryCommand;
  global.statusTelemetryRaw = statusTelemetryRaw;
  global.startCpuProfiler = startCpuProfilerCommand;
  global.startCpuProfilerRaw = startCpuProfilerRaw;
  global.stopCpuProfiler = stopCpuProfilerCommand;
  global.stopCpuProfilerRaw = stopCpuProfilerRaw;
  global.statusCpuProfiler = statusCpuProfilerCommand;
  global.statusCpuProfilerRaw = statusCpuProfilerRaw;
  global.cpuMonitor = cpuMonitorCommand;
  global.cpuMonitorRaw = cpuMonitorRaw;
  global.statusSynthesisControl = statusSynthesisControlCommand;
  global.statusSynthesisControlRaw = statusSynthesisControlRaw;
  global.addResourceTransferTask = addResourceTransferTaskCommand;
  global.addResourceTransferTaskRaw = addResourceTransferTaskRaw;
  global.cancelResourceTransferTask = cancelResourceTransferTaskCommand;
  global.cancelResourceTransferTaskRaw = cancelResourceTransferTaskRaw;
  global.listResourceTransferTasks = listResourceTransferTasksCommand;
  global.listResourceTransferTasksRaw = listResourceTransferTasksRaw;
}
