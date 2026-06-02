/**
 * CPU Monitor v2 — types, config defaults, and normalization.
 *
 * This module defines the canonical v2 schema for CPU monitoring.
 * Runtime store, EMA, heap capture, profiler rewrite, main-loop integration,
 * console commands, and telemetry migration live in later tasks.
 */

import {
  CPU_PROFILER_MAX_HISTORY_LIMIT,
  CPU_PROFILER_MAX_SAMPLE_INTERVAL,
  CPU_PROFILER_MIN_HISTORY_LIMIT,
  CPU_PROFILER_MIN_SAMPLE_INTERVAL,
} from "@/runtime/cpuProfilerConfig";

// ─── v2 Config ────────────────────────────────────────────────────────────────

/** Config stored under `Memory.cfg.cpuProfiler` (v2 fields added to existing shape). */
export interface CpuMonitorConfig {
  enabled: boolean;
  sampleInterval: number;
  historyLimit: number;
  emaAlpha: number;
  roomRoleAggregation: boolean;
  heapStats: boolean;
  fixedActionCpuCost: number;
}

export const CPU_MONITOR_DEFAULTS: Readonly<CpuMonitorConfig> = {
  enabled: false,
  sampleInterval: 10,
  historyLimit: 120,
  emaAlpha: 0.1,
  roomRoleAggregation: true,
  heapStats: true,
  fixedActionCpuCost: 0.2,
} as const;

// ─── v2 Snapshot types ────────────────────────────────────────────────────────

/** Per-tick snapshot stored in the v2 history ring buffer. */
export interface CpuMonitorSnapshotV2 {
  tick: number;
  shard: string;
  totalUsed: number;
  bucket: number;
  limit: number;
  tickLimit: number;
  phases: Record<string, number>;
  fixedActionCounts: Record<string, number>;
  untracked: number;
  /** EMA-smoothed total CPU (set by runtime, 0 until first sample). */
  emaTotalUsed: number;
  /** Per-room CPU breakdown (populated when roomRoleAggregation is enabled). */
  rooms: Record<string, CpuMonitorRoomSummary>;
  /** Heap snapshot (populated when heapStats is enabled and available). */
  heap: CpuMonitorHeapSnapshot | null;
}

/** Per-room CPU summary within a tick snapshot. */
export interface CpuMonitorRoomSummary {
  totalUsed: number;
  roles: Record<string, CpuMonitorRoleSummary>;
}

/** Per-role CPU summary within a room. */
export interface CpuMonitorRoleSummary {
  count: number;
  used: number;
}

/** IVM heap statistics (nullable fields mirror Screeps API). */
export interface CpuMonitorHeapSnapshot {
  total_heap_size: number;
  total_heap_size_executable: number;
  total_physical_size: number;
  total_available_size: number;
  used_heap_size: number;
  heap_size_limit: number;
  malloced_memory: number;
  peak_malloced_memory: number;
  does_zap_garbage: number;
  externally_allocated_size: number;
}

// ─── v2 History entry (persisted to Memory.analytics.cpuMonitor) ──────────────

/** Single entry in the persisted history ring buffer. */
export interface CpuMonitorHistoryEntryV2 extends CpuMonitorSnapshotV2 {}

// ─── v2 Aggregated summary ────────────────────────────────────────────────────

/** Aggregated statistics computed over recent history. */
export interface CpuMonitorSummaryV2 {
  ticks: number;
  avgTotalUsed: number;
  maxTotalUsed: number;
  minBucket: number;
  maxBucket: number;
  avgBucket: number;
  avgUntracked: number;
  avgPhases: Record<string, number>;
  avgFixedActionCounts: Record<string, number>;
  emaTotalUsed: number;
}

// ─── v2 Memory schema ─────────────────────────────────────────────────────────

/**
 * Shape of `Memory.analytics.cpuMonitor` (v2 canonical).
 *
 * The legacy `Memory.analytics.moduleCpu` remains available during migration
 * and should NOT be removed by this task.
 */
export interface CpuMonitorMemoryV2 {
  version: 2;
  updatedAt: number;
  sampleInterval: number;
  historyLimit: number;
  latest: CpuMonitorSnapshotV2;
  summary: CpuMonitorSummaryV2 | null;
}

// ─── Raw config input type (read from Memory.cfg.cpuProfiler) ─────────────────

/** Loose user input shape — all fields optional. */
export interface CpuMonitorRawConfig {
  enabled?: boolean;
  sampleInterval?: number;
  historyLimit?: number;
  emaAlpha?: number;
  roomRoleAggregation?: boolean;
  heapStats?: boolean;
  fixedActionCpuCost?: number;
}

// ─── Config normalization ─────────────────────────────────────────────────────

/**
 * Normalize a single numeric field with fallback, floor, and clamp.
 * Returns `fallback` when value is non-finite or not a number.
 */
function normalizeNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return Math.max(min, Math.min(max, floored));
}

/**
 * Normalize the emaAlpha field: must be in (0, 1], default 0.1.
 * Non-finite, negative, or zero values fall back to default.
 */
function normalizeEmaAlpha(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return CPU_MONITOR_DEFAULTS.emaAlpha;
  }
  return Math.min(1, value);
}

/**
 * Normalize the fixedActionCpuCost field: must be non-negative finite, default 0.2.
 */
function normalizeFixedActionCpuCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return CPU_MONITOR_DEFAULTS.fixedActionCpuCost;
  }
  return value;
}

/**
 * Canonical config normalization — the single source of truth for
 * converting raw user config into a valid `CpuMonitorConfig`.
 *
 * Reuses the same min/max clamps as the existing CPU profiler config
 * for sampleInterval and historyLimit.
 */
export function normalizeCpuMonitorConfig(raw: CpuMonitorRawConfig | undefined | null): CpuMonitorConfig {
  if (!raw) {
    return { ...CPU_MONITOR_DEFAULTS };
  }

  return {
    enabled: raw.enabled === true,
    sampleInterval: normalizeNumber(
      raw.sampleInterval,
      CPU_PROFILER_MIN_SAMPLE_INTERVAL,
      CPU_PROFILER_MAX_SAMPLE_INTERVAL,
      CPU_MONITOR_DEFAULTS.sampleInterval,
    ),
    historyLimit: normalizeNumber(
      raw.historyLimit,
      CPU_PROFILER_MIN_HISTORY_LIMIT,
      CPU_PROFILER_MAX_HISTORY_LIMIT,
      CPU_MONITOR_DEFAULTS.historyLimit,
    ),
    emaAlpha: normalizeEmaAlpha(raw.emaAlpha),
    roomRoleAggregation: raw.roomRoleAggregation !== false,
    heapStats: raw.heapStats !== false,
    fixedActionCpuCost: normalizeFixedActionCpuCost(raw.fixedActionCpuCost),
  };
}
