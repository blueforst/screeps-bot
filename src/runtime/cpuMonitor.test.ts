import {
  createTickCpuProfiler,
  measureCpuPhase,
  setActiveTickCpuProfiler,
} from "@/runtime/cpuPhaseProfiler";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import {
  getCpuMonitorHistory,
  getCpuMonitorEma,
  resetCpuMonitorStore,
} from "@/runtime/cpuMonitor";

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

describe("CPU monitor runtime contract", () => {
  function configureCpu(values: number[]): void {
    Game.time = 100;
    Game.shard = { name: "shard3" } as Game["shard"];
    Game.cpu = {
      getUsed: jest.fn(deterministicGetUsed(values)),
      bucket: 9000,
      limit: 20,
      tickLimit: 500,
    } as unknown as typeof Game.cpu;
  }

  it("persists sampled v2 snapshots and summaries while non-sample ticks stay zero-overhead", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 1, historyLimit: 15 } };
    configureCpu([10, 11, 13, 15]);

    const profiler = createTickCpuProfiler();
    profiler.flush();

    const persisted = Memory.analytics!.cpuMonitor!;
    expect(persisted.version).toBe(2);
    expect(persisted.updatedAt).toBe(100);
    expect(persisted.sampleInterval).toBe(1);
    expect(persisted.historyLimit).toBe(15);
    expect(persisted.latest.tick).toBe(100);
    expect(persisted.summary).not.toBeNull();
    expect(persisted.summary!.ticks).toBe(1);

    resetCpuMonitorStore();
    Memory.analytics = undefined;
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 10 } };
    Game.time = 101;
    Game.cpu = {
      getUsed: () => {
        throw new Error("getUsed called on non-sample tick");
      },
    } as unknown as typeof Game.cpu;

    const nonSampleProfiler = createTickCpuProfiler();
    expect(nonSampleProfiler.measure("noop", () => 42)).toBe(42);
    nonSampleProfiler.flush();
    expect(getCpuMonitorHistory()).toHaveLength(0);
    expect(Memory.analytics?.cpuMonitor).toBeUndefined();
  });

  it("switches the active profiler, separates room-role buckets, and clears deploy state", () => {
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

    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 1, historyLimit: 10 } };
    configureCpu([10, 11, 13, 13, 16, 16]);
    const profiler = createTickCpuProfiler();
    const worker = {
      memory: { role: "worker" },
      room: { name: "W1N1" } as Room,
      pos: { roomName: "W1N1" } as RoomPosition,
    } as unknown as Creep;
    const carrier = {
      memory: { role: "carrier" },
      room: { name: "W2N2" } as Room,
      pos: { roomName: "W2N2" } as RoomPosition,
    } as unknown as Creep;

    profiler.measureCreep(worker, () => undefined);
    profiler.measureCreep(carrier, () => undefined);
    profiler.flush();

    const snapshot = getCpuMonitorHistory()[0];
    expect(snapshot.rooms.W1N1.roles.worker.used).toBeCloseTo(2, 5);
    expect(snapshot.rooms.W1N1.roles.worker.count).toBe(1);
    expect(snapshot.rooms.W2N2.roles.carrier.used).toBeCloseTo(3, 5);
    expect(snapshot.rooms.W2N2.roles.carrier.count).toBe(1);

    resetCpuMonitorStore();
    expect(getCpuMonitorHistory()).toEqual([]);
    expect(getCpuMonitorEma()).toBe(0);
  });
});
