import { clearMovementAnalyticsForTest, getMovementAnalyticsForTest } from "@/movement";
import { runExternalTelemetryExport } from "@/runtime/externalTelemetry";

describe("runExternalTelemetryExport movement metrics", () => {
  beforeEach(() => {
    Game.time = 5;
    Memory.cfg = {
      telemetry: {
        enabled: true,
        sampleInterval: 1,
        segmentId: 42,
      },
    };
    clearMovementAnalyticsForTest();
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
    Game.rooms = {
      W1N1: {
        name: "W1N1",
        controller: { my: true, level: 3, progress: 50 } as StructureController,
        energyAvailable: 300,
        energyCapacityAvailable: 550,
      } as Room,
    };
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
});
