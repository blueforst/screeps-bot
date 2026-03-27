import { cpuMonitorCommand, cpuMonitorRaw, startTelemetryCommand, statusTelemetryCommand, stopTelemetryCommand } from "@/runtime/consoleCommands";

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

    (global as typeof global & { __cpuPhaseHistory?: Array<ReturnType<typeof cpuMonitorRaw>["latest"]> }).__cpuPhaseHistory = [
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
      },
    ];

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

    (global as typeof global & { __cpuPhaseHistory?: Array<ReturnType<typeof cpuMonitorRaw>["latest"]> }).__cpuPhaseHistory = [
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
      },
    ];

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
