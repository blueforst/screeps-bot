import {
  CPU_PROFILER_DEFAULT_HISTORY_LIMIT,
  CPU_PROFILER_DEFAULT_SAMPLE_INTERVAL,
  CPU_PROFILER_MAX_HISTORY_LIMIT,
  CPU_PROFILER_MAX_SAMPLE_INTERVAL,
  CPU_PROFILER_MIN_HISTORY_LIMIT,
  CPU_PROFILER_MIN_SAMPLE_INTERVAL,
} from "@/runtime/cpuProfilerConfig";
import { getCpuPhaseHistory } from "@/runtime/cpuPhaseProfiler";

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
  fixedActionCounts: Record<string, number>;
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
  avgFixedActionCounts: Record<string, number>;
}

interface CpuMonitorPhaseTotals {
  raw: number;
  logic: number;
  fixed: number;
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

const CPU_FIXED_ACTION_COST = 0.2;

function ensureCpuProfilerConfig(): { enabled?: boolean; sampleInterval?: number; historyLimit?: number } {
  Memory.cfg = Memory.cfg || {};
  if (!Memory.cfg.cpuProfiler) {
    Memory.cfg.cpuProfiler = {};
  }

  return Memory.cfg.cpuProfiler;
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

export function startCpuProfiler(sampleInterval?: number, historyLimit?: number): CpuProfilerControlResult | string {
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
    fixedActionCounts: { ...snapshot.fixedActionCounts },
    untracked: snapshot.untracked,
  };
}

function buildCpuMonitorSummary(history: CpuMonitorSnapshot[]): CpuMonitorSummary | null {
  if (history.length === 0) {
    return null;
  }

  const avgPhases: Record<string, number> = {};
  const avgFixedActionCounts: Record<string, number> = {};
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

    for (const [phase, count] of Object.entries(entry.fixedActionCounts)) {
      avgFixedActionCounts[phase] = (avgFixedActionCounts[phase] || 0) + count;
    }
  }

  for (const phase of Object.keys(avgPhases)) {
    avgPhases[phase] = avgPhases[phase] / history.length;
  }

  for (const phase of Object.keys(avgFixedActionCounts)) {
    avgFixedActionCounts[phase] = avgFixedActionCounts[phase] / history.length;
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
    avgFixedActionCounts,
  };
}

function formatCpuMonitorNumber(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}

function buildTopLevelPhaseTotals(
  phases: Record<string, number>,
  fixedActionCounts: Record<string, number>,
): Array<[string, CpuMonitorPhaseTotals]> {
  const topLevelPhaseNames = new Set(Object.keys(phases).filter((phase) => !phase.includes(":")));

  for (const phase of Object.keys(fixedActionCounts)) {
    topLevelPhaseNames.add(phase);
  }

  return [...topLevelPhaseNames].map((phase) => {
    const raw = phases[phase] || 0;
    const fixed = (fixedActionCounts[phase] || 0) * CPU_FIXED_ACTION_COST;
    const logic = Math.max(0, raw - fixed);
    return [phase, { raw, logic, fixed }];
  });
}

function formatTopCpuPhases(phases: Record<string, number>, fixedActionCounts: Record<string, number>, limit = 5): string[] {
  const entries = buildTopLevelPhaseTotals(phases, fixedActionCounts)
    .sort((left, right) => right[1].raw - left[1].raw)
    .slice(0, limit);

  return entries.map(([name, totals]) => {
    if (totals.fixed > 0) {
      return `[cpu-monitor]   ${name}  ${totals.raw.toFixed(2)}  (${totals.logic.toFixed(2)} + ${totals.fixed.toFixed(2)} fixed)`;
    }
    return `[cpu-monitor]   ${name}  ${totals.logic.toFixed(2)}`;
  });
}

function formatCpuMonitorResult(result: CpuMonitorResult): string {
  const lines = [
    `[cpu-monitor] enabled=${result.enabled}  interval=${result.sampleInterval}  history=${result.historySize}/${result.historyLimit}`,
  ];

  if (!result.latest) {
    lines.push("[cpu-monitor] latest=none");
  } else {
    lines.push(
      `[cpu-monitor] latest  t=${result.latest.tick}  shard=${result.latest.shard}  used=${result.latest.totalUsed.toFixed(2)}/${formatCpuMonitorNumber(result.latest.limit)}  bucket=${formatCpuMonitorNumber(result.latest.bucket)}  tickLimit=${formatCpuMonitorNumber(result.latest.tickLimit)}  untracked=${result.latest.untracked.toFixed(2)}`,
    );
    lines.push(...formatTopCpuPhases(result.latest.phases, result.latest.fixedActionCounts));
  }

  if (!result.summary) {
    lines.push("[cpu-monitor] summary=none");
  } else {
    lines.push(
      `[cpu-monitor] avg(${result.summary.ticks})  avg=${result.summary.avgTotalUsed.toFixed(2)}  max=${result.summary.maxTotalUsed.toFixed(2)}  bucket=${formatCpuMonitorNumber(result.summary.minBucket)}-${formatCpuMonitorNumber(result.summary.maxBucket)}  untracked=${result.summary.avgUntracked.toFixed(2)}`,
    );
    lines.push(...formatTopCpuPhases(result.summary.avgPhases, result.summary.avgFixedActionCounts));
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

export function registerCpuProfilerConsoleCommands(): void {
  global.startCpuProfiler = startCpuProfilerCommand;
  global.startCpuProfilerRaw = startCpuProfilerRaw;
  global.stopCpuProfiler = stopCpuProfilerCommand;
  global.stopCpuProfilerRaw = stopCpuProfilerRaw;
  global.statusCpuProfiler = statusCpuProfilerCommand;
  global.statusCpuProfilerRaw = statusCpuProfilerRaw;
  global.cpuMonitor = cpuMonitorCommand;
  global.cpuMonitorRaw = cpuMonitorRaw;
}
