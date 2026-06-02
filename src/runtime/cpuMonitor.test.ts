import {
  createTickCpuProfiler,
  getCpuPhaseHistory,
  measureCreepIntent,
  measureCpuPhase,
  measureCreepDecision,
  measureCreepPathing,
  recordFixedCpuAction,
  setActiveTickCpuProfiler,
} from "@/runtime/cpuPhaseProfiler";
import { CPU_PROFILER_MIN_HISTORY_LIMIT } from "@/runtime/cpuProfilerConfig";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import {
  normalizeCpuMonitorConfig,
  CPU_MONITOR_DEFAULTS,
} from "@/runtime/cpuMonitor";
import type { CpuMonitorConfig, CpuMonitorRawConfig } from "@/runtime/cpuMonitor";

/**
 * Characterization tests for CPU phase profiler contracts.
 * These tests lock down current behaviour before the v2 rewrite.
 */

// Helper: create a deterministic getUsed that returns values from an array in order.
function deterministicGetUsed(values: number[]): () => number {
  let idx = 0;
  return () => {
    const v = values[idx];
    idx = Math.min(idx + 1, values.length - 1);
    return v;
  };
}

beforeEach(() => {
  // Reset runtime services (cached on global.__runtimeServices)
  (global as any).__runtimeServices = undefined;
  registerRuntimeServices();
  // Reset cpu profiler history store
  (global as any).__cpuPhaseHistory = undefined;
  // Reset active profiler to noop
  setActiveTickCpuProfiler(createTickCpuProfiler());
});

afterEach(() => {
  (global as any).__runtimeServices = undefined;
  (global as any).__cpuPhaseHistory = undefined;
});

// ─── Noop / disabled profiler ────────────────────────────────────────────────

describe("noop profiler (cpuProfiler not enabled)", () => {
  beforeEach(() => {
    Memory.cfg = {};
    setActiveTickCpuProfiler(createTickCpuProfiler());
  });

  it("measure returns the callback result unchanged", () => {
    const profiler = createTickCpuProfiler();
    const result = profiler.measure("testPhase", () => 42);
    expect(result).toBe(42);
  });

  it("measure passes through string results", () => {
    const profiler = createTickCpuProfiler();
    const result = profiler.measure("testPhase", () => "hello");
    expect(result).toBe("hello");
  });

  it("measure propagates exceptions from callback", () => {
    const profiler = createTickCpuProfiler();
    expect(() =>
      profiler.measure("boom", () => {
        throw new Error("kaboom");
      }),
    ).toThrow("kaboom");
  });

  it("recordFixedAction is a no-op (does not throw)", () => {
    const profiler = createTickCpuProfiler();
    expect(() => profiler.recordFixedAction("any", 5)).not.toThrow();
  });

  it("flush is a no-op (does not throw or write)", () => {
    const profiler = createTickCpuProfiler();
    profiler.flush();
    expect(Memory.analytics?.moduleCpu).toBeUndefined();
  });
});

// ─── Enabled profiler with sampling ──────────────────────────────────────────

describe("enabled profiler (cpuProfiler.enabled = true)", () => {
  beforeEach(() => {
    Memory.cfg = {
      cpuProfiler: { enabled: true, sampleInterval: 1, historyLimit: 10 },
    };
    Game.time = 100;
    Game.shard = { name: "shard3" } as Game["shard"];
    Game.cpu = {
      getUsed: jest.fn(deterministicGetUsed([10, 11, 13, 15])),
      bucket: 9000,
      limit: 20,
      tickLimit: 500,
    } as unknown as typeof Game.cpu;
  });

  it("measure accumulates CPU delta per phase label", () => {
    // getUsed sequence: 10 (constructor) -> 11 (start measure "a") -> 13 (end measure "a")
    const getUsed = deterministicGetUsed([10, 11, 13]);
    (Game.cpu.getUsed as jest.Mock).mockImplementation(getUsed);

    const profiler = createTickCpuProfiler();
    profiler.measure("phaseA", () => undefined);
    profiler.flush();

    const history = getCpuPhaseHistory();
    expect(history).toHaveLength(1);
    expect(history[0].phases.phaseA).toBeCloseTo(2, 5);
  });

  it("measure accumulates repeated calls to the same phase", () => {
    const getUsed = deterministicGetUsed([10, 10.5, 11, 11.5, 12]);
    (Game.cpu.getUsed as jest.Mock).mockImplementation(getUsed);

    const profiler = createTickCpuProfiler();
    profiler.measure("x", () => undefined);
    profiler.measure("x", () => undefined);
    profiler.flush();

    const history = getCpuPhaseHistory();
    expect(history).toHaveLength(1);
    expect(history[0].phases.x).toBeCloseTo(1, 5);
  });

  it("measure<T> passes through the return value", () => {
    const getUsed = deterministicGetUsed([10, 11]);
    (Game.cpu.getUsed as jest.Mock).mockImplementation(getUsed);

    const profiler = createTickCpuProfiler();
    const val = profiler.measure("ret", () => ({ a: 1 }));
    expect(val).toEqual({ a: 1 });
  });

  it("measure propagates exceptions and still records CPU", () => {
    // getUsed: 10 (constructor) -> 11 (start "errPhase") -> 13 (finally end "errPhase") -> 15 (flush)
    const getUsed = deterministicGetUsed([10, 11, 13, 15]);
    (Game.cpu.getUsed as jest.Mock).mockImplementation(getUsed);

    const profiler = createTickCpuProfiler();
    expect(() =>
      profiler.measure("errPhase", () => {
        throw new Error("fail");
      }),
    ).toThrow("fail");

    profiler.flush();
    const history = getCpuPhaseHistory();
    expect(history).toHaveLength(1);
    expect(history[0].phases.errPhase).toBeCloseTo(2, 5);
  });

  it("recordFixedAction accumulates counts by phase", () => {
    const profiler = createTickCpuProfiler();
    profiler.recordFixedAction("tower", 3);
    profiler.recordFixedAction("tower", 2);
    profiler.recordFixedAction("creep", 1);
    profiler.flush();

    const history = getCpuPhaseHistory();
    expect(history).toHaveLength(1);
    expect(history[0].fixedActionCounts.tower).toBe(5);
    expect(history[0].fixedActionCounts.creep).toBe(1);
  });

  it("flush skips sampling when Game.time % sampleInterval !== 0", () => {
    Memory.cfg!.cpuProfiler!.sampleInterval = 5;
    Game.time = 101; // 101 % 5 !== 0

    const profiler = createTickCpuProfiler();
    profiler.measure("a", () => undefined);
    profiler.flush();

    expect(getCpuPhaseHistory()).toHaveLength(0);
  });

  it("flush persists snapshot with untracked delta", () => {
    // getUsed: 10 (constructor) -> 11 (start "a") -> 13 (end "a") -> 16 (flush totalUsed)
    const getUsed = deterministicGetUsed([10, 11, 13, 16]);
    (Game.cpu.getUsed as jest.Mock).mockImplementation(getUsed);

    const profiler = createTickCpuProfiler();
    profiler.measure("a", () => undefined);
    profiler.flush();

    const snap = getCpuPhaseHistory()[0];
    expect(snap.totalUsed).toBeCloseTo(6, 5);
    expect(snap.phases.a).toBeCloseTo(2, 5);
    expect(snap.untracked).toBeCloseTo(4, 5);
    expect(snap.bucket).toBe(9000);
    expect(snap.limit).toBe(20);
    expect(snap.tickLimit).toBe(500);
    expect(snap.tick).toBe(100);
    expect(snap.shard).toBe("shard3");
  });

  it("flush persists snapshot to Memory.analytics.moduleCpu", () => {
    const profiler = createTickCpuProfiler();
    profiler.flush();

    expect(Memory.analytics?.moduleCpu).toBeDefined();
    expect(Memory.analytics!.moduleCpu!.latest).toBeDefined();
    expect(Memory.analytics!.moduleCpu!.latest!.tick).toBe(100);
  });

  it("history respects historyLimit and evicts oldest entries", () => {
    Memory.cfg!.cpuProfiler!.historyLimit = CPU_PROFILER_MIN_HISTORY_LIMIT;
    const totalTicks = CPU_PROFILER_MIN_HISTORY_LIMIT + 3;

    for (let t = 100; t < 100 + totalTicks; t++) {
      Game.time = t;
      (Game.cpu.getUsed as jest.Mock).mockImplementation(deterministicGetUsed([10, 10]));
      const profiler = createTickCpuProfiler();
      profiler.flush();
    }

    const history = getCpuPhaseHistory();
    expect(history).toHaveLength(CPU_PROFILER_MIN_HISTORY_LIMIT);
    expect(history[0].tick).toBe(103);
    expect(history[history.length - 1].tick).toBe(100 + totalTicks - 1);
  });
});

// ─── recordFixedCpuAction helper ─────────────────────────────────────────────

describe("recordFixedCpuAction", () => {
  it("delegates to active profiler recordFixedAction", () => {
    let recorded = false;
    let recordedPhase = "";
    let recordedCount = 0;

    setActiveTickCpuProfiler({
      measure<T>(_phase: string, fn: () => T): T {
        return fn();
      },
      recordFixedAction(phase: string, count = 1): void {
        recorded = true;
        recordedPhase = phase;
        recordedCount = count;
      },
      flush(): void {},
    });

    recordFixedCpuAction("myPhase", 3);
    expect(recorded).toBe(true);
    expect(recordedPhase).toBe("myPhase");
    expect(recordedCount).toBe(3);
  });

  it("does nothing when count <= 0", () => {
    let recorded = false;
    setActiveTickCpuProfiler({
      measure<T>(_phase: string, fn: () => T): T {
        return fn();
      },
      recordFixedAction(): void {
        recorded = true;
      },
      flush(): void {},
    });

    recordFixedCpuAction("x", 0);
    expect(recorded).toBe(false);

    recordFixedCpuAction("x", -1);
    expect(recorded).toBe(false);
  });

  it("defaults count to 1", () => {
    let recordedCount = 0;
    setActiveTickCpuProfiler({
      measure<T>(_phase: string, fn: () => T): T {
        return fn();
      },
      recordFixedAction(_phase: string, count = 1): void {
        recordedCount = count;
      },
      flush(): void {},
    });

    recordFixedCpuAction("x");
    expect(recordedCount).toBe(1);
  });
});

// ─── measureCreepIntent ──────────────────────────────────────────────────────

describe("measureCreepIntent", () => {
  it("wraps fn in creepWork:intent measure and records fixed action when result is OK", () => {
    let fixedRecorded = false;
    let measurePhase = "";

    setActiveTickCpuProfiler({
      measure<T>(phase: string, fn: () => T): T {
        measurePhase = phase;
        return fn();
      },
      recordFixedAction(phase: string, _count = 1): void {
        if (phase === "creepWork") fixedRecorded = true;
      },
      flush(): void {},
    });

    const result = measureCreepIntent(() => OK);
    expect(result).toBe(OK);
    expect(measurePhase).toBe("creepWork:intent");
    expect(fixedRecorded).toBe(true);
  });

  it("does not record fixed action when result is not OK", () => {
    let fixedRecorded = false;

    setActiveTickCpuProfiler({
      measure<T>(_phase: string, fn: () => T): T {
        return fn();
      },
      recordFixedAction(phase: string, _count = 1): void {
        if (phase === "creepWork") fixedRecorded = true;
      },
      flush(): void {},
    });

    const result = measureCreepIntent(() => ERR_NOT_ENOUGH_RESOURCES);
    expect(result).toBe(ERR_NOT_ENOUGH_RESOURCES);
    expect(fixedRecorded).toBe(false);
  });

  it("passes through non-number results without recording fixed action", () => {
    let fixedRecorded = false;

    setActiveTickCpuProfiler({
      measure<T>(_phase: string, fn: () => T): T {
        return fn();
      },
      recordFixedAction(): void {
        fixedRecorded = true;
      },
      flush(): void {},
    });

    const result = measureCreepIntent(() => null as any);
    expect(result).toBeNull();
    expect(fixedRecorded).toBe(false);
  });
});

// ─── measureCreepDecision and measureCreepPathing ────────────────────────────

describe("measureCreepDecision and measureCreepPathing", () => {
  it("measureCreepDecision measures under creepWork:decision", () => {
    let phase = "";
    setActiveTickCpuProfiler({
      measure<T>(p: string, fn: () => T): T {
        phase = p;
        return fn();
      },
      recordFixedAction(): void {},
      flush(): void {},
    });

    measureCreepDecision(() => 42);
    expect(phase).toBe("creepWork:decision");
  });

  it("measureCreepPathing measures under creepWork:pathing", () => {
    let phase = "";
    setActiveTickCpuProfiler({
      measure<T>(p: string, fn: () => T): T {
        phase = p;
        return fn();
      },
      recordFixedAction(): void {},
      flush(): void {},
    });

    measureCreepPathing(() => 42);
    expect(phase).toBe("creepWork:pathing");
  });
});

// ─── getCpuPhaseHistory ──────────────────────────────────────────────────────

describe("getCpuPhaseHistory", () => {
  it("returns empty array initially", () => {
    expect(getCpuPhaseHistory()).toEqual([]);
  });

  it("returns the same array reference as the global store", () => {
    const history = getCpuPhaseHistory();
    history.push({
      tick: 1,
      shard: "test",
      totalUsed: 0,
      bucket: 0,
      limit: 0,
      tickLimit: 0,
      phases: {},
      fixedActionCounts: {},
      untracked: 0,
    });
    expect(getCpuPhaseHistory()).toHaveLength(1);
  });
});

// ─── setActiveTickCpuProfiler ────────────────────────────────────────────────

describe("setActiveTickCpuProfiler", () => {
  it("switches the active profiler used by measureCpuPhase", () => {
    let called = false;
    setActiveTickCpuProfiler({
      measure<T>(_phase: string, fn: () => T): T {
        called = true;
        return fn();
      },
      recordFixedAction(): void {},
      flush(): void {},
    });

    measureCpuPhase("anything", () => undefined);
    expect(called).toBe(true);
  });
});

// ─── Config normalisation edge cases ─────────────────────────────────────────

describe("config normalisation", () => {
  beforeEach(() => {
    Game.time = 10;
    Game.shard = { name: "shard3" } as Game["shard"];
    Game.cpu = {
      getUsed: jest.fn(() => 0),
      bucket: 9000,
      limit: 20,
      tickLimit: 500,
    } as unknown as typeof Game.cpu;
  });

  it("uses default sample interval when cfg.cpuProfiler.sampleInterval is missing", () => {
    Memory.cfg = { cpuProfiler: { enabled: true } };
    const profiler = createTickCpuProfiler();
    // Tick 10 with default interval=10: 10 % 10 === 0, so flush records
    profiler.flush();
    expect(getCpuPhaseHistory()).toHaveLength(1);
  });

  it("clamps sample interval to minimum", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: -5 } };
    const profiler = createTickCpuProfiler();
    // Normalized to min(1), so tick 10 % 1 === 0 always
    profiler.flush();
    expect(getCpuPhaseHistory()).toHaveLength(1);
  });

  it("clamps sample interval to maximum", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 999 } };
    const profiler = createTickCpuProfiler();
    // Normalized to max(100), 10 % 100 !== 0, so no sample
    profiler.flush();
    expect(getCpuPhaseHistory()).toHaveLength(0);
  });

  it("handles non-numeric sampleInterval gracefully", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: "bad" as any } };
    const profiler = createTickCpuProfiler();
    // Falls back to default 10, tick 10 % 10 === 0
    profiler.flush();
    expect(getCpuPhaseHistory()).toHaveLength(1);
  });

  it("handles NaN historyLimit gracefully", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, historyLimit: NaN } };
    const profiler = createTickCpuProfiler();
    profiler.flush();
    expect(getCpuPhaseHistory()).toHaveLength(1);
    // Defaults to 120 limit, stored in Memory.analytics
    expect(Memory.analytics!.moduleCpu!.historyLimit).toBe(120);
  });
});

// ─── CPU Monitor v2 config normalization ──────────────────────────────────────

describe("cpu monitor v2 config normalization", () => {
  it("returns all defaults when given undefined", () => {
    const config = normalizeCpuMonitorConfig(undefined);
    expect(config).toEqual(CPU_MONITOR_DEFAULTS);
  });

  it("returns all defaults when given null", () => {
    const config = normalizeCpuMonitorConfig(null);
    expect(config).toEqual(CPU_MONITOR_DEFAULTS);
  });

  it("returns all defaults when given empty object", () => {
    const config = normalizeCpuMonitorConfig({});
    expect(config).toEqual({
      ...CPU_MONITOR_DEFAULTS,
      enabled: false,
    });
  });

  it("preserves valid enabled=true", () => {
    const config = normalizeCpuMonitorConfig({ enabled: true });
    expect(config.enabled).toBe(true);
  });

  it("treats enabled=undefined as false", () => {
    const config = normalizeCpuMonitorConfig({});
    expect(config.enabled).toBe(false);
  });

  it("preserves valid sampleInterval", () => {
    const config = normalizeCpuMonitorConfig({ sampleInterval: 5 });
    expect(config.sampleInterval).toBe(5);
  });

  it("clamps sampleInterval to minimum (1)", () => {
    const config = normalizeCpuMonitorConfig({ sampleInterval: -5 });
    expect(config.sampleInterval).toBe(1);
  });

  it("clamps sampleInterval to maximum (100)", () => {
    const config = normalizeCpuMonitorConfig({ sampleInterval: 999 });
    expect(config.sampleInterval).toBe(100);
  });

  it("sanitizes string sampleInterval to default", () => {
    const config = normalizeCpuMonitorConfig({ sampleInterval: "bad" as any });
    expect(config.sampleInterval).toBe(10);
  });

  it("sanitizes NaN sampleInterval to default", () => {
    const config = normalizeCpuMonitorConfig({ sampleInterval: NaN });
    expect(config.sampleInterval).toBe(10);
  });

  it("sanitizes Infinity sampleInterval to default", () => {
    const config = normalizeCpuMonitorConfig({ sampleInterval: Infinity });
    expect(config.sampleInterval).toBe(10);
  });

  it("floors fractional sampleInterval", () => {
    const config = normalizeCpuMonitorConfig({ sampleInterval: 3.7 });
    expect(config.sampleInterval).toBe(3);
  });

  it("preserves valid historyLimit", () => {
    const config = normalizeCpuMonitorConfig({ historyLimit: 200 });
    expect(config.historyLimit).toBe(200);
  });

  it("clamps historyLimit to minimum (10)", () => {
    const config = normalizeCpuMonitorConfig({ historyLimit: 2 });
    expect(config.historyLimit).toBe(10);
  });

  it("clamps historyLimit to maximum (1000)", () => {
    const config = normalizeCpuMonitorConfig({ historyLimit: 5000 });
    expect(config.historyLimit).toBe(1000);
  });

  it("clamps negative historyLimit to minimum", () => {
    const config = normalizeCpuMonitorConfig({ historyLimit: -100 });
    expect(config.historyLimit).toBe(10);
  });

  it("sanitizes string historyLimit to default", () => {
    const config = normalizeCpuMonitorConfig({ historyLimit: "x" as any });
    expect(config.historyLimit).toBe(120);
  });

  it("sanitizes NaN historyLimit to default", () => {
    const config = normalizeCpuMonitorConfig({ historyLimit: NaN });
    expect(config.historyLimit).toBe(120);
  });

  it("sanitizes -Infinity historyLimit to default", () => {
    const config = normalizeCpuMonitorConfig({ historyLimit: -Infinity });
    expect(config.historyLimit).toBe(120);
  });

  it("floors fractional historyLimit", () => {
    const config = normalizeCpuMonitorConfig({ historyLimit: 55.9 });
    expect(config.historyLimit).toBe(55);
  });

  it("preserves valid emaAlpha", () => {
    const config = normalizeCpuMonitorConfig({ emaAlpha: 0.3 });
    expect(config.emaAlpha).toBe(0.3);
  });

  it("clamps emaAlpha to 1", () => {
    const config = normalizeCpuMonitorConfig({ emaAlpha: 2.5 });
    expect(config.emaAlpha).toBe(1);
  });

  it("sanitizes zero emaAlpha to default", () => {
    const config = normalizeCpuMonitorConfig({ emaAlpha: 0 });
    expect(config.emaAlpha).toBe(0.1);
  });

  it("sanitizes negative emaAlpha to default", () => {
    const config = normalizeCpuMonitorConfig({ emaAlpha: -0.5 });
    expect(config.emaAlpha).toBe(0.1);
  });

  it("sanitizes NaN emaAlpha to default", () => {
    const config = normalizeCpuMonitorConfig({ emaAlpha: NaN });
    expect(config.emaAlpha).toBe(0.1);
  });

  it("sanitizes string emaAlpha to default", () => {
    const config = normalizeCpuMonitorConfig({ emaAlpha: "fast" as any });
    expect(config.emaAlpha).toBe(0.1);
  });

  it("preserves roomRoleAggregation=true", () => {
    const config = normalizeCpuMonitorConfig({ roomRoleAggregation: true });
    expect(config.roomRoleAggregation).toBe(true);
  });

  it("defaults roomRoleAggregation to true when missing", () => {
    const config = normalizeCpuMonitorConfig({});
    expect(config.roomRoleAggregation).toBe(true);
  });

  it("allows roomRoleAggregation=false", () => {
    const config = normalizeCpuMonitorConfig({ roomRoleAggregation: false });
    expect(config.roomRoleAggregation).toBe(false);
  });

  it("preserves heapStats=true", () => {
    const config = normalizeCpuMonitorConfig({ heapStats: true });
    expect(config.heapStats).toBe(true);
  });

  it("defaults heapStats to true when missing", () => {
    const config = normalizeCpuMonitorConfig({});
    expect(config.heapStats).toBe(true);
  });

  it("allows heapStats=false", () => {
    const config = normalizeCpuMonitorConfig({ heapStats: false });
    expect(config.heapStats).toBe(false);
  });

  it("preserves valid fixedActionCpuCost", () => {
    const config = normalizeCpuMonitorConfig({ fixedActionCpuCost: 0.5 });
    expect(config.fixedActionCpuCost).toBe(0.5);
  });

  it("sanitizes negative fixedActionCpuCost to default", () => {
    const config = normalizeCpuMonitorConfig({ fixedActionCpuCost: -1 });
    expect(config.fixedActionCpuCost).toBe(0.2);
  });

  it("sanitizes NaN fixedActionCpuCost to default", () => {
    const config = normalizeCpuMonitorConfig({ fixedActionCpuCost: NaN });
    expect(config.fixedActionCpuCost).toBe(0.2);
  });

  it("sanitizes string fixedActionCpuCost to default", () => {
    const config = normalizeCpuMonitorConfig({ fixedActionCpuCost: "free" as any });
    expect(config.fixedActionCpuCost).toBe(0.2);
  });

  it("allows fixedActionCpuCost=0", () => {
    const config = normalizeCpuMonitorConfig({ fixedActionCpuCost: 0 });
    expect(config.fixedActionCpuCost).toBe(0);
  });

  it("preserves all fields from a complete valid config", () => {
    const raw: CpuMonitorRawConfig = {
      enabled: true,
      sampleInterval: 5,
      historyLimit: 200,
      emaAlpha: 0.2,
      roomRoleAggregation: false,
      heapStats: false,
      fixedActionCpuCost: 0.5,
    };
    const config = normalizeCpuMonitorConfig(raw);
    expect(config).toEqual({
      enabled: true,
      sampleInterval: 5,
      historyLimit: 200,
      emaAlpha: 0.2,
      roomRoleAggregation: false,
      heapStats: false,
      fixedActionCpuCost: 0.5,
    } satisfies CpuMonitorConfig);
  });
});
