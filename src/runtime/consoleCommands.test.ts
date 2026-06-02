import { cpuMonitorCommand, cpuMonitorRaw, startTelemetryCommand, statusTelemetryCommand, stopTelemetryCommand, statusHubRaw, statusHubCommand, stopHubRaw, stopHubCommand, hubProgressRaw, hubProgressCommand, memoryAuditRaw, memoryAudit } from "@/runtime/consoleCommands";

describe("cpuMonitor", () => {
  it("returns empty monitor data when no cpu snapshot exists", () => {
    const result = cpuMonitorRaw();

    expect(result).toMatchObject({
      ok: true,
      enabled: false,
      historySize: 0,
      latest: null,
      recentHistory: [],
      summary: null,
    });
  });

  it("returns readable empty output from command wrapper", () => {
    expect(cpuMonitorCommand()).toBe(
      "[cpu-monitor] enabled=false  interval=10  history=0/120\n[cpu-monitor] latest=none\n[cpu-monitor] summary=none",
    );
  });

  it("returns latest snapshot and recent history summary", () => {
    Memory.cfg = {
      cpuProfiler: {
        enabled: true,
        sampleInterval: 5,
        historyLimit: 120,
      },
    };

    Memory.analytics = {
      moduleCpu: {
        updatedAt: 123,
        sampleInterval: 5,
        historyLimit: 120,
        latest: {
          tick: 123,
          shard: "shard3",
          totalUsed: 17,
          bucket: 9500,
          limit: 20,
          tickLimit: 500,
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
        },
      },
    } as Memory["analytics"];

    (global as typeof global & { __cpuMonitor?: { history: any[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor = {
      history: [
        {
          tick: 121,
          shard: "shard3",
          totalUsed: 15,
          bucket: 9800,
          limit: 20,
          tickLimit: 500,
          phases: { creepWork: 7, "creepWork:intent": 3, "creepWork:decision": 1, "creepWork:pathing": 1, towerControl: 1 },
          fixedActionCounts: { creepWork: 3, towerControl: 1 },
          untracked: 1,
          emaTotalUsed: 0,
          rooms: {},
          heap: null,
        },
        {
          tick: 122,
          shard: "shard3",
          totalUsed: 16,
          bucket: 9600,
          limit: 20,
          tickLimit: 500,
          phases: { creepWork: 8, "creepWork:intent": 4, "creepWork:decision": 2, "creepWork:pathing": 1.5, towerControl: 1 },
          fixedActionCounts: { creepWork: 4, towerControl: 1 },
          untracked: 2,
          emaTotalUsed: 0,
          rooms: {},
          heap: null,
        },
        {
          tick: 123,
          shard: "shard3",
          totalUsed: 17,
          bucket: 9500,
          limit: 20,
          tickLimit: 500,
          phases: { creepWork: 9, "creepWork:intent": 5, "creepWork:decision": 3, "creepWork:pathing": 2, towerControl: 1 },
          fixedActionCounts: { creepWork: 5, towerControl: 1 },
          untracked: 3,
          emaTotalUsed: 0,
          rooms: {},
          heap: null,
        },
      ],
      emaTotalUsed: 0,
      seeded: false,
    };

    const result = cpuMonitorRaw();

    expect(result.enabled).toBe(true);
    expect(result.sampleInterval).toBe(5);
    expect(result.historySize).toBe(3);
    expect(result.latest?.tick).toBe(123);
    expect(result.recentHistory).toHaveLength(3);
    expect(result.summary).toMatchObject({
      ticks: 3,
      maxTotalUsed: 17,
      minBucket: 9500,
      maxBucket: 9800,
    });
    expect(result.summary?.avgTotalUsed).toBeCloseTo(16);
    expect(result.summary?.avgBucket).toBeCloseTo(9633.333, 2);
    expect(result.summary?.avgUntracked).toBeCloseTo(2);
    expect(result.summary?.avgPhases.creepWork).toBeCloseTo(8);
    expect(result.summary?.avgPhases["creepWork:intent"]).toBeCloseTo(4);
    expect(result.summary?.avgPhases["creepWork:decision"]).toBeCloseTo(2);
    expect(result.summary?.avgPhases["creepWork:pathing"]).toBeCloseTo(1.5);
    expect(result.latest?.fixedActionCounts.creepWork).toBe(4);
    expect(result.summary?.avgFixedActionCounts.creepWork).toBeCloseTo(4);
    expect(result.summary?.avgFixedActionCounts.towerControl).toBeCloseTo(1);
  });

  it("returns readable output from command wrapper", () => {
    Memory.cfg = {
      cpuProfiler: {
        enabled: true,
        sampleInterval: 5,
        historyLimit: 120,
      },
    };

    Memory.analytics = {
      moduleCpu: {
        updatedAt: 123,
        sampleInterval: 5,
        historyLimit: 120,
        latest: {
          tick: 123,
          shard: "shard3",
          totalUsed: 17,
          bucket: 9500,
          limit: 20,
          tickLimit: 500,
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
        },
      },
    } as Memory["analytics"];

    (global as typeof global & { __cpuMonitor?: { history: any[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor = {
      history: [
        {
          tick: 121,
          shard: "shard3",
          totalUsed: 15,
          bucket: 9800,
          limit: 20,
          tickLimit: 500,
          phases: { creepWork: 7, "creepWork:intent": 3, "creepWork:decision": 1, "creepWork:pathing": 1, towerControl: 1 },
          fixedActionCounts: { creepWork: 3, towerControl: 1 },
          untracked: 1,
          emaTotalUsed: 0,
          rooms: {},
          heap: null,
        },
        {
          tick: 122,
          shard: "shard3",
          totalUsed: 16,
          bucket: 9600,
          limit: 20,
          tickLimit: 500,
          phases: { creepWork: 8, "creepWork:intent": 4, "creepWork:decision": 2, "creepWork:pathing": 1.5, towerControl: 1 },
          fixedActionCounts: { creepWork: 4, towerControl: 1 },
          untracked: 2,
          emaTotalUsed: 0,
          rooms: {},
          heap: null,
        },
        {
          tick: 123,
          shard: "shard3",
          totalUsed: 17,
          bucket: 9500,
          limit: 20,
          tickLimit: 500,
          phases: { creepWork: 9, "creepWork:intent": 5, "creepWork:decision": 3, "creepWork:pathing": 2, towerControl: 1 },
          fixedActionCounts: { creepWork: 5, towerControl: 1 },
          untracked: 3,
          emaTotalUsed: 0,
          rooms: {},
          heap: null,
        },
      ],
      emaTotalUsed: 0,
      seeded: false,
    };

    expect(cpuMonitorCommand()).toBe(
      "[cpu-monitor] enabled=true  interval=5  history=3/120\n" +
      "[cpu-monitor] latest  t=123  shard=shard3  used=17.00/20  bucket=9500  tickLimit=500  untracked=2.00\n" +
      "[cpu-monitor]   creepWork  8.00  (7.20 + 0.80 fixed)\n" +
      "[cpu-monitor]   towerControl  1.00  (0.80 + 0.20 fixed)\n" +
      "[cpu-monitor] avg(3)  avg=16.00  max=17.00  bucket=9500-9800  untracked=2.00\n" +
      "[cpu-monitor]   creepWork  8.00  (7.20 + 0.80 fixed)\n" +
      "[cpu-monitor]   towerControl  1.00  (0.80 + 0.20 fixed)",
    );
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
