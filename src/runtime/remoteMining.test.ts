import { registerRuntimeServices } from "@/runtime/runtimeServices";
jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

import {
  ensureRemoteMiningStore,
  getRemoteMiningConfig,
  getRemoteMiningHarvesterConfigName,
  getRemoteMiningCarrierConfigName,
  getRemoteMiningScoutConfigName,
  getRemoteMiningReserverConfigName,
  getRemoteWorkerConfigName,
  getRemoteDefenderConfigName,
  runRemoteMining,
  upsertScoutConfig,
  processRemoteConstruction,
  processRemoteConfigLifecycle,
  getActiveDefenseReason,
  REMOTE_INVADER_CORE_MIN_SOURCE_CAPACITY,
} from "@/runtime/remoteMining";
import { isDefenseMode } from "@/runtime/defenseMode";

beforeEach(() => {
  registerRuntimeServices(undefined);
});

function setupGameMap(exitsMap: Record<string, Record<string, string>>, routeResults?: Record<string, Array<{ room: string; exit: number }>>): void {
  if (!Game.map) (Game as any).map = {} as GameMap;
  Game.map.describeExits = jest.fn((roomName: string) => exitsMap[roomName] ?? null);
  (Game.map as any).findRoute = jest.fn((from: string, to: string) => {
    if (routeResults) {
      const key = `${from}->${to}`;
      if (key in routeResults) return routeResults[key];
    }
    if (exitsMap[from]) {
      for (const [dir, room] of Object.entries(exitsMap[from])) {
        if (room === to) return [{ room: to, exit: Number(dir) }];
      }
    }
    return ERR_NO_PATH;
  });
  (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "normal" }));
}

function createRclRoom(name: string, level: number): Room {
  Memory.rooms[name] = {} as RoomMemory;
  return {
    name,
    memory: Memory.rooms[name],
    controller: {
      my: true,
      level,
    } as unknown as StructureController,
    energyCapacityAvailable: level >= 7 ? REMOTE_INVADER_CORE_MIN_SOURCE_CAPACITY : 2300,
    find: jest.fn(() => []),
  } as unknown as Room;
}

function createVisibleTargetRoom(
  name: string,
  options: {
    sources?: Source[];
    hostileCreeps?: Creep[];
    hostileStructures?: Structure[];
    keeperLairs?: Structure[];
    controllerOwner?: string;
    controllerMy?: boolean;
    reservationUsername?: string;
    reservationTicksToEnd?: number;
  } = {},
): Room {
  Memory.rooms[name] = {} as RoomMemory;
  const sources = options.sources ?? [];
  const hostileCreeps = options.hostileCreeps ?? [];
  const hostileStructures = options.hostileStructures ?? [];
  const keeperLairs = options.keeperLairs ?? [];
  const controller: Partial<StructureController> = {
    my: options.controllerMy ?? false,
    level: 0,
  };
  if (options.controllerOwner) {
    (controller as any).owner = { username: options.controllerOwner };
  }
  if (options.reservationUsername) {
    (controller as any).reservation = {
      username: options.reservationUsername,
      ticksToEnd: options.reservationTicksToEnd ?? 100,
    };
  }
  return {
    name,
    memory: Memory.rooms[name],
    controller: controller as StructureController,
    find: jest.fn((what: number, opts?: { filter?: (s: any) => boolean }) => {
      if (what === FIND_SOURCES) return sources;
      if (what === FIND_HOSTILE_CREEPS) return hostileCreeps;
      if (what === FIND_HOSTILE_STRUCTURES) return opts?.filter ? hostileStructures.filter(opts.filter) : hostileStructures;
      if (what === FIND_STRUCTURES) return opts?.filter ? keeperLairs.filter(opts.filter) : keeperLairs;
      return [];
    }),
  } as unknown as Room;
}

function createSource(id: string): Source {
  return { id } as Source;
}

function createSpawn(room: Room, username = "me"): StructureSpawn {
  return {
    name: `Spawn_${room.name}`,
    room,
    owner: { username },
    memory: {},
  } as unknown as StructureSpawn;
}

describe("runRemoteMining first come assignment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
  });

  it("creates active task for visible cardinal room with exactly two sources", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({
      W1N1: { "1": "W1N0" },
    });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeDefined();
    expect(store["W1N0"].status).toBe("active");
    expect(store["W1N0"].sourceRoom).toBe("W1N1");
    expect(store["W1N0"].sourceIds).toEqual(["src1", "src2"]);
    expect(store["W1N0"].assignedAt).toBe(100);
    expect(store["W1N0"].lastVerifiedAt).toBe(100);
  });
});

// ─── Remote Invader Core clearance ────────────────────────────────

function createRemoteInvaderCore(
  level = 0,
  effects: NaturalEffect[] = [],
): StructureInvaderCore {
  return {
    id: `core-${level}` as Id<StructureInvaderCore>,
    structureType: STRUCTURE_INVADER_CORE,
    level,
    hits: 100_000,
    hitsMax: 100_000,
    effects,
    pos: { x: 25, y: 25, roomName: "W1N0" } as RoomPosition,
  } as unknown as StructureInvaderCore;
}

function createRemoteInvader(id = "invader-core-escort"): Creep {
  return {
    id: id as Id<Creep>,
    owner: { username: "Invader" },
    body: [{ type: ATTACK, hits: 100 }],
    hits: 100,
    hitsMax: 100,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => part === ATTACK ? 1 : 0),
  } as unknown as Creep;
}

describe("remote Invader Core clearance", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  beforeEach(() => {
    jest.clearAllMocks();
    (isDefenseMode as jest.Mock).mockReturnValue(false);
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
  });

  function setupSourceRoom(capacity = REMOTE_INVADER_CORE_MIN_SOURCE_CAPACITY): StructureSpawn {
    const sourceRoom = createRclRoom("W1N1", 7);
    sourceRoom.energyCapacityAvailable = capacity;
    Game.rooms[sourceRoom.name] = sourceRoom;
    const spawn = createSpawn(sourceRoom);
    Game.spawns[spawn.name] = spawn;
    return spawn;
  }

  function setupTask(
    status: import("@/runtime/remoteMining").RemoteMiningStatus = "active",
  ): import("@/runtime/remoteMining").RemoteMiningTask {
    const task: import("@/runtime/remoteMining").RemoteMiningTask = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status,
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 50,
    };
    store[task.targetRoom] = task;
    return task;
  }

  function setupTarget(core?: StructureInvaderCore, hostileCreeps: Creep[] = []): Room {
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      hostileCreeps,
      hostileStructures: core ? [core] : [],
      reservationUsername: core ? "Invader" : undefined,
    });
    Game.rooms[target.name] = target;
    return target;
  }

  it("enters Core defense with one stable defender config and keeps scout vision", () => {
    setupSourceRoom();
    const core = createRemoteInvaderCore();
    const target = setupTarget(core);
    const task = setupTask();

    expect(getActiveDefenseReason(target, task)).toBe("npc_invader_core");

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    Game.time += 1;
    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const defenderName = getRemoteDefenderConfigName("W1N1", "W1N0");
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(task.status).toBe("defending");
    expect(task.defenseReason).toBe("npc_invader_core");
    expect(Memory.data!.creepConfigs![defenderName]).toEqual({
      role: "remoteDefender", args: ["W1N0"], roomName: "W1N1",
    });
    expect(Memory.data!.creepConfigs![scoutName]).toEqual({
      role: "scout", args: ["W1N0"], roomName: "W1N1",
    });
    expect(Object.keys(Memory.data!.creepConfigs!).filter(name => name === defenderName)).toHaveLength(1);
  });

  it("migrates legacy hostile_structures suspension directly into Core defense", () => {
    setupSourceRoom();
    setupTarget(createRemoteInvaderCore());
    const task = setupTask("suspended");
    task.suspendReason = "hostile_structures";
    task.suspendedAt = 80;

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(task.status).toBe("defending");
    expect(task.defenseReason).toBe("npc_invader_core");
    expect(task.suspendReason).toBeUndefined();
    expect(Memory.data!.creepConfigs![getRemoteDefenderConfigName("W1N1", "W1N0")]).toBeDefined();
  });

  it("keeps scouting but does not spawn a defender while the Core is invulnerable", () => {
    setupSourceRoom();
    const core = createRemoteInvaderCore(0, [{
      effect: EFFECT_INVULNERABILITY,
      ticksRemaining: 5,
    }]);
    setupTarget(core);
    const task = setupTask();

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(task.status).toBe("defending");
    expect(Memory.data!.creepConfigs![getRemoteDefenderConfigName("W1N1", "W1N0")]).toBeUndefined();
    expect(Memory.data!.creepConfigs![getRemoteMiningScoutConfigName("W1N1", "W1N0")]).toBeDefined();

    (core.effects![0] as NaturalEffect).ticksRemaining = 0;
    Game.time += 1;
    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(Memory.data!.creepConfigs![getRemoteDefenderConfigName("W1N1", "W1N0")]).toBeDefined();
  });

  it("does not mark completion or retain defender spawn eligibility without vision", () => {
    const spawn = setupSourceRoom();
    const task = setupTask("defending");
    task.defenseReason = "npc_invader_core";
    task.defendingSince = 80;
    const defenderName = getRemoteDefenderConfigName("W1N1", "W1N0");
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![defenderName] = {
      role: "remoteDefender", args: ["W1N0"], roomName: "W1N1",
    };
    spawn.memory.spawnList = [defenderName, defenderName, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(task.status).toBe("defending");
    expect(task.defenseReason).toBe("npc_invader_core");
    expect(Memory.data!.creepConfigs![defenderName]).toBeUndefined();
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();
    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });

  it("suspends high-level Strongholds and insufficient source capacity", () => {
    setupSourceRoom();
    setupTarget(createRemoteInvaderCore(1));
    const highLevelTask = setupTask();

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(highLevelTask.status).toBe("suspended");
    expect(["hostile_structures", "hostile_reservation"]).toContain(highLevelTask.suspendReason);
    expect(Memory.data!.creepConfigs![getRemoteDefenderConfigName("W1N1", "W1N0")]).toBeUndefined();

    Game.rooms = {};
    Game.spawns = {};
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    setupSourceRoom(REMOTE_INVADER_CORE_MIN_SOURCE_CAPACITY - 1);
    setupTarget(createRemoteInvaderCore());
    highLevelTask.status = "active";
    delete highLevelTask.suspendReason;

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(highLevelTask.status).toBe("suspended");
    expect(highLevelTask.suspendReason).toBe("invader_core_insufficient_capacity");
    expect(Memory.data!.creepConfigs![getRemoteDefenderConfigName("W1N1", "W1N0")]).toBeUndefined();
  });

  it("suppresses all Core clearance spawning in source-room defense mode", () => {
    const spawn = setupSourceRoom();
    setupTarget(createRemoteInvaderCore());
    setupTask();
    const defenderName = getRemoteDefenderConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![defenderName] = {
      role: "remoteDefender", args: ["W1N0"], roomName: "W1N1",
    };
    spawn.memory.spawnList = [defenderName, defenderName];
    (isDefenseMode as jest.Mock).mockReturnValue(true);

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![defenderName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual([]);
  });

  it("resumes immediately after visible Core disappearance and removes every queued duplicate", () => {
    const spawn = setupSourceRoom();
    setupTarget();
    const task = setupTask("defending");
    task.defenseReason = "npc_invader_core";
    task.defendingSince = 80;
    const defenderName = getRemoteDefenderConfigName("W1N1", "W1N0");
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![defenderName] = {
      role: "remoteDefender", args: ["W1N0"], roomName: "W1N1",
    };
    Memory.data!.creepConfigs![scoutName] = {
      role: "scout", args: ["W1N0"], roomName: "W1N1",
    };
    spawn.memory.spawnList = [defenderName, scoutName, defenderName, scoutName, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    Game.time += 1;
    expect(() => processRemoteConfigLifecycle(store, getRemoteMiningConfig())).not.toThrow();

    expect(task.status).toBe("active");
    expect(task.defenseReason).toBeUndefined();
    expect(Memory.data!.creepConfigs![defenderName]).toBeUndefined();
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });

  it("switches to ordinary NPC defense when an Invader creep remains after Core removal", () => {
    setupSourceRoom();
    setupTarget(undefined, [createRemoteInvader()]);
    const task = setupTask("defending");
    task.defenseReason = "npc_invader_core";
    task.defendingSince = 80;

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(task.status).toBe("defending");
    expect(task.defenseReason).toBe("npc_invader");
    expect(Memory.data!.creepConfigs![getRemoteDefenderConfigName("W1N1", "W1N0")]).toBeDefined();
  });

  it("cleans abandoned invisible Core configs and queues idempotently", () => {
    const spawn = setupSourceRoom();
    setupTask("abandoned");
    const defenderName = getRemoteDefenderConfigName("W1N1", "W1N0");
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![defenderName] = {
      role: "remoteDefender", args: ["W1N0"], roomName: "W1N1",
    };
    Memory.data!.creepConfigs![scoutName] = {
      role: "scout", args: ["W1N0"], roomName: "W1N1",
    };
    spawn.memory.spawnList = [defenderName, scoutName, defenderName, scoutName];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    Game.time += 1;
    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![defenderName]).toBeUndefined();
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual([]);
  });
});

// ─── Remote construction tests ──────────────────────────────

type MockConRoom = Room & {
  __structures: Array<Structure<StructureConstant>>;
  __sites: Array<ConstructionSite>;
  __siteAttempts: Array<{ x: number; y: number; structureType: BuildableStructureConstant }>;
};

class ConMockRoomPosition {
  public constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly roomName: string,
  ) {}

  public lookFor(type: LookConstant): Array<Structure<StructureConstant> | ConstructionSite> {
    const room = Game.rooms[this.roomName] as MockConRoom | undefined;
    if (!room) return [];
    if (type === LOOK_STRUCTURES) {
      return room.__structures.filter(s => s.pos.x === this.x && s.pos.y === this.y);
    }
    if (type === LOOK_CONSTRUCTION_SITES) {
      return room.__sites.filter(s => s.pos.x === this.x && s.pos.y === this.y);
    }
    return [];
  }
}

function createConRoom(name: string, options: { level?: number; storage?: StructureStorage; controllerMy?: boolean } = {}): MockConRoom {
  const structures: Array<Structure<StructureConstant>> = [];
  const sites: Array<ConstructionSite> = [];
  const siteAttempts: Array<{ x: number; y: number; structureType: BuildableStructureConstant }> = [];

  const room = {
    name,
    controller: {
      my: options.controllerMy ?? true,
      level: options.level ?? 7,
      pos: new ConMockRoomPosition(25, 25, name),
    } as StructureController,
    storage: options.storage ?? null,
    __structures: structures,
    __sites: sites,
    __siteAttempts: siteAttempts,
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [];
      if (type === FIND_HOSTILE_CREEPS) return [];
      if (type === FIND_HOSTILE_STRUCTURES) return [];
      if (type === FIND_STRUCTURES) return [];
      if (type === FIND_CONSTRUCTION_SITES) return [];
      return [];
    }),
    createConstructionSite: jest.fn((x: number, y: number, structureType: BuildableStructureConstant) => {
      siteAttempts.push({ x, y, structureType });
      const site = {
        id: `${structureType}:${x}:${y}:${sites.length}`,
        pos: new ConMockRoomPosition(x, y, name),
        structureType,
        my: true,
        room,
      } as unknown as ConstructionSite;
      sites.push(site);
      (Game.constructionSites as Record<string, ConstructionSite>)[site.id] = site;
      return OK;
    }),
    getTerrain: jest.fn(() => ({
      get: jest.fn(() => 0),
    })),
  } as unknown as MockConRoom;

  Object.assign(room, { __structures: structures, __sites: sites, __siteAttempts: siteAttempts });
  return room;
}

function createConSource(id: string, room: Room, x: number, y: number): Source {
  return {
    id,
    room,
    pos: new ConMockRoomPosition(x, y, room.name) as unknown as RoomPosition,
  } as Source;
}

function setupActiveTask(
  store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>,
  sourceRoomName: string,
  targetRoomName: string,
  sourceIds: string[],
): import("@/runtime/remoteMining").RemoteMiningTask {
  const task: import("@/runtime/remoteMining").RemoteMiningTask = {
    sourceRoom: sourceRoomName,
    targetRoom: targetRoomName,
    status: "active",
    sourceIds,
    assignedAt: 100,
    updatedAt: 100,
  };
  store[targetRoomName] = task;
  return task;
}

function makePathPositions(
  startX: number, startY: number, startRoom: string,
  endX: number, endY: number, endRoom: string,
): RoomPosition[] {
  const path: RoomPosition[] = [];
  const steps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY));
  for (let i = 0; i <= steps; i++) {
    const x = startX + Math.round((endX - startX) * i / steps);
    const y = startY + Math.round((endY - startY) * i / steps);
    path.push(new ConMockRoomPosition(x, y, i < steps / 2 ? startRoom : endRoom) as unknown as RoomPosition);
  }
  return path;
}

describe("remote construction caps", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    (global as any).RoomPosition = ConMockRoomPosition;
    (global as any).PathFinder = {
      search: jest.fn(),
      CostMatrix: class {
        private data: number[] = new Array(2500).fill(0);
        set(x: number, y: number, val: number) { this.data[y * 50 + x] = val; }
        get(x: number, y: number) { return this.data[y * 50 + x]; }
      },
    };
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Game.constructionSites = {} as Game["constructionSites"];
    Memory.runtime = {};
    Memory.cfg = {};
    store = ensureRemoteMiningStore();
  });

  it("reuses shared corridor between two source paths and deduplicates road positions", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0", { controllerMy: false });
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10), createConSource("src2", targetRoom, 40, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    // Path to src1: goes through a corridor at y=14 in W1N0
    const path1: RoomPosition[] = [
      new ConMockRoomPosition(25, 25, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(0, 25, "W1N0") as unknown as RoomPosition,
      new ConMockRoomPosition(10, 14, "W1N0") as unknown as RoomPosition,
      new ConMockRoomPosition(9, 10, "W1N0") as unknown as RoomPosition,
    ];
    // Path to src2: shares the corridor at y=14, diverges at x=20
    const path2: RoomPosition[] = [
      new ConMockRoomPosition(25, 25, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(0, 25, "W1N0") as unknown as RoomPosition,
      new ConMockRoomPosition(10, 14, "W1N0") as unknown as RoomPosition,
      new ConMockRoomPosition(20, 14, "W1N0") as unknown as RoomPosition,
      new ConMockRoomPosition(39, 10, "W1N0") as unknown as RoomPosition,
    ];

    (PathFinder.search as jest.Mock)
      .mockReturnValueOnce({ path: path1, incomplete: false, ops: 10, cost: 10 })
      .mockReturnValueOnce({ path: path2, incomplete: false, ops: 10, cost: 10 });

    setupActiveTask(store, "W1N1", "W1N0", ["src1", "src2"]);
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      if (id === "src2") return createConSource("src2", targetRoom, 40, 10);
      return null;
    });

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    const task = store["W1N0"];
    expect(task.roadPlan).toBeDefined();
    const positions = task.roadPlan!.positions;

    // No duplicate positions
    const posKeys = positions.map(p => `${p.roomName}:${p.x}:${p.y}`);
    expect(new Set(posKeys).size).toBe(posKeys.length);

    // Shared corridor position (10,14) must be present exactly once
    const corridorCount = positions.filter(p => p.x === 10 && p.y === 14 && p.roomName === "W1N0").length;
    expect(corridorCount).toBe(1);

    // Both source branches present
    expect(positions.some(p => p.x === 9 && p.y === 10)).toBe(true);
    expect(positions.some(p => p.x === 39 && p.y === 10)).toBe(true);
  });
});

// ─── Config lifecycle tests ──────────────────────────────────────

function ensureConfigStore(): Record<string, import("@/types/system").CreepConfig> {
  Memory.data = Memory.data ?? {};
  Memory.data.creepConfigs = Memory.data.creepConfigs ?? {};
  return Memory.data.creepConfigs;
}

describe("stale config prefix cleanup", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
  });

  it("removes stale harvester/carrier names from spawn queues by prefix, not only expected names", () => {
    const rcl6Room = createRclRoom("W1N1", 6);
    Game.rooms["W1N1"] = rcl6Room;
    const spawn = createSpawn(rcl6Room);
    Game.spawns["Spawn1"] = spawn;

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    const staleCarrier = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 5);
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    spawn.memory.spawnList = [h1, staleCarrier, scoutName, "W1N1:worker:0"];

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });
});

describe("stale carrier reconciliation for active tasks", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
  });

  it("removes stale carrier:2+ configs while keeping carrier:0 and carrier:1 for dual-source task", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const configs = ensureConfigStore();
    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    const c1 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 1);
    const c2 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 2);
    configs[c0] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };
    configs[c1] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };
    configs[c2] = { role: "remoteMiningCarrier", args: ["W1N0", "src2"], roomName: "W1N1" };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(configs[c0]).toBeDefined();
    expect(configs[c0].args).toEqual(["W1N0", "src1"]);
    expect(configs[c1]).toBeDefined();
    expect(configs[c1].args).toEqual(["W1N0", "src2"]);
    expect(configs[c2]).toBeUndefined();
  });
});

// ─── Remote reserver config lifecycle tests ────────────────────

describe("remote reserver", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
  });

function createInvaderCreep(id: string, bodyParts: Partial<Record<BodyPartConstant, number>>): Creep {
  return {
    id,
    owner: { username: "Invader" },
    getActiveBodyparts: (part: BodyPartConstant) => bodyParts[part] ?? 0,
  } as unknown as Creep;
}

function createPlayerCreep(id: string, username = "Player1"): Creep {
  return {
    id,
    owner: { username },
    getActiveBodyparts: () => 0,
    body: [],
  } as unknown as Creep;
}

function createSourceWithPosDef(id: string, x: number, y: number, roomName: string): Source {
  return {
    id,
    pos: { x, y, roomName } as RoomPosition,
  } as Source;
}

function createContainerStructureDef(id: string, x: number, y: number, roomName: string, hits: number, hitsMax: number): StructureContainer {
  return {
    id,
    structureType: STRUCTURE_CONTAINER as StructureConstant,
    pos: { x, y, roomName } as RoomPosition,
    hits,
    hitsMax,
  } as unknown as StructureContainer;
}

function createDefendingTargetRoom(
  name: string,
  options: {
    sources?: Source[];
    hostileCreeps?: Creep[];
    hostileStructures?: Structure[];
    keeperLairs?: Structure[];
    controllerOwner?: string;
    controllerMy?: boolean;
    reservationUsername?: string;
    structures?: Array<Structure<StructureConstant>>;
  } = {},
): Room {
  const sources = options.sources ?? [];
  const hostileCreeps = options.hostileCreeps ?? [];
  const hostileStructures = options.hostileStructures ?? [];
  const keeperLairs = options.keeperLairs ?? [];
  const allStructures = options.structures ?? [];
  const controller: Partial<StructureController> = {
    my: options.controllerMy ?? false,
    level: 0,
  };
  if (options.controllerOwner) {
    (controller as any).owner = { username: options.controllerOwner };
  }
  if (options.reservationUsername) {
    (controller as any).reservation = {
      username: options.reservationUsername,
      ticksToEnd: 100,
    };
  }
  Memory.rooms[name] = {} as RoomMemory;
  return {
    name,
    memory: Memory.rooms[name],
    controller: controller as StructureController,
    find: jest.fn((what: number, opts?: { filter?: (s: any) => boolean }) => {
      if (what === FIND_SOURCES) return sources;
      if (what === FIND_HOSTILE_CREEPS) return hostileCreeps;
      if (what === FIND_HOSTILE_STRUCTURES) return opts?.filter ? hostileStructures.filter(opts.filter) : hostileStructures;
      if (what === FIND_STRUCTURES) {
        const all = [...keeperLairs, ...allStructures];
        if (opts?.filter) return all.filter(opts.filter);
        return all;
      }
      if (what === FIND_CONSTRUCTION_SITES) return [];
      return [];
    }),
  } as unknown as Room;
}

// ─── Remote worker lifecycle tests ──────────────────────────────────

describe("remote worker lifecycle", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  function createSourceWithPos(id: string, x: number, y: number): Source {
    return { id, pos: { x, y, roomName: "W2N1" } as RoomPosition } as Source;
  }

  function makeContainer(id: string, x: number, y: number, hits: number, hitsMax: number): StructureContainer {
    return {
      id,
      structureType: STRUCTURE_CONTAINER as StructureConstant,
      pos: { x, y, roomName: "W2N1" } as RoomPosition,
      hits,
      hitsMax,
    } as unknown as StructureContainer;
  }

  function makeContainerSite(x: number, y: number, mine: boolean): ConstructionSite {
    return {
      structureType: STRUCTURE_CONTAINER as StructureConstant,
      pos: { x, y, roomName: "W2N1" } as RoomPosition,
      my: mine,
    } as unknown as ConstructionSite;
  }

  function makeRoadSite(x: number, y: number): ConstructionSite {
    return {
      structureType: STRUCTURE_ROAD as StructureConstant,
      pos: { x, y, roomName: "W2N1" } as RoomPosition,
      my: true,
    } as unknown as ConstructionSite;
  }

  function makeRoad(x: number, y: number, hits: number): StructureRoad {
    return {
      structureType: STRUCTURE_ROAD as StructureConstant,
      pos: { x, y, roomName: "W2N1" } as RoomPosition,
      hits,
      hitsMax: 5000,
    } as unknown as StructureRoad;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 200;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
  });

  it("removes worker config when container repaired above threshold", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const src = createSourceWithPos("src1", 10, 10);
    const container = makeContainer("cont1", 10, 10, 200000, 250000);
    const target = createVisibleTargetRoom("W2N1", { sources: [src] });
    (target.find as jest.Mock).mockImplementation((what: number, opts?: { filter?: (s: any) => boolean }) => {
      if (what === FIND_STRUCTURES) return opts?.filter ? [container].filter(opts.filter) : [container];
      if (what === FIND_CONSTRUCTION_SITES) return [];
      return [];
    });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return src;
      return null;
    });

    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W2N1"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    const configName = getRemoteWorkerConfigName("W1N1", "W2N1");
    Memory.data!.creepConfigs![configName] = { role: "remoteWorker", args: ["W2N1"], roomName: "W1N1" };

    store["W2N1"] = {
      sourceRoom: "W1N1", targetRoom: "W2N1", status: "active",
      sourceIds: ["src1"], assignedAt: 100, updatedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![configName]).toBeUndefined();
  });
});

describe("defending state - passive suspend reasons remain intact", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
  });

  it("hostile reservation still causes passive suspended, not defending", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const invader = createInvaderCreep("inv1", { [ATTACK]: 1 });
    const target = createDefendingTargetRoom("W1N0", {
      sources: [createSource("src1")],
      reservationUsername: "enemy",
      hostileCreeps: [invader],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].status).toBe("suspended");
    expect(store["W1N0"].suspendReason).toBe("hostile_reservation");
  });
});

  it("removes pre-existing reserver config when self-reservation is above threshold", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      reservationUsername: "me",
      reservationTicksToEnd: 4000,
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      updatedAt: 100,
    };

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![reserverName] = {
      role: "remoteMiningReserver",
      args: ["W1N0"],
      roomName: "W1N1",
    };

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    Memory.data!.creepConfigs![h1] = {
      role: "colonizerHarvester",
      args: ["W1N0", "src1"],
      roomName: "W1N1",
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![reserverName]).toBeUndefined();
    expect(Memory.data!.creepConfigs![h1]).toBeDefined();
  });

// ─── Scout visibility lifecycle tests ──────────────────────────────

describe("scout visibility lifecycle", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 200;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
  });

  it("active visible target removes stale scout config and spawn queue entry", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    const spawn = createSpawn(rcl7Room);
    Game.spawns["Spawn1"] = spawn;

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      updatedAt: 100,
    };

    // Pre-existing stale scout config and spawn queue entry
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![scoutName] = { role: "scout", args: ["W1N0"], roomName: "W1N1" };
    spawn.memory.spawnList = [scoutName, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });
});

// ─── Defending lifecycle: defender config orchestration ──────────────

describe("defending lifecycle", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
  });

  it("removes stale scout config and spawn queue when resuming from defending to active", () => {
    Game.time = 300;
    const rcl7Room = createRclRoom("W1N1", 7);
    const target = createDefendingTargetRoom("W1N0", {
      sources: [createSource("src1")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    const spawn = createSpawn(rcl7Room);
    Game.spawns["Spawn1"] = spawn;

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![scoutName] = { role: "scout", args: ["W1N0"], roomName: "W1N1" };
    spawn.memory.spawnList = [scoutName, "W1N1:worker:0"];

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "defending",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 100,
      defendingSince: 100, lastDefenseThreatAt: 100,
      defenseReason: "npc_invader", lastDefenseSafeAt: 200,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const defenderName = getRemoteDefenderConfigName("W1N1", "W1N0");
    expect(store["W1N0"].status).toBe("active");
    expect(Memory.data!.creepConfigs![defenderName]).toBeUndefined();
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    expect(spawn.memory.spawnList).not.toContain(scoutName);
  });
});

  // ─── Full cleanup (suspended/abandoned/source invalid removes worker+defender) ───

  describe("full cleanup removes worker and defender", () => {

    it("active task with passive threat (hostile_owner) removes worker and defender configs", () => {
      const rcl7Room = createRclRoom("W1N1", 7);
      Game.rooms["W1N1"] = rcl7Room;
      const spawn = createSpawn(rcl7Room);
      Game.spawns["Spawn1"] = spawn;

      const hostileTarget = createVisibleTargetRoom("W1N0", {
        sources: [createSource("src1"), createSource("src2")],
        controllerOwner: "enemy",
      });
      Game.rooms["W1N0"] = hostileTarget;

      store["W1N0"] = {
        sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
        sourceIds: ["src1", "src2"], assignedAt: 50, updatedAt: 50,
      };

      const w0 = getRemoteWorkerConfigName("W1N1", "W1N0");
      const d0 = getRemoteDefenderConfigName("W1N1", "W1N0");
      Memory.data!.creepConfigs![w0] = { role: "remoteWorker", args: ["W1N0"], roomName: "W1N1" };
      Memory.data!.creepConfigs![d0] = { role: "remoteDefender", args: ["W1N0"], roomName: "W1N1" };
      spawn.memory.spawnList = [w0, d0, "W1N1:worker:0"];

      processRemoteConfigLifecycle(store, getRemoteMiningConfig());

      expect(store["W1N0"].status).toBe("suspended");
      expect(store["W1N0"].suspendReason).toBe("hostile_owner");
      expect(Memory.data!.creepConfigs![w0]).toBeUndefined();
      expect(Memory.data!.creepConfigs![d0]).toBeUndefined();
      expect(spawn.memory.spawnList).not.toContain(w0);
      expect(spawn.memory.spawnList).not.toContain(d0);
      expect(spawn.memory.spawnList).toContain("W1N1:worker:0");
    });
  });
});
