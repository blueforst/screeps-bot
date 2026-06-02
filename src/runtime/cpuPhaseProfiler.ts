import {
  normalizeCpuMonitorConfig,
  persistCpuMonitorSample,
  captureCpuMonitorHeap,
  getCpuMonitorHistory,
} from "@/runtime/cpuMonitor";
import type { CpuMonitorSnapshotV2 } from "@/runtime/cpuMonitor";

export interface TickCpuProfiler {
  measure<T>(phase: string, fn: () => T): T;
  recordFixedAction(phase: string, count?: number): void;
  flush(): void;
}

let activeTickCpuProfiler: TickCpuProfiler = createNoopProfiler();

/**
 * @deprecated Use `getCpuMonitorHistory()` from `cpuMonitor.ts` for v2 history.
 * Returns v2 snapshots which are a structural superset of the legacy `CpuPhaseSnapshot`.
 */
export function getCpuPhaseHistory(): CpuMonitorSnapshotV2[] {
  return getCpuMonitorHistory();
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
  const config = normalizeCpuMonitorConfig(Memory.cfg?.cpuProfiler);

  // Zero-overhead: disabled profiler never calls Game.cpu.getUsed()
  if (!config.enabled) {
    return createNoopProfiler();
  }

  // Zero-overhead: enabled but non-sample tick never calls Game.cpu.getUsed()
  if (Game.time % config.sampleInterval !== 0) {
    return createNoopProfiler();
  }

  // Sample tick: measure CPU with full instrumentation
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
      const totalUsed = Math.max(0, Game.cpu.getUsed() - loopStartUsed);
      const tracked = Object.values(phases).reduce((sum, used) => sum + used, 0);
      const untracked = Math.max(0, totalUsed - tracked);
      const heap = captureCpuMonitorHeap(config);

      const snapshot: CpuMonitorSnapshotV2 = {
        tick: Game.time,
        shard: Game.shard.name,
        totalUsed,
        bucket: Game.cpu.bucket,
        limit: Game.cpu.limit,
        tickLimit: Game.cpu.tickLimit,
        phases: { ...phases },
        fixedActionCounts: { ...fixedActionCounts },
        untracked,
        emaTotalUsed: 0, // overwritten by persistCpuMonitorSample
        rooms: {},
        heap,
      };

      persistCpuMonitorSample(snapshot, config);
    },
  };
}
