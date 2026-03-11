import { cpuMonitorCommand, cpuMonitorRaw } from "@/runtime/consoleCommands";

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
        phases: { creepWork: 7, towerControl: 1 },
        untracked: 1,
      },
      {
        tick: 122,
        shard: "shard3",
        totalUsed: 16,
        bucket: 9600,
        limit: 20,
        tickLimit: 500,
        phases: { creepWork: 8, towerControl: 1 },
        untracked: 2,
      },
      {
        tick: 123,
        shard: "shard3",
        totalUsed: 17,
        bucket: 9500,
        limit: 20,
        tickLimit: 500,
        phases: { creepWork: 9, towerControl: 1 },
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
  });

  it("returns json output from command wrapper", () => {
    const parsed = JSON.parse(cpuMonitorCommand());

    expect(parsed.ok).toBe(true);
    expect(parsed).toHaveProperty("latest");
    expect(parsed).toHaveProperty("recentHistory");
    expect(parsed).toHaveProperty("summary");
  });
});
