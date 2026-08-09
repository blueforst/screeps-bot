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
  getCpuMonitorHistory,
  getCpuMonitorEma,
  resetCpuMonitorStore,
  computeEma,
  captureCpuMonitorHeap,
  computeCpuMonitorSummary,
  persistCpuMonitorSample,
} from "@/runtime/cpuMonitor";
import type { CpuMonitorConfig, CpuMonitorRawConfig, CpuMonitorSnapshotV2 } from "@/runtime/cpuMonitor";

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
  // Reset cpu monitor global store
  (global as any).__cpuMonitor = undefined;
  // Reset config so top-level profiler creation never calls getUsed with stale state
  Memory.cfg = {};
  // Reset active profiler to noop
  setActiveTickCpuProfiler(createTickCpuProfiler());
});

afterEach(() => {
  (global as any).__runtimeServices = undefined;
  (global as any).__cpuPhaseHistory = undefined;
  (global as any).__cpuMonitor = undefined;
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

  it("flush persists snapshot to Memory.analytics.cpuMonitor", () => {
    const profiler = createTickCpuProfiler();
    profiler.flush();

    expect(Memory.analytics?.cpuMonitor).toBeDefined();
    expect(Memory.analytics!.cpuMonitor!.latest).toBeDefined();
    expect(Memory.analytics!.cpuMonitor!.latest!.tick).toBe(100);
    expect(Memory.analytics!.cpuMonitor!.version).toBe(2);
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
      measureCreep(_creep: Creep, fn: () => void): void { fn(); },
      measureRoomPhase<T>(_phase: string, _roomName: string, fn: () => T): T { return fn(); },
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
});

// ─── Global store lifecycle ──────────────────────────────────────────────────

describe("fresh deploy", () => {

  it("getCpuMonitorHistory returns the same reference on repeated calls", () => {
    const h1 = getCpuMonitorHistory();
    const h2 = getCpuMonitorHistory();
    expect(h1).toBe(h2);
  });

  it("resetCpuMonitorStore clears history and EMA", () => {
    const store = getCpuMonitorHistory();
    store.push({ tick: 1 } as CpuMonitorSnapshotV2);
    expect(getCpuMonitorHistory()).toHaveLength(1);

    resetCpuMonitorStore();
    expect(getCpuMonitorHistory()).toEqual([]);
    expect(getCpuMonitorEma()).toBe(0);
  });
});

// ─── History limit ────────────────────────────────────────────────────────────

describe("history limit", () => {
  let config: CpuMonitorConfig;

  beforeEach(() => {
    Game.time = 100;
    Game.shard = { name: "shard3" } as Game["shard"];
    Game.cpu = {
      getUsed: jest.fn(() => 0),
      bucket: 9000,
      limit: 20,
      tickLimit: 500,
    } as unknown as typeof Game.cpu;
    config = { ...CPU_MONITOR_DEFAULTS, enabled: true, historyLimit: 15, sampleInterval: 1 };
  });

  function makeSnapshot(tick: number, totalUsed: number): CpuMonitorSnapshotV2 {
    return {
      tick,
      shard: "shard3",
      totalUsed,
      bucket: 9000,
      limit: 20,
      tickLimit: 500,
      phases: {},
      fixedActionCounts: {},
      untracked: 0,
      emaTotalUsed: 0,
      rooms: {},
      heap: null,
    };
  }

  it("persists latest + summary to Memory.analytics.cpuMonitor", () => {
    persistCpuMonitorSample(makeSnapshot(100, 10), config);

    const persisted = Memory.analytics!.cpuMonitor!;
    expect(persisted.version).toBe(2);
    expect(persisted.updatedAt).toBe(100);
    expect(persisted.sampleInterval).toBe(1);
    expect(persisted.historyLimit).toBe(15);
    expect(persisted.latest.tick).toBe(100);
    expect(persisted.latest.emaTotalUsed).toBe(10);
    expect(persisted.summary).not.toBeNull();
    expect(persisted.summary!.ticks).toBe(1);
    expect(persisted.summary!.avgTotalUsed).toBeCloseTo(10, 5);
    expect(persisted.summary!.emaTotalUsed).toBe(10);
  });
});

// ─── Zero-overhead paths ──────────────────────────────────────────────────────

describe("zero overhead", () => {

  it("enabled non-sample tick never calls Game.cpu.getUsed", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 10 } };
    Game.time = 101;
    Game.cpu = {
      getUsed: () => {
        throw new Error("getUsed called on non-sample tick!");
      },
    } as unknown as typeof Game.cpu;

    const profiler = createTickCpuProfiler();
    expect(profiler.measure("a", () => 42)).toBe(42);
    profiler.recordFixedAction("b", 1);
    profiler.flush();
  });
});

// ─── Sample tick v2 data ──────────────────────────────────────────────────────

describe("sample tick v2 data", () => {
  beforeEach(() => {
    Memory.cfg = {
      cpuProfiler: { enabled: true, sampleInterval: 1, historyLimit: 10 },
    };
    Game.time = 100;
    Game.shard = { name: "shard3" } as Game["shard"];
    Game.cpu = {
      getUsed: jest.fn(deterministicGetUsed([10, 11, 13, 16])),
      bucket: 9000,
      limit: 20,
      tickLimit: 500,
    } as unknown as typeof Game.cpu;
  });

  it("writes to Memory.analytics.cpuMonitor with version 2", () => {
    const profiler = createTickCpuProfiler();
    profiler.flush();

    expect(Memory.analytics?.cpuMonitor).toBeDefined();
    expect(Memory.analytics!.cpuMonitor!.version).toBe(2);
  });
});

// ─── Overhead bound ───────────────────────────────────────────────────────────

describe("overhead bound", () => {
  it("deterministic 100-sample overhead <= 0.5 CPU/tick", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 1, historyLimit: 120 } };
    Game.shard = { name: "shard3" } as Game["shard"];
    Game.cpu = {
      getUsed: jest.fn(),
      bucket: 9000,
      limit: 20,
      tickLimit: 500,
    } as unknown as typeof Game.cpu;

    const ticks = 100;
    const overheadPerGetUsedCall = 0.002;

    for (let t = 0; t < ticks; t++) {
      Game.time = 100 + t;
      let cpuBase = 10.0;

      (Game.cpu.getUsed as jest.Mock).mockImplementation(() => {
        cpuBase += overheadPerGetUsedCall;
        return cpuBase;
      });

      const profiler = createTickCpuProfiler();
      profiler.measure("noop", () => undefined);
      profiler.flush();
    }

    const history = getCpuMonitorHistory();
    expect(history).toHaveLength(ticks);

    const avgTotalUsed = history.reduce((sum, s) => sum + s.totalUsed, 0) / ticks;
    expect(avgTotalUsed).toBeLessThanOrEqual(0.5);
  });
});

// ─── Room/role aggregation ────────────────────────────────────────────────────

describe("room role aggregation", () => {
  beforeEach(() => {
    Memory.cfg = {
      cpuProfiler: { enabled: true, sampleInterval: 1, historyLimit: 10 },
    };
    Game.time = 100;
    Game.shard = { name: "shard3" } as Game["shard"];
    Game.cpu = {
      getUsed: jest.fn(),
      bucket: 9000,
      limit: 20,
      tickLimit: 500,
    } as unknown as typeof Game.cpu;
  });

  function makeMockCreep(role: string, roomName: string): Creep {
    return {
      memory: { role },
      room: { name: roomName } as Room,
      pos: { roomName } as RoomPosition,
    } as unknown as Creep;
  }

  it("separates two creeps in two rooms/roles into distinct buckets", () => {
    // getUsed sequence: 10 (constructor) -> 11 (start creep1) -> 13 (end creep1)
    //   -> 13 (start creep2) -> 16 (end creep2) -> 16 (flush)
    const getUsed = deterministicGetUsed([10, 11, 13, 13, 16, 16]);
    (Game.cpu.getUsed as jest.Mock).mockImplementation(getUsed);

    const profiler = createTickCpuProfiler();

    const creep1 = makeMockCreep("worker", "W1N1");
    const creep2 = makeMockCreep("carrier", "W2N2");

    profiler.measureCreep(creep1, () => undefined);
    profiler.measureCreep(creep2, () => undefined);
    profiler.flush();

    const snapshot = getCpuMonitorHistory()[0];
    expect(snapshot.rooms["W1N1"]).toBeDefined();
    expect(snapshot.rooms["W1N1"].roles.worker).toBeDefined();
    expect(snapshot.rooms["W1N1"].roles.worker.used).toBeCloseTo(2, 5);
    expect(snapshot.rooms["W1N1"].roles.worker.count).toBe(1);

    expect(snapshot.rooms["W2N2"]).toBeDefined();
    expect(snapshot.rooms["W2N2"].roles.carrier).toBeDefined();
    expect(snapshot.rooms["W2N2"].roles.carrier.used).toBeCloseTo(3, 5);
    expect(snapshot.rooms["W2N2"].roles.carrier.count).toBe(1);
  });
});
