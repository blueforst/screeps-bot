import { clearCreepMovementStateForTest, clearMovementAnalyticsForTest, ensureCreepMovementState, getMovementAnalyticsForTest } from "@/movement";
import { runExternalTelemetryExport } from "@/runtime/externalTelemetry";
import { resetCpuMonitorStore } from "@/runtime/cpuMonitor";

function makeV2Snapshot(overrides: Partial<{
  tick: number;
  shard: string;
  totalUsed: number;
  bucket: number;
  limit: number;
  tickLimit: number;
  phases: Record<string, number>;
  fixedActionCounts: Record<string, number>;
  untracked: number;
  emaTotalUsed: number;
  rooms: Record<string, { totalUsed: number; roles: Record<string, { count: number; used: number }> }>;
  heap: { used_heap_size: number; total_heap_size: number; heap_size_limit: number } | null;
}> = {}) {
  return {
    tick: overrides.tick ?? 100,
    shard: overrides.shard ?? "shardTest",
    totalUsed: overrides.totalUsed ?? 12.5,
    bucket: overrides.bucket ?? 9000,
    limit: overrides.limit ?? 20,
    tickLimit: overrides.tickLimit ?? 500,
    phases: overrides.phases ?? { creepWork: 5.0, spawnWork: 3.0 },
    fixedActionCounts: overrides.fixedActionCounts ?? { creepWork: 10 },
    untracked: overrides.untracked ?? 2.5,
    emaTotalUsed: overrides.emaTotalUsed ?? 11.8,
    rooms: overrides.rooms ?? {},
    heap: overrides.heap ?? null,
  };
}

function setupBasicEnv() {
  Game.time = 5;
  Memory.cfg = {
    telemetry: {
      enabled: true,
      sampleInterval: 1,
      segmentId: 42,
    },
  };
  clearMovementAnalyticsForTest();
  Game.rooms = {
    W1N1: {
      name: "W1N1",
      controller: { my: true, level: 3, progress: 50 } as StructureController,
      energyAvailable: 300,
      energyCapacityAvailable: 550,
    } as Room,
  };
  Game.creeps = {};
  Memory.data = undefined;
  Game.shard = { name: "shardTest" } as Game["shard"];
  Game.gcl = {
    level: 5,
    progress: 123,
    progressTotal: 456,
  } as Game["gcl"];
  Game.cpu = {
    getUsed: jest.fn(() => 1.5),
    bucket: 9000,
    limit: 20,
    tickLimit: 500,
  } as unknown as typeof Game.cpu;
  (global as typeof global & { RawMemory: typeof RawMemory }).RawMemory = {
    segments: {},
    setActiveSegments: jest.fn(),
  } as unknown as typeof RawMemory;
}

describe("runExternalTelemetryExport cpu monitor v2", () => {
  beforeEach(() => {
    setupBasicEnv();
    resetCpuMonitorStore();
    Memory.analytics = undefined;
  });

  afterEach(() => {
    resetCpuMonitorStore();
    clearCreepMovementStateForTest();
  });

  it("does not throw when no cpu monitor data exists and has no legacy moduleCpu", () => {
    expect(() => runExternalTelemetryExport()).not.toThrow();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.moduleCpu).toBeUndefined();
    expect(payload.cpuMonitor).toBeUndefined();
  });

  it("computes fixedActionEstimate from fixedActionCounts * config.fixedActionCpuCost", () => {
    const snap = makeV2Snapshot({
      fixedActionCounts: { creepWork: 25, otherAction: 10 },
    });
    Memory.cfg!.cpuProfiler = { fixedActionCpuCost: 0.3 };
    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 100,
        sampleInterval: 10,
        historyLimit: 120,
        latest: snap,
        summary: null,
      },
    } as unknown as Memory["analytics"];

    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.cpuMonitor.latest.fixedActionEstimate).toBeCloseTo(35 * 0.3, 4);
  });
});

describe("runExternalTelemetryExport cpu payload size", () => {
  beforeEach(() => {
    setupBasicEnv();
    resetCpuMonitorStore();
    Memory.analytics = undefined;
  });

  afterEach(() => {
    resetCpuMonitorStore();
    clearCreepMovementStateForTest();
  });

  it("compacts large payload to fit within 95KB segment limit", () => {
    const phases: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      phases[`phase_${i.toString().padStart(2, "0")}`] = 0.5 + i * 0.1;
    }

    const rooms: Record<string, { totalUsed: number; roles: Record<string, { count: number; used: number }> }> = {};
    for (let i = 0; i < 10; i++) {
      const roomName = `W${i}N${i}`;
      const roles: Record<string, { count: number; used: number }> = {};
      for (let j = 0; j < 5; j++) {
        roles[`role_${j}`] = { count: 2 + j, used: 1.0 + j * 0.5 };
      }
      rooms[roomName] = { totalUsed: 5.0 + i, roles };
    }

    const fixedActionCounts: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      fixedActionCounts[`action_${i}`] = i + 1;
    }

    const store = (global as typeof global & { __cpuMonitor?: { history: unknown[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor;
    if (store) {
      store.history = Array.from({ length: 20 }, (_, i) =>
        makeV2Snapshot({
          tick: 100 + i,
          totalUsed: 15 + i * 0.5,
          phases,
          fixedActionCounts,
          emaTotalUsed: 14.0 + i * 0.2,
          rooms,
          heap: { used_heap_size: 50_000_000, total_heap_size: 80_000_000, heap_size_limit: 200_000_000 },
        }),
      );
      store.emaTotalUsed = 17.0;
      store.seeded = true;
    }

    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 119,
        sampleInterval: 10,
        historyLimit: 120,
        latest: makeV2Snapshot({
          tick: 119,
          totalUsed: 25.0,
          phases,
          fixedActionCounts,
          emaTotalUsed: 17.0,
          rooms,
          heap: { used_heap_size: 50_000_000, total_heap_size: 80_000_000, heap_size_limit: 200_000_000 },
        }),
        summary: {
          ticks: 20,
          avgTotalUsed: 20.0,
          maxTotalUsed: 25.0,
          minBucket: 8500,
          maxBucket: 9500,
          avgBucket: 9000,
          avgUntracked: 3.0,
          avgPhases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, v * 0.9])),
          avgFixedActionCounts: Object.fromEntries(Object.entries(fixedActionCounts).map(([k, v]) => [k, v * 0.8])),
          emaTotalUsed: 17.0,
        },
      },
    } as unknown as Memory["analytics"];

    const gameRooms: Record<string, Room> = {};
    for (let i = 0; i < 10; i++) {
      const roomName = `W${i}N${i}`;
      gameRooms[roomName] = {
        name: roomName,
        controller: { my: true, level: 4 + (i % 4), progress: 100 * i } as StructureController,
        energyAvailable: 300 + i * 50,
        energyCapacityAvailable: 550 + i * 100,
      } as Room;
    }
    Game.rooms = gameRooms;

    runExternalTelemetryExport();

    const payload = RawMemory.segments[42];
    expect(payload.length).toBeLessThanOrEqual(95_000);

    const parsed = JSON.parse(payload);
    expect(parsed.version).toBe(2);
    expect(parsed.cpuMonitor).toBeDefined();
    expect(parsed.cpuMonitor.version).toBe(2);
  });
});
