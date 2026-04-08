import {
  CPU_PROFILER_DEFAULT_HISTORY_LIMIT,
  CPU_PROFILER_DEFAULT_SAMPLE_INTERVAL,
  CPU_PROFILER_MAX_HISTORY_LIMIT,
  CPU_PROFILER_MAX_SAMPLE_INTERVAL,
  CPU_PROFILER_MIN_HISTORY_LIMIT,
  CPU_PROFILER_MIN_SAMPLE_INTERVAL,
} from "@/runtime/cpuProfilerConfig";
import { getMemoryService } from "@/runtime/runtimeServices";

interface CpuPhaseSnapshot {
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

type RuntimeGlobalWithCpuProfiler = typeof global & {
  __cpuPhaseHistory?: CpuPhaseSnapshot[];
};

const runtimeGlobal: RuntimeGlobalWithCpuProfiler = global;

export interface TickCpuProfiler {
  measure<T>(phase: string, fn: () => T): T;
  recordFixedAction(phase: string, count?: number): void;
  flush(): void;
}

let activeTickCpuProfiler: TickCpuProfiler = createNoopProfiler();

function normalizeSampleInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CPU_PROFILER_DEFAULT_SAMPLE_INTERVAL;
  }

  const normalized = Math.floor(value);
  return Math.max(CPU_PROFILER_MIN_SAMPLE_INTERVAL, Math.min(CPU_PROFILER_MAX_SAMPLE_INTERVAL, normalized));
}

function normalizeHistoryLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CPU_PROFILER_DEFAULT_HISTORY_LIMIT;
  }

  const normalized = Math.floor(value);
  return Math.max(CPU_PROFILER_MIN_HISTORY_LIMIT, Math.min(CPU_PROFILER_MAX_HISTORY_LIMIT, normalized));
}

function ensureCpuPhaseHistoryStore(): CpuPhaseSnapshot[] {
  if (!runtimeGlobal.__cpuPhaseHistory) {
    runtimeGlobal.__cpuPhaseHistory = [];
  }

  return runtimeGlobal.__cpuPhaseHistory;
}

export function getCpuPhaseHistory(): CpuPhaseSnapshot[] {
  return ensureCpuPhaseHistoryStore();
}

function ensureModuleCpuStore(): NonNullable<NonNullable<Memory["analytics"]>["moduleCpu"]> {
  const analytics = getMemoryService().ensureAnalytics();
  analytics.moduleCpu = analytics.moduleCpu || {
    updatedAt: Game.time,
    sampleInterval: CPU_PROFILER_DEFAULT_SAMPLE_INTERVAL,
    historyLimit: CPU_PROFILER_DEFAULT_HISTORY_LIMIT,
    latest: {
      tick: Game.time,
      shard: Game.shard.name,
      totalUsed: 0,
      bucket: Game.cpu.bucket,
      limit: Game.cpu.limit,
      tickLimit: Game.cpu.tickLimit,
      phases: {},
      fixedActionCounts: {},
      untracked: 0,
    },
  };

  return analytics.moduleCpu;
}

function persistSnapshot(snapshot: CpuPhaseSnapshot, sampleInterval: number, historyLimit: number): void {
  const store = ensureModuleCpuStore();
  const history = [...ensureCpuPhaseHistoryStore(), snapshot];
  while (history.length > historyLimit) {
    history.shift();
  }

  store.updatedAt = Game.time;
  store.sampleInterval = sampleInterval;
  store.historyLimit = historyLimit;
  store.latest = snapshot;
  const storeWithLegacyHistory = store as typeof store & { history?: CpuPhaseSnapshot[] };
  if ("history" in storeWithLegacyHistory) {
    delete storeWithLegacyHistory.history;
  }
  runtimeGlobal.__cpuPhaseHistory = history;
}

function createNoopProfiler(): TickCpuProfiler {
  return {
    measure<T>(_phase: string, fn: () => T): T {
      return fn();
    },
    recordFixedAction(_phase: string, _count = 1): void {
      return;
    },
    flush(): void {
      return;
    },
  };
}

export function setActiveTickCpuProfiler(profiler: TickCpuProfiler): void {
  activeTickCpuProfiler = profiler;
}

export function measureCpuPhase<T>(phase: string, fn: () => T): T {
  return activeTickCpuProfiler.measure(phase, fn);
}

export function measureCreepDecision<T>(fn: () => T): T {
  return measureCpuPhase("creepWork:decision", fn);
}

export function measureCreepPathing<T>(fn: () => T): T {
  return measureCpuPhase("creepWork:pathing", fn);
}

export function measureCreepIntent<T>(fn: () => T): T {
  return measureCpuPhase("creepWork:intent", () => {
    const result = fn();
    if (result === OK) {
      activeTickCpuProfiler.recordFixedAction("creepWork");
    }
    return result;
  });
}

export function recordFixedCpuAction(phase: string, count = 1): void {
  if (count <= 0) {
    return;
  }
  activeTickCpuProfiler.recordFixedAction(phase, count);
}

export function createTickCpuProfiler(): TickCpuProfiler {
  const cfg = Memory.cfg?.cpuProfiler;
  if (!cfg?.enabled) {
    return createNoopProfiler();
  }

  const sampleInterval = normalizeSampleInterval(cfg.sampleInterval);
  const historyLimit = normalizeHistoryLimit(cfg.historyLimit);
  const loopStartUsed = Game.cpu.getUsed();
  const phases: Record<string, number> = {};
  const fixedActionCounts: Record<string, number> = {};

  return {
    measure<T>(phase: string, fn: () => T): T {
      const start = Game.cpu.getUsed();
      try {
        return fn();
      } finally {
        const delta = Math.max(0, Game.cpu.getUsed() - start);
        phases[phase] = (phases[phase] || 0) + delta;
      }
    },

    recordFixedAction(phase: string, count = 1): void {
      fixedActionCounts[phase] = (fixedActionCounts[phase] || 0) + count;
    },

    flush(): void {
      if (Game.time % sampleInterval !== 0) {
        return;
      }

      const totalUsed = Math.max(0, Game.cpu.getUsed() - loopStartUsed);
      const tracked = Object.values(phases).reduce((sum, used) => sum + used, 0);
      const untracked = Math.max(0, totalUsed - tracked);
      const snapshot: CpuPhaseSnapshot = {
        tick: Game.time,
        shard: Game.shard.name,
        totalUsed,
        bucket: Game.cpu.bucket,
        limit: Game.cpu.limit,
        tickLimit: Game.cpu.tickLimit,
        phases: { ...phases },
        fixedActionCounts: { ...fixedActionCounts },
        untracked,
      };

      persistSnapshot(snapshot, sampleInterval, historyLimit);
    },
  };
}
