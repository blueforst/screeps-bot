import { cpuMonitorCommand, cpuMonitorRaw, startTelemetryCommand, statusTelemetryCommand, stopTelemetryCommand, statusHubRaw, statusHubCommand, stopHubRaw, stopHubCommand, hubProgressRaw, hubProgressCommand, memoryAuditRaw, memoryAudit, remoteDefenseStatusCommand, remoteDefenseStatusRaw, registerConsoleCommands, startUpgraderCommand, startUpgraderRaw, stopUpgraderCommand, stopUpgraderRaw, upgraderStatusCommand, upgraderStatusRaw } from "@/runtime/consoleCommands";
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
});

describe("hub commands", () => {
  beforeEach(() => {
    Memory.cfg = {};
    Memory.runtime = {};
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
});

function createRoomForRemoteDefense(name: string, options: {
  hostiles?: Creep[];
  structures?: Structure[];
} = {}): Room {
  return {
    name,
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return options.hostiles ?? [];
      if (type === FIND_STRUCTURES) return options.structures ?? [];
      return [];
    }),
  } as unknown as Room;
}

function createRemoteDefenseCreep(name: string, roomName: string, overrides: Partial<{
  id: string;
  owner: string;
  role: CreepMemory["role"];
  configName: string;
  roleArgs: string[];
  x: number;
  y: number;
  hits: number;
  hitsMax: number;
  body: Array<{ type: BodyPartConstant; hits: number; boost?: ResourceConstant }>;
}> = {}): Creep {
  const body = overrides.body ?? [{ type: MOVE, hits: 100 }];
  return {
    id: overrides.id ?? name,
    name,
    owner: { username: overrides.owner ?? "me" },
    pos: { x: overrides.x ?? 25, y: overrides.y ?? 25, roomName },
    room: { name: roomName },
    hits: overrides.hits ?? body.reduce((total, part) => total + part.hits, 0),
    hitsMax: overrides.hitsMax ?? body.length * 100,
    body,
    memory: {
      role: overrides.role,
      roleArgs: overrides.roleArgs,
      configName: overrides.configName,
    },
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => body.filter((bodyPart) => bodyPart.type === part && bodyPart.hits > 0).length),
  } as unknown as Creep;
}

describe("remoteDefenseStatus commands", () => {
  beforeEach(() => {
    Game.time = 100;
    Game.rooms = {};
    Game.creeps = {};
    Game.spawns = {};
    Memory.creeps = {};
    Memory.data = {
      remoteMining: {},
      creepConfigs: {},
    };
  });

  it("reports player aggression when a hostile player is present and a remote creep lost hits", () => {
    const targetRoom = "W1N0";
    const sourceRoom = "W1N1";
    const prefix = `${sourceRoom}:remoteMine:${targetRoom}:`;
    const hostile = createRemoteDefenseCreep("Player", targetRoom, { id: "hostile1", owner: "Enemy" });
    const worker = createRemoteDefenseCreep("remoteWorker", targetRoom, {
      id: "worker1",
      role: "remoteWorker",
      configName: `${prefix}worker:0`,
      hits: 800,
      hitsMax: 1000,
    });
    Game.rooms[targetRoom] = createRoomForRemoteDefense(targetRoom, { hostiles: [hostile] });
    Game.creeps[worker.name] = worker;
    Memory.data!.remoteMining![targetRoom] = {
      sourceRoom,
      targetRoom,
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 90,
      damageSnapshots: {
        creeps: {
          worker1: { tick: 99, hits: 1000 },
        },
        containers: {},
      },
    };

    const result = remoteDefenseStatusRaw(targetRoom);

    expect(result).toMatchObject({
      ok: true,
      trigger: {
        wouldTrigger: true,
        reason: "player_aggression",
        playerHostiles: 1,
        damagedCreeps: [
          {
            id: "worker1",
            previousTick: 99,
            previousHits: 1000,
            currentHits: 800,
            loss: 200,
          },
        ],
      },
    });
  });
});
