import { cpuMonitorCommand, cpuMonitorRaw, startTelemetryCommand, statusTelemetryCommand, stopTelemetryCommand, statusHubRaw, statusHubCommand, stopHubRaw, stopHubCommand, hubProgressRaw, hubProgressCommand, memoryAuditRaw, memoryAudit } from "@/runtime/consoleCommands";
import type { CpuMonitorHeapSnapshot } from "@/runtime/cpuMonitor";

const fullHeap: CpuMonitorHeapSnapshot = {
  total_heap_size: 2097152,
  total_heap_size_executable: 524288,
  total_physical_size: 2097152,
  total_available_size: 2097152,
  used_heap_size: 1048576,
  heap_size_limit: 4194304,
  malloced_memory: 65536,
  peak_malloced_memory: 131072,
  does_zap_garbage: 1,
  externally_allocated_size: 0,
};

function makeV2Snapshot(overrides: Partial<{
  tick: number;
  totalUsed: number;
  bucket: number;
  phases: Record<string, number>;
  fixedActionCounts: Record<string, number>;
  untracked: number;
  emaTotalUsed: number;
  rooms: Record<string, { totalUsed: number; roles: Record<string, { count: number; used: number }> }>;
  heap: CpuMonitorHeapSnapshot | null;
}> & { tick: number }) {
  return {
    tick: overrides.tick,
    shard: "shard3",
    totalUsed: overrides.totalUsed ?? 15,
    bucket: overrides.bucket ?? 9800,
    limit: 20,
    tickLimit: 500,
    phases: overrides.phases ?? { creepWork: 7, towerControl: 1 },
    fixedActionCounts: overrides.fixedActionCounts ?? { creepWork: 3 },
    untracked: overrides.untracked ?? 1,
    emaTotalUsed: overrides.emaTotalUsed ?? 15,
    rooms: overrides.rooms ?? {},
    heap: overrides.heap ?? null,
  };
}

describe("cpuMonitor", () => {
  beforeEach(() => {
    Memory.cfg = {};
    Memory.analytics = {};
    (global as typeof global & { __cpuMonitor?: { history: any[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor = {
      history: [],
      emaTotalUsed: 0,
      seeded: false,
    };
  });

  it("returns v2 empty monitor data with version=2 when no snapshot exists", () => {
    const result = cpuMonitorRaw();

    expect(result).toMatchObject({
      ok: true,
      version: 2,
      enabled: false,
      historySize: 0,
      latest: null,
      recentHistory: [],
      summary: null,
    });
  });

  it("returns readable empty output from command wrapper", () => {
    expect(cpuMonitorCommand()).toBe(
      "[cpu-monitor] version=2  enabled=false  interval=10  history=0/120\n[cpu-monitor] latest=none\n[cpu-monitor] summary=none",
    );
  });

  it("returns latest snapshot from Memory.analytics.cpuMonitor (not moduleCpu)", () => {
    Memory.cfg = {
      cpuProfiler: {
        enabled: true,
        sampleInterval: 5,
        historyLimit: 120,
      },
    };

    const latestSnapshot = makeV2Snapshot({
      tick: 123,
      totalUsed: 17,
      bucket: 9500,
      phases: {
        creepWork: 8,
        "creepWork:intent": 4,
        "creepWork:decision": 2,
        "creepWork:pathing": 1.5,
        towerControl: 1,
      },
      fixedActionCounts: {
        creepWork: 4,
        towerControl: 1,
      },
      untracked: 2,
      emaTotalUsed: 16.5,
      rooms: {
        W1N1: { totalUsed: 5.0, roles: { worker: { count: 2, used: 5.0 } } },
      },
      heap: fullHeap,
    });

    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 123,
        sampleInterval: 5,
        historyLimit: 120,
        latest: latestSnapshot,
        summary: null,
      },
    } as unknown as Memory["analytics"];

    (global as typeof global & { __cpuMonitor?: { history: any[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor = {
      history: [
        makeV2Snapshot({ tick: 121, totalUsed: 15, bucket: 9800, phases: { creepWork: 7, towerControl: 1 }, fixedActionCounts: { creepWork: 3, towerControl: 1 }, untracked: 1, emaTotalUsed: 15 }),
        makeV2Snapshot({ tick: 122, totalUsed: 16, bucket: 9600, phases: { creepWork: 8, towerControl: 1 }, fixedActionCounts: { creepWork: 4, towerControl: 1 }, untracked: 2, emaTotalUsed: 15.5 }),
        makeV2Snapshot({ tick: 123, totalUsed: 17, bucket: 9500, phases: { creepWork: 9, towerControl: 1 }, fixedActionCounts: { creepWork: 5, towerControl: 1 }, untracked: 3, emaTotalUsed: 16.5 }),
      ],
      emaTotalUsed: 16.5,
      seeded: true,
    };

    const result = cpuMonitorRaw();

    expect(result.version).toBe(2);
    expect(result.enabled).toBe(true);
    expect(result.sampleInterval).toBe(5);
    expect(result.historySize).toBe(3);
    expect(result.latest?.tick).toBe(123);
    expect(result.latest?.emaTotalUsed).toBe(16.5);
    expect(result.latest?.rooms).toEqual({ W1N1: { totalUsed: 5.0, roles: { worker: { count: 2, used: 5.0 } } } });
    expect(result.latest?.heap).toMatchObject({ used_heap_size: 1048576, total_heap_size: 2097152, heap_size_limit: 4194304 });
    expect(result.recentHistory).toHaveLength(3);
    expect(result.recentHistory[0].emaTotalUsed).toBe(15);
    expect(result.recentHistory[0].rooms).toEqual({});
    expect(result.summary).toMatchObject({
      ticks: 3,
      maxTotalUsed: 17,
      minBucket: 9500,
      maxBucket: 9800,
      emaTotalUsed: 16.5,
    });
    expect(result.summary?.avgTotalUsed).toBeCloseTo(16);
    expect(result.summary?.avgBucket).toBeCloseTo(9633.333, 2);
    expect(result.summary?.avgUntracked).toBeCloseTo(2);
    expect(result.summary?.avgPhases.creepWork).toBeCloseTo(8);
    expect(result.summary?.avgFixedActionCounts.creepWork).toBeCloseTo(4);
    expect(result.summary?.avgFixedActionCounts.towerControl).toBeCloseTo(1);
  });

  it("does not read from Memory.analytics.moduleCpu", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 5, historyLimit: 120 } };

    // Seed moduleCpu but NOT cpuMonitor
    Memory.analytics = {
      moduleCpu: {
        updatedAt: 123,
        sampleInterval: 5,
        historyLimit: 120,
        latest: {
          tick: 999,
          shard: "shard3",
          totalUsed: 99,
          bucket: 5000,
          limit: 20,
          tickLimit: 500,
          phases: { creepWork: 50 },
          fixedActionCounts: {},
          untracked: 1,
        },
      },
    } as unknown as Memory["analytics"];

    (global as typeof global & { __cpuMonitor?: { history: any[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor = {
      history: [],
      emaTotalUsed: 0,
      seeded: false,
    };

    const result = cpuMonitorRaw();
    // latest should be null (ignoring moduleCpu), not tick 999
    expect(result.latest).toBeNull();
    expect(result.version).toBe(2);
  });

  it("uses persisted summary when global history is empty", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 5, historyLimit: 120 } };

    const persistedSummary = {
      ticks: 50,
      avgTotalUsed: 14.3,
      maxTotalUsed: 19.0,
      minBucket: 9000,
      maxBucket: 10000,
      avgBucket: 9500,
      avgUntracked: 1.5,
      avgPhases: { creepWork: 7.0, towerControl: 0.8 },
      avgFixedActionCounts: { creepWork: 3.5 },
      emaTotalUsed: 14.1,
    };

    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 500,
        sampleInterval: 5,
        historyLimit: 120,
        latest: makeV2Snapshot({ tick: 500, totalUsed: 14.5, bucket: 9500, emaTotalUsed: 14.1 }),
        summary: persistedSummary,
      },
    } as unknown as Memory["analytics"];

    // Global history is empty (simulates code reload)
    (global as typeof global & { __cpuMonitor?: { history: any[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor = {
      history: [],
      emaTotalUsed: 0,
      seeded: false,
    };

    const result = cpuMonitorRaw();

    expect(result.latest?.tick).toBe(500);
    expect(result.summary).toEqual(persistedSummary);
    expect(result.summary?.ticks).toBe(50);
    expect(result.summary?.emaTotalUsed).toBe(14.1);
    expect(result.recentHistory).toHaveLength(0);
  });

  it("falls back to computed summary when Memory summary is absent", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 5, historyLimit: 120 } };

    // Memory has latest but no summary
    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 500,
        sampleInterval: 5,
        historyLimit: 120,
        latest: makeV2Snapshot({ tick: 500, totalUsed: 15, bucket: 9500, emaTotalUsed: 15 }),
        summary: null,
      },
    } as unknown as Memory["analytics"];

    (global as typeof global & { __cpuMonitor?: { history: any[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor = {
      history: [
        makeV2Snapshot({ tick: 499, totalUsed: 14, bucket: 9600, emaTotalUsed: 14.5 }),
        makeV2Snapshot({ tick: 500, totalUsed: 16, bucket: 9500, emaTotalUsed: 15 }),
      ],
      emaTotalUsed: 15,
      seeded: true,
    };

    const result = cpuMonitorRaw();

    expect(result.summary).not.toBeNull();
    expect(result.summary?.ticks).toBe(2);
    expect(result.summary?.avgTotalUsed).toBeCloseTo(15);
  });

  it("returns readable formatted output with persisted summary and empty global history", () => {
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 5, historyLimit: 120 } };

    const persistedSummary = {
      ticks: 50,
      avgTotalUsed: 14.3,
      maxTotalUsed: 19.0,
      minBucket: 9000,
      maxBucket: 10000,
      avgBucket: 9500,
      avgUntracked: 1.5,
      avgPhases: { creepWork: 7.0, towerControl: 0.8 },
      avgFixedActionCounts: { creepWork: 3.5 },
      emaTotalUsed: 14.1,
    };

    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 500,
        sampleInterval: 5,
        historyLimit: 120,
        latest: makeV2Snapshot({
          tick: 500,
          totalUsed: 14.5,
          bucket: 9500,
          phases: { creepWork: 7, towerControl: 1 },
          fixedActionCounts: { creepWork: 3 },
          untracked: 1.5,
          emaTotalUsed: 14.1,
        }),
        summary: persistedSummary,
      },
    } as unknown as Memory["analytics"];

    (global as typeof global & { __cpuMonitor?: { history: any[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor = {
      history: [],
      emaTotalUsed: 0,
      seeded: false,
    };

    const output = cpuMonitorCommand();
    expect(output).toContain("version=2  enabled=true  interval=5  history=0/120");
    expect(output).toContain("avg(50)  avg=14.30  max=19.00  bucket=9000-10000  untracked=1.50  ema=14.10");
  });

  it("returns readable formatted output with phases, rooms, heap, and EMA", () => {
    Memory.cfg = {
      cpuProfiler: {
        enabled: true,
        sampleInterval: 5,
        historyLimit: 120,
      },
    };

    const latestSnapshot = makeV2Snapshot({
      tick: 123,
      totalUsed: 17,
      bucket: 9500,
      phases: {
        creepWork: 8,
        "creepWork:intent": 4,
        "creepWork:decision": 2,
        "creepWork:pathing": 1.5,
        towerControl: 1,
      },
      fixedActionCounts: {
        creepWork: 4,
        towerControl: 1,
      },
      untracked: 2,
      emaTotalUsed: 16.5,
      rooms: {
        W1N1: { totalUsed: 5.0, roles: { worker: { count: 2, used: 5.0 } } },
      },
      heap: fullHeap,
    });

    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 123,
        sampleInterval: 5,
        historyLimit: 120,
        latest: latestSnapshot,
        summary: null,
      },
    } as unknown as Memory["analytics"];

    (global as typeof global & { __cpuMonitor?: { history: any[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor = {
      history: [
        makeV2Snapshot({ tick: 121, totalUsed: 15, bucket: 9800, phases: { creepWork: 7, towerControl: 1 }, fixedActionCounts: { creepWork: 3, towerControl: 1 }, untracked: 1, emaTotalUsed: 15 }),
        makeV2Snapshot({ tick: 122, totalUsed: 16, bucket: 9600, phases: { creepWork: 8, towerControl: 1 }, fixedActionCounts: { creepWork: 4, towerControl: 1 }, untracked: 2, emaTotalUsed: 15.5 }),
        makeV2Snapshot({ tick: 123, totalUsed: 17, bucket: 9500, phases: { creepWork: 9, towerControl: 1 }, fixedActionCounts: { creepWork: 5, towerControl: 1 }, untracked: 3, emaTotalUsed: 16.5 }),
      ],
      emaTotalUsed: 16.5,
      seeded: true,
    };

    const output = cpuMonitorCommand();

    expect(output).toContain("version=2  enabled=true  interval=5  history=3/120");
    expect(output).toContain("latest  t=123  shard=shard3  used=17.00/20  bucket=9500  tickLimit=500  untracked=2.00  ema=16.50");
    // Top phases
    expect(output).toContain("creepWork  8.00  (7.20 + 0.80 fixed)");
    expect(output).toContain("towerControl  1.00  (0.80 + 0.20 fixed)");
    // Fixed-action estimate
    expect(output).toContain("fixed-action estimate=1.00 (cost=0.2)");
    // Top room/role
    expect(output).toContain("W1N1  5.00  worker(2x 5.00)");
    // Heap
    expect(output).toContain("heap  1.0/2.0MB  limit=4MB");
    // Summary with EMA
    expect(output).toContain("avg(3)  avg=16.00  max=17.00  bucket=9500-9800  untracked=2.00  ema=16.50");
  });

  it("handles empty rooms and heap gracefully in formatted output", () => {
    Memory.cfg = { cpuProfiler: { enabled: true } };

    const latestSnapshot = makeV2Snapshot({
      tick: 50,
      totalUsed: 10,
      bucket: 9000,
      phases: { init: 5 },
      fixedActionCounts: {},
      untracked: 5,
      emaTotalUsed: 10,
      rooms: {},
      heap: null,
    });

    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 50,
        sampleInterval: 10,
        historyLimit: 120,
        latest: latestSnapshot,
        summary: null,
      },
    } as unknown as Memory["analytics"];

    (global as typeof global & { __cpuMonitor?: { history: any[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor = {
      history: [latestSnapshot],
      emaTotalUsed: 10,
      seeded: true,
    };

    const output = cpuMonitorCommand();
    expect(output).not.toContain("fixed-action estimate");
    expect(output).not.toContain("heap");
    expect(output).not.toMatch(/\]\s+\w+\s+\d+\.\d+\s+\w+\(\d+x/);
  });
});

describe("telemetry commands", () => {
  beforeEach(() => {
    Memory.cfg = {};
  });

  it("returns stable JSON wrappers for telemetry control", () => {
    expect(startTelemetryCommand()).toBe(
      JSON.stringify({ ok: true, enabled: true, previousEnabled: false, sampleInterval: 10, segmentId: 90 }),
    );
    expect(statusTelemetryCommand()).toBe(
      JSON.stringify({ ok: true, enabled: true, previousEnabled: true, sampleInterval: 10, segmentId: 90 }),
    );
    expect(stopTelemetryCommand()).toBe(
      JSON.stringify({ ok: true, enabled: false, previousEnabled: true, sampleInterval: 10, segmentId: 90 }),
    );
  });
});

describe("hub commands", () => {
  beforeEach(() => {
    Memory.cfg = {};
    Memory.runtime = {};
  });

  it("statusHub returns not_configured when no hub", () => {
    Memory.cfg = {};
    const result = statusHubRaw();
    expect(result).toEqual({ enabled: false, hubRoomName: null, status: "not_configured" });
  });

  it("statusHub returns active state", () => {
    Memory.cfg!.hub = { hubRoomName: "W1N1", enabled: true, internalOnly: true };
    Memory.runtime!.synthesisControl = {
      updatedAt: 100,
      generatedTaskCount: 5,
      failedTaskCount: 0,
      successfulRunCount: 3,
      lastActions: [],
      bindings: {},
      rooms: {
        W1N1: {
          stage: "synthesizing",
          activeProduct: "XGHO2",
          reagentLabIds: [],
          productLabIds: [],
          successfulRuns: 10,
          pendingTasks: 1,
          lastTransitionAt: 200,
        },
      },
    } as NonNullable<Memory["runtime"]>["synthesisControl"];
    const result = statusHubRaw();
    expect(result).toMatchObject({
      enabled: true,
      hubRoomName: "W1N1",
      status: "active",
      activeProduct: "XGHO2",
      activeStage: "synthesizing",
      targetCompounds: [],
    });
  });

  it("stopHub disables hub and clears reactions", () => {
    Memory.cfg!.hub = { hubRoomName: "W1N1", enabled: true };
    const result = stopHubRaw();
    expect(result).toMatchObject({ ok: true, hubRoomName: "W1N1", enabled: false, reactionsCleared: true });
    expect(Memory.cfg!.hub!.enabled).toBe(false);
  });

  it("stopHub preserves config overrides", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W1N1",
      enabled: true,
      targetCompounds: ["XGHO2"],
      reservePerRoom: 1000,
    };
    stopHubRaw();
    expect(Memory.cfg!.hub!.targetCompounds).toEqual(["XGHO2"]);
    expect(Memory.cfg!.hub!.reservePerRoom).toBe(1000);
  });

  it("statusHubCommand returns formatted JSON", () => {
    Memory.cfg!.hub = { hubRoomName: "W1N1", enabled: true };
    const result = statusHubCommand();
    const parsed = JSON.parse(result);
    expect(parsed).toMatchObject({ enabled: true, hubRoomName: "W1N1", status: "active" });
  });

  it("stopHub returns error when not configured", () => {
    Memory.cfg = {};
    const result = stopHubRaw();
    expect(result).toEqual({ ok: false, error: "hub_not_configured" });
  });
});

describe("hubProgress commands", () => {
  beforeEach(() => {
    Memory.cfg = {};
    Memory.runtime = {};
    Memory.data = {};
  });

  it("hubProgressRaw returns disabled snapshot when hub not enabled", () => {
    Memory.cfg = {};
    const result = hubProgressRaw();
    expect(result).toMatchObject({
      enabled: false,
      hubRoomName: "",
      hubRoomVisible: false,
      status: null,
      stage: null,
      activeProduct: null,
    });
  });

  it("hubProgressRaw returns active snapshot when hub enabled", () => {
    Memory.cfg!.hub = { hubRoomName: "W1N1", enabled: true, targetCompounds: ["XGHO2"] };
    Memory.runtime!.hub = {
      status: "synthesizing",
      updatedAt: 500,
      activeProduct: "XGHO2",
      missingResources: [],
      lastPlanActions: ["import:OH"],
      needsPlan: false,
    };
    Memory.runtime!.synthesisControl = {
      updatedAt: 500,
      generatedTaskCount: 3,
      failedTaskCount: 0,
      successfulRunCount: 2,
      lastActions: [],
      bindings: {},
      rooms: {
        W1N1: {
          stage: "synthesizing",
          activeProduct: "XGHO2",
          reagentLabIds: [],
          productLabIds: [],
          successfulRuns: 5,
          pendingTasks: 1,
          lastTransitionAt: 400,
        },
      },
    } as NonNullable<Memory["runtime"]>["synthesisControl"];

    const result = hubProgressRaw();
    expect(result).toMatchObject({
      enabled: true,
      hubRoomName: "W1N1",
      status: "synthesizing",
      activeProduct: "XGHO2",
    });
  });

  it("hubProgressCommand returns valid JSON", () => {
    Memory.cfg!.hub = { hubRoomName: "W1N1", enabled: true };
    const result = hubProgressCommand();
    const parsed = JSON.parse(result);
    expect(parsed).toMatchObject({ enabled: true, hubRoomName: "W1N1" });
  });
});

describe("memoryAudit commands", () => {
  beforeEach(() => {
    Memory.cfg = {};
    Memory.runtime = { hub: { status: "idle", updatedAt: 0, activeProduct: null, missingResources: [], lastPlanActions: [], needsPlan: false } };
    Memory.data = {};
  });

  it("memoryAuditRaw returns snapshot with totalBytes > 0", () => {
    const result = memoryAuditRaw();
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(Array.isArray(result.top)).toBe(true);
    expect(Array.isArray(result.branches)).toBe(true);
  });

  it("memoryAudit returns a string containing totalBytes", () => {
    const result = memoryAudit();
    expect(typeof result).toBe("string");
    expect(result).toContain("totalBytes");
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty("totalBytes");
    expect(parsed).toHaveProperty("top");
    expect(parsed).toHaveProperty("branches");
  });

  it("neither function mutates Memory", () => {
    const before = JSON.stringify(Memory);
    memoryAuditRaw();
    memoryAudit();
    const after = JSON.stringify(Memory);
    expect(after).toBe(before);
  });
});
