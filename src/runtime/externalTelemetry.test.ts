import { clearCreepMovementStateForTest, clearMovementAnalyticsForTest, ensureCreepMovementState, getMovementAnalyticsForTest } from "@/movement";
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
