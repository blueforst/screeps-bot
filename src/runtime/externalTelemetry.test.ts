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

describe("runExternalTelemetryExport movement metrics", () => {
  beforeEach(() => {
    setupBasicEnv();
    resetCpuMonitorStore();
    Memory.analytics = undefined;
    const movement = getMovementAnalyticsForTest();
    movement.updatedAt = Game.time;
    Object.assign(movement.totals, {
      pathRequests: 4,
      pathCacheHits: 2,
      pathRepaths: 1,
      yieldPushes: 1,
      travelRequests: 3,
      travelFallbacks: 1,
      travelRepaths: 1,
      exitRecoveries: 1,
      stateClears: 2,
    });
    movement.rooms.W1N1 = {
      pathRequests: 4,
      pathCacheHits: 2,
      pathRepaths: 1,
      yieldPushes: 1,
      travelRequests: 3,
      travelFallbacks: 1,
      travelRepaths: 1,
      exitRecoveries: 1,
      stateClears: 2,
    };
  });

  it("exports movement totals and per-room movement metrics", () => {
    runExternalTelemetryExport();

    expect(RawMemory.setActiveSegments).toHaveBeenCalledWith([42]);
    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.totals.movement).toMatchObject({
      pathRequests: 4,
      yieldPushes: 1,
      travelFallbacks: 1,
      stateClears: 2,
    });
    expect(payload.rooms[0].movement).toMatchObject({
      pathCacheHits: 2,
      travelRequests: 3,
      exitRecoveries: 1,
    });
  });

  it("exports bounded debug telemetry for movement states and colonization tasks", () => {
    const scout = {
      name: "scout-debug",
      room: { name: "W1N1" },
      pos: { x: 49, y: 25, roomName: "W1N1" },
      ticksToLive: 1234,
      memory: {
        role: "scout",
        configName: "W1N1:colonize:W1N2:scout:0",
        roleArgs: ["W1N2", "W1N1|W1N2"],
        scoutVisitedRooms: ["W1N1", "W1N2", "W1N1"],
      },
    } as unknown as Creep;
    Game.creeps = { [scout.name]: scout };
    ensureCreepMovementState(scout.name).travelState = {
      targetRoom: "W1N2",
      stuckTicks: 3,
      lastPosKey: "W1N2:0:25",
      lastWasExit: true,
    };
    Memory.data = {
      creepConfigs: {},
      colonization: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "claiming",
          flagName: "CL",
          planReady: false,
          claimCompleted: false,
          scoutSafe: false,
          scoutRouteRooms: ["W1N1", "W1N2"],
          dangerousRooms: ["W9N9"],
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    };

    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.debug.counts).toMatchObject({
      creepsWithMovementState: 1,
      creepsWithTravelState: 1,
      stuckCreeps: 1,
      colonizationTasks: 1,
    });
    expect(payload.debug.creeps[0]).toMatchObject({
      name: "scout-debug",
      role: "scout",
      roomName: "W1N1",
      x: 49,
      y: 25,
      targetRoom: "W1N2",
      travelState: {
        stuckTicks: 3,
        lastWasExit: true,
      },
      scoutVisitedRooms: ["W1N1", "W1N2", "W1N1"],
    });
    expect(payload.debug.colonization[0]).toMatchObject({
      targetRoom: "W1N2",
      sourceRoom: "W1N1",
      status: "claiming",
      scoutRouteRooms: ["W1N1", "W1N2"],
      dangerousRooms: ["W9N9"],
    });
  });

  afterEach(() => {
    clearCreepMovementStateForTest();
  });
});

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

  it("exports version 2 snapshot", () => {
    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.version).toBe(2);
  });

  it("omits cpuMonitor when no v2 data exists", () => {
    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.cpuMonitor).toBeUndefined();
    expect(payload.moduleCpu).toBeUndefined();
  });

  it("does not throw when no cpu monitor data exists and has no legacy moduleCpu", () => {
    expect(() => runExternalTelemetryExport()).not.toThrow();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.moduleCpu).toBeUndefined();
    expect(payload.cpuMonitor).toBeUndefined();
  });

  it("exports cpuMonitor payload with latest, summary, history, and config", () => {
    const snap = makeV2Snapshot({
      tick: 100,
      totalUsed: 12.5,
      phases: { creepWork: 5.0, spawnWork: 3.0 },
      fixedActionCounts: { creepWork: 10 },
      emaTotalUsed: 11.8,
      rooms: {
        W1N1: { totalUsed: 8.0, roles: { worker: { count: 3, used: 5.0 } } },
      },
    });

    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 100,
        sampleInterval: 10,
        historyLimit: 120,
        latest: snap,
        summary: {
          ticks: 5,
          avgTotalUsed: 11.0,
          maxTotalUsed: 15.0,
          minBucket: 8500,
          maxBucket: 9500,
          avgBucket: 9000,
          avgUntracked: 2.0,
          avgPhases: { creepWork: 4.5, spawnWork: 2.5 },
          avgFixedActionCounts: { creepWork: 8 },
          emaTotalUsed: 11.5,
        },
      },
    } as unknown as Memory["analytics"];

    const store = (global as typeof global & { __cpuMonitor?: { history: unknown[] } }).__cpuMonitor;
    if (store) {
      store.history = [
        makeV2Snapshot({ tick: 98, totalUsed: 10.0 }),
        makeV2Snapshot({ tick: 99, totalUsed: 11.0 }),
        makeV2Snapshot({ tick: 100, totalUsed: 12.5 }),
      ];
    }

    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    const cm = payload.cpuMonitor;
    expect(cm).toBeDefined();
    expect(cm.version).toBe(2);

    expect(cm.latest).toMatchObject({
      tick: 100,
      totalUsed: 12.5,
      emaTotalUsed: 11.8,
      fixedActionCounts: { creepWork: 10 },
      fixedActionEstimate: 2,
    });
    expect(cm.latest.phases).toMatchObject({ creepWork: 5.0, spawnWork: 3.0 });

    expect(cm.summary).toBeDefined();
    expect(cm.summary.ticks).toBe(5);
    expect(cm.summary.avgTotalUsed).toBe(11.0);
    expect(cm.summary.emaTotalUsed).toBe(11.5);
    expect(cm.summary.fixedActionEstimate).toBeCloseTo(8 * 0.2, 4);
    expect(cm.summary.topPhases).toBeDefined();
    expect(cm.summary.topRoomRoles).toBeDefined();

    expect(cm.history).toBeDefined();
    expect(cm.history.length).toBe(3);
    expect(cm.history[0].tick).toBe(98);
    expect(cm.history[2].tick).toBe(100);

    expect(cm.config).toMatchObject({
      sampleInterval: 10,
      historyLimit: 120,
      fixedActionCpuCost: 0.2,
    });
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

  it("includes heap summary in latest entry when available", () => {
    const snap = makeV2Snapshot({
      heap: {
        used_heap_size: 50_000_000,
        total_heap_size: 80_000_000,
        heap_size_limit: 200_000_000,
      },
    });
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
    expect(payload.cpuMonitor.latest.heap).toMatchObject({
      used_heap_size: 50_000_000,
      total_heap_size: 80_000_000,
      heap_size_limit: 200_000_000,
    });
  });

  it("includes room/role summaries in latest from v2 snapshot", () => {
    const snap = makeV2Snapshot({
      rooms: {
        W1N1: { totalUsed: 8.0, roles: { worker: { count: 3, used: 5.0 }, carrier: { count: 2, used: 3.0 } } },
        W2N1: { totalUsed: 4.0, roles: { harvester: { count: 1, used: 4.0 } } },
      },
    });
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
    expect(payload.cpuMonitor.latest.rooms).toMatchObject({
      W1N1: { totalUsed: 8.0, roles: { worker: { count: 3, used: 5.0 }, carrier: { count: 2, used: 3.0 } } },
      W2N1: { totalUsed: 4.0, roles: { harvester: { count: 1, used: 4.0 } } },
    });
  });

  it("includes topRoomRoles in summary from latest snapshot", () => {
    const snap = makeV2Snapshot({
      rooms: {
        W1N1: { totalUsed: 8.0, roles: { worker: { count: 3, used: 6.0 }, carrier: { count: 2, used: 2.0 } } },
      },
    });
    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 100,
        sampleInterval: 10,
        historyLimit: 120,
        latest: snap,
        summary: {
          ticks: 5,
          avgTotalUsed: 11.0,
          maxTotalUsed: 15.0,
          minBucket: 8500,
          maxBucket: 9500,
          avgBucket: 9000,
          avgUntracked: 2.0,
          avgPhases: { creepWork: 4.5 },
          avgFixedActionCounts: { creepWork: 8 },
          emaTotalUsed: 11.5,
        },
      },
    } as unknown as Memory["analytics"];

    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.cpuMonitor.summary.topRoomRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ room: "W1N1", role: "worker", avgUsed: 2.0, count: 3 }),
        expect.objectContaining({ room: "W1N1", role: "carrier", avgUsed: 1.0, count: 2 }),
      ]),
    );
  });

  it("uses persisted summary when available, falls back to computed from history", () => {
    const store = (global as typeof global & { __cpuMonitor?: { history: unknown[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor;
    if (store) {
      store.history = [
        makeV2Snapshot({ tick: 98, totalUsed: 10.0, emaTotalUsed: 10.0 }),
        makeV2Snapshot({ tick: 99, totalUsed: 12.0, emaTotalUsed: 11.0 }),
      ];
      store.emaTotalUsed = 11.0;
      store.seeded = true;
    }
    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 99,
        sampleInterval: 10,
        historyLimit: 120,
        latest: makeV2Snapshot({ tick: 99 }),
        summary: null,
      },
    } as unknown as Memory["analytics"];

    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.cpuMonitor.summary).not.toBeNull();
    expect(payload.cpuMonitor.summary.ticks).toBe(2);
    expect(payload.cpuMonitor.summary.avgTotalUsed).toBe(11.0);
  });

  it("bounds history to last 20 entries", () => {
    const store = (global as typeof global & { __cpuMonitor?: { history: unknown[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor;
    if (store) {
      store.history = Array.from({ length: 30 }, (_, i) =>
        makeV2Snapshot({ tick: 80 + i, totalUsed: 10 + i * 0.1 }),
      );
      store.emaTotalUsed = 12.0;
      store.seeded = true;
    }
    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 109,
        sampleInterval: 10,
        historyLimit: 120,
        latest: makeV2Snapshot({ tick: 109 }),
        summary: null,
      },
    } as unknown as Memory["analytics"];

    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.cpuMonitor.history.length).toBe(20);
    expect(payload.cpuMonitor.history[0].tick).toBe(90);
    expect(payload.cpuMonitor.history[19].tick).toBe(109);
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

  it("no-CPU-data telemetry export does not throw and has no legacy moduleCpu", () => {
    Memory.analytics = undefined;
    resetCpuMonitorStore();

    expect(() => runExternalTelemetryExport()).not.toThrow();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.moduleCpu).toBeUndefined();
    expect(payload.cpuMonitor).toBeUndefined();
    expect(payload.version).toBe(2);
  });
});
