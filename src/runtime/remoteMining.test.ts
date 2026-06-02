import { registerRuntimeServices } from "@/runtime/runtimeServices";
import {
  ensureRemoteMiningStore,
  getRemoteMiningConfig,
  getRemoteMiningHarvesterConfigName,
  getRemoteMiningCarrierConfigName,
  getRemoteMiningScoutConfigName,
  getRemoteMiningReserverConfigName,
  runRemoteMining,
  upsertScoutConfig,
  processRemoteConstruction,
  processRemoteConfigLifecycle,
} from "@/runtime/remoteMining";

beforeEach(() => {
  registerRuntimeServices(undefined);
});

describe("remote mining store", () => {
  it("creates remoteMining without clobbering existing data keys", () => {
    Memory.data = {
      creepConfigs: { "W1N1:worker:0": { role: "worker", args: [] } },
    };

    const store = ensureRemoteMiningStore();

    expect(store).toEqual({});
    expect(Memory.data.creepConfigs).toEqual({ "W1N1:worker:0": { role: "worker", args: [] } });
    expect(Memory.data.remoteMining).toBe(store);
  });

  it("returns existing store when already initialized", () => {
    const existing = { W2N2: { sourceRoom: "W1N1", targetRoom: "W2N2", status: "active" as const, sourceIds: ["s1"], assignedAt: 100, updatedAt: 100 } };
    Memory.data = { remoteMining: existing };

    const store = ensureRemoteMiningStore();

    expect(store).toBe(existing);
  });

  it("initializes Memory.data itself when absent", () => {
    expect(Memory.data).toBeUndefined();

    const store = ensureRemoteMiningStore();

    expect(Memory.data).toBeDefined();
    expect(Memory.data!.remoteMining).toBe(store);
  });
});

describe("getRemoteMiningConfig", () => {
  it("returns defaults when no cfg overrides", () => {
    const config = getRemoteMiningConfig();

    expect(config.enabled).toBe(true);
    expect(config.scanInterval).toBe(50);
    expect(config.roadInterval).toBe(100);
    expect(config.scoutTimeout).toBe(1500);
    expect(config.maxRemoteRoomsPerSourceRoom).toBe(1);
    expect(config.maintenanceReserveEnergy).toBe(100);
    expect(config.maxRemoteSitesPerRun).toBe(2);
    expect(config.remoteSafeTicksToResume).toBe(100);
    expect(config.remoteReservationRenewAt).toBe(3000);
  });

  it("respects explicit overrides", () => {
    Memory.cfg = {
      remoteMining: {
        enabled: false,
        scanInterval: 200,
        roadInterval: 300,
        scoutTimeout: 4000,
        maxRemoteRoomsPerSourceRoom: 3,
        maintenanceReserveEnergy: 200,
        maxRemoteSitesPerRun: 5,
        remoteSafeTicksToResume: 500,
      },
    };

    const config = getRemoteMiningConfig();

    expect(config.enabled).toBe(false);
    expect(config.scanInterval).toBe(200);
    expect(config.roadInterval).toBe(300);
    expect(config.scoutTimeout).toBe(4000);
    expect(config.maxRemoteRoomsPerSourceRoom).toBe(3);
    expect(config.maintenanceReserveEnergy).toBe(200);
    expect(config.maxRemoteSitesPerRun).toBe(5);
    expect(config.remoteSafeTicksToResume).toBe(500);
  });

  it("enabled defaults to true when cfg.remoteMining exists but enabled is undefined", () => {
    Memory.cfg = { remoteMining: { scanInterval: 99 } };

    const config = getRemoteMiningConfig();

    expect(config.enabled).toBe(true);
    expect(config.scanInterval).toBe(99);
  });

  it("enabled becomes false only when explicitly set to false", () => {
    Memory.cfg = { remoteMining: { enabled: false } };

    expect(getRemoteMiningConfig().enabled).toBe(false);
  });
});

describe("config name helpers", () => {
  const sourceRoom = "W1N1";
  const targetRoom = "W2N1";
  const sourceId = "abc123";

  it("harvester name contains :remoteMine: and sourceId", () => {
    const name = getRemoteMiningHarvesterConfigName(sourceRoom, targetRoom, sourceId);

    expect(name).toBe("W1N1:remoteMine:W2N1:harvester:abc123");
    expect(name).toContain(":remoteMine:");
    expect(name).not.toContain(":haul:");
    expect(name).not.toContain(":colonize:");
  });

  it("carrier name contains :remoteMine: and index", () => {
    const name = getRemoteMiningCarrierConfigName(sourceRoom, targetRoom, 0);

    expect(name).toBe("W1N1:remoteMine:W2N1:carrier:0");
    expect(name).toContain(":remoteMine:");
    expect(name).not.toContain(":haul:");
    expect(name).not.toContain(":colonize:");

    const name2 = getRemoteMiningCarrierConfigName(sourceRoom, targetRoom, 2);
    expect(name2).toBe("W1N1:remoteMine:W2N1:carrier:2");
  });

  it("scout name contains :remoteMine: and no index", () => {
    const name = getRemoteMiningScoutConfigName(sourceRoom, targetRoom);

    expect(name).toBe("W1N1:remoteMine:W2N1:scout");
    expect(name).toContain(":remoteMine:");
    expect(name).not.toContain(":haul:");
    expect(name).not.toContain(":colonize:");
  });

  it("all names share the same prefix pattern", () => {
    const prefix = `${sourceRoom}:remoteMine:${targetRoom}:`;
    expect(getRemoteMiningHarvesterConfigName(sourceRoom, targetRoom, sourceId)).toContain(prefix);
    expect(getRemoteMiningCarrierConfigName(sourceRoom, targetRoom, 0)).toContain(prefix);
    expect(getRemoteMiningScoutConfigName(sourceRoom, targetRoom)).toContain(prefix);
    expect(getRemoteMiningReserverConfigName(sourceRoom, targetRoom)).toContain(prefix);
  });

  it("reserver name ends with :reserver:0", () => {
    const name = getRemoteMiningReserverConfigName(sourceRoom, targetRoom);

    expect(name).toBe("W1N1:remoteMine:W2N1:reserver:0");
    expect(name).toContain(":reserver:");
  });
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
    find: jest.fn((what: number) => {
      if (what === FIND_SOURCES) return sources;
      if (what === FIND_HOSTILE_CREEPS) return hostileCreeps;
      if (what === FIND_HOSTILE_STRUCTURES) return hostileStructures;
      if (what === FIND_STRUCTURES) return keeperLairs;
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

describe("runRemoteMining disabled", () => {
  beforeEach(() => {
    Memory.runtime = {};
  });

  it("does nothing when config.enabled is false", () => {
    Memory.cfg = { remoteMining: { enabled: false } };
    const store = ensureRemoteMiningStore();
    runRemoteMining();
    expect(Object.keys(store)).toHaveLength(0);
  });
});

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

  it("skips RCL6 rooms, only scans RCL7+", () => {
    const rcl6Room = createRclRoom("W1N1", 6);
    Game.rooms["W1N1"] = rcl6Room;
    Game.spawns["Spawn1"] = createSpawn(rcl6Room);
    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(Object.keys(store)).toHaveLength(0);
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

  it("creates scouting task for non-visible but eligible cardinal room", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({
      W1N1: { "1": "W1N0" },
    });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeDefined();
    expect(store["W1N0"].status).toBe("scouting");
    expect(store["W1N0"].sourceRoom).toBe("W1N1");
    expect(store["W1N0"].sourceIds).toEqual([]);
    expect(store["W1N0"].assignedAt).toBe(100);
    expect(store["W1N0"].lastVerifiedAt).toBeUndefined();
  });

  it("scans cardinal exits in numeric order (1,3,5,7) and takes the first eligible", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    (Game.map as any) = {} as GameMap;
    Game.map.describeExits = jest.fn(() => ({
      "1": "W1N0",
      "3": "W2N1",
      "5": "W1N2",
      "7": "W0N1",
    }));
    (Game.map as any).findRoute = jest.fn((_from: string, to: string) => {
      return [{ room: to, exit: FIND_EXIT_TOP }];
    });
    (Game.map as any).getRoomStatus = jest.fn((roomName: string) => ({
      status: roomName === "W1N0" ? "normal" : "novice",
    }));

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeDefined();
    expect(store["W1N0"].status).toBe("scouting");
    expect(store["W2N1"]).toBeUndefined();
  });

  it("rejects multi-step routes", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    (Game.map as any) = {} as GameMap;
    Game.map.describeExits = jest.fn(() => ({ "1": "W1N0" }));
    (Game.map as any).findRoute = jest.fn(() => [
      { room: "W1N0a", exit: FIND_EXIT_TOP },
      { room: "W1N0", exit: FIND_EXIT_BOTTOM },
    ]);
    (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "normal" }));

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("rejects ERR_NO_PATH from findRoute", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    (Game.map as any) = {} as GameMap;
    Game.map.describeExits = jest.fn(() => ({ "1": "W1N0" }));
    (Game.map as any).findRoute = jest.fn(() => ERR_NO_PATH);
    (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "normal" }));

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("rejects non-normal room status", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    (Game.map as any) = {} as GameMap;
    Game.map.describeExits = jest.fn(() => ({ "1": "W1N0" }));
    (Game.map as any).findRoute = jest.fn(() => [{ room: "W1N0", exit: FIND_EXIT_TOP }]);
    (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "novice" }));

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("first come competition: sorted source rooms, first claim wins", () => {
    const roomA = createRclRoom("W0N1", 7);
    const roomB = createRclRoom("W2N1", 7);
    Game.rooms["W0N1"] = roomA;
    Game.rooms["W2N1"] = roomB;
    Game.spawns["SpawnA"] = createSpawn(roomA);
    Game.spawns["SpawnB"] = createSpawn(roomB);

    (Game.map as any) = {} as GameMap;
    Game.map.describeExits = jest.fn((roomName: string) => {
      if (roomName === "W0N1") return { "5": "W0N0", "3": "W1N1" };
      if (roomName === "W2N1") return { "5": "W2N0", "7": "W1N1" };
      return null;
    });
    (Game.map as any).findRoute = jest.fn((_from: string, to: string) => [{ room: to, exit: FIND_EXIT_TOP }]);
    (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "normal" }));

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N1"]).toBeDefined();
    expect(store["W1N1"]!.sourceRoom).toBe("W0N1");
  });

  it("first come competition: later source room skips existing target keys", () => {
    const roomA = createRclRoom("W0N1", 7);
    const roomB = createRclRoom("W2N1", 7);
    Game.rooms["W0N1"] = roomA;
    Game.rooms["W2N1"] = roomB;
    Game.spawns["SpawnA"] = createSpawn(roomA);
    Game.spawns["SpawnB"] = createSpawn(roomB);

    const store = ensureRemoteMiningStore();
    store["W1N1"] = {
      sourceRoom: "W0N1",
      targetRoom: "W1N1",
      status: "active",
      sourceIds: ["s1", "s2"],
      assignedAt: 50,
      updatedAt: 50,
    };

    (Game.map as any) = {} as GameMap;
    Game.map.describeExits = jest.fn((roomName: string) => {
      if (roomName === "W0N1") return { "3": "W1N1" };
      if (roomName === "W2N1") return { "7": "W1N1" };
      return null;
    });
    (Game.map as any).findRoute = jest.fn((_from: string, to: string) => [{ room: to, exit: FIND_EXIT_TOP }]);
    (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "normal" }));

    runRemoteMining();

    expect(store["W1N1"]!.sourceRoom).toBe("W0N1");
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("enforces source-room cap (default maxRemoteRoomsPerSourceRoom=1)", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    const store = ensureRemoteMiningStore();
    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["s1", "s2"],
      assignedAt: 50,
      updatedAt: 50,
    };

    (Game.map as any) = {} as GameMap;
    Game.map.describeExits = jest.fn(() => ({
      "1": "W1N0",
      "3": "W2N1",
    }));
    (Game.map as any).findRoute = jest.fn((_from: string, to: string) => [{ room: to, exit: FIND_EXIT_RIGHT }]);
    (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "normal" }));

    runRemoteMining();

    expect(store["W2N1"]).toBeUndefined();
  });

  it("rejects non-array findRoute result", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    (Game.map as any) = {} as GameMap;
    Game.map.describeExits = jest.fn(() => ({ "1": "W1N0" }));
    (Game.map as any).findRoute = jest.fn(() => "unexpected_string" as any);
    (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "normal" }));

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("ignores diagonal room not present in cardinal describeExits", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const diagonalRoom = createVisibleTargetRoom("W2N0", {
      sources: [createSource("src1"), createSource("src2")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W2N0"] = diagonalRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "3": "W2N1" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W2N0"]).toBeUndefined();
  });
});

describe("runRemoteMining scan cadence", () => {
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

  it("skips scan before scanInterval elapses", () => {
    Memory.runtime = { remoteMining: { lastScanAt: 80 } };
    Game.time = 90;

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);
    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(Object.keys(store)).toHaveLength(0);
    expect(Memory.runtime.remoteMining?.lastScanAt).toBe(80);
  });

  it("allows scan after scanInterval elapses", () => {
    Memory.runtime = { remoteMining: { lastScanAt: 49 } };
    Game.time = 100;

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);
    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeDefined();
    expect(Memory.runtime.remoteMining?.lastScanAt).toBe(100);
  });

  it("allows scan when lastScanAt is undefined", () => {
    Memory.runtime = { remoteMining: {} };
    Game.time = 100;

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);
    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeDefined();
  });

  it("allows scan when lastScanAt is in the future (tick rollback safety)", () => {
    Memory.runtime = { remoteMining: { lastScanAt: 200 } };
    Game.time = 100;

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);
    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeDefined();
  });
});

describe("runRemoteMining rejects rooms", () => {
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

  it("rejects visible room with one source", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("rejects visible room with three sources", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2"), createSource("src3")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("rejects visible room with hostile creeps", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostileCreep = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      hostileCreeps: [hostileCreep],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("allows visible room with harmless claim/move-only hostile creep", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const harmlessCreep = {
      id: "hc1",
      getActiveBodyparts: () => 0,
      body: [],
    } as unknown as Creep;
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      hostileCreeps: [harmlessCreep],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeDefined();
    expect(store["W1N0"]!.status).toBe("active");
  });

  it("rejects visible room with hostile-owned structures (excluding controller)", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostileStructure = {
      id: "hs1",
      structureType: STRUCTURE_EXTENSION,
    } as unknown as Structure;
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      hostileStructures: [hostileStructure],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("rejects visible room with non-my controller owner", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      controllerOwner: "enemy",
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("rejects visible room with non-my reservation", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      reservationUsername: "enemy",
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("rejects visible room with keeper lair (SK indicator)", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const keeperLair = {
      id: "kl1",
      structureType: STRUCTURE_KEEPER_LAIR,
    } as unknown as Structure;
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      keeperLairs: [keeperLair],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeUndefined();
  });

  it("allows visible room with my own reservation", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      reservationUsername: "me",
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeDefined();
    expect(store["W1N0"]!.status).toBe("active");
  });
});

describe("scout discovers and promotes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = Memory.data ?? {};
  });

  it("creates scouting task and scout config for invisible room", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const store = ensureRemoteMiningStore();
    expect(store["W1N0"]).toBeDefined();
    expect(store["W1N0"].status).toBe("scouting");

    const configName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![configName]).toBeDefined();
    expect(Memory.data!.creepConfigs![configName].role).toBe("scout");
    expect(Memory.data!.creepConfigs![configName].args).toEqual(["W1N0"]);
    expect(Memory.data!.creepConfigs![configName].roomName).toBe("W1N1");
  });

  it("promotes to active when room becomes visible with two sources", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    const store = ensureRemoteMiningStore();
    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 50,
      updatedAt: 50,
    };

    upsertScoutConfig("W1N1", "W1N0");

    Game.rooms["W1N0"] = targetRoom;

    runRemoteMining();

    expect(store["W1N0"].status).toBe("active");
    expect(store["W1N0"].sourceIds).toEqual(["src1", "src2"]);
    expect(store["W1N0"].lastVerifiedAt).toBe(100);
    expect(store["W1N0"].updatedAt).toBe(100);

    const configName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![configName]).toBeUndefined();
  });

  it("abandons when visible room has only one source", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    const store = ensureRemoteMiningStore();
    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 50,
      updatedAt: 50,
    };

    upsertScoutConfig("W1N1", "W1N0");

    runRemoteMining();

    expect(store["W1N0"].status).toBe("abandoned");
    expect(store["W1N0"].abandonedReason).toBe("not_dual_source");
    expect(store["W1N0"].nextRetryAt).toBe(100 + 5000);

    const configName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![configName]).toBeUndefined();
  });

  it("processes scout lifecycle even when scan cadence prevents new scans", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    Memory.runtime = { remoteMining: { lastScanAt: 90 } };
    Game.time = 95;

    const store = ensureRemoteMiningStore();
    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 50,
      updatedAt: 50,
    };

    runRemoteMining();

    expect(store["W1N0"].status).toBe("active");
    expect(store["W1N0"].sourceIds).toEqual(["src1", "src2"]);
    expect(Memory.runtime.remoteMining!.lastScanAt).toBe(90);
  });
});

describe("scout timeout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = Memory.data ?? {};
  });

  it("abandons task when scout exceeds timeout", () => {
    Game.time = 2000;

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    const store = ensureRemoteMiningStore();
    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 100,
      updatedAt: 100,
    };

    upsertScoutConfig("W1N1", "W1N0");

    runRemoteMining();

    expect(store["W1N0"].status).toBe("abandoned");
    expect(store["W1N0"].abandonedReason).toBe("scout_timeout");
    expect(store["W1N0"].nextRetryAt).toBe(2000 + 5000);
  });

  it("removes scout config when no live creeps reference it", () => {
    Game.time = 2000;

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    const store = ensureRemoteMiningStore();
    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 100,
      updatedAt: 100,
    };

    upsertScoutConfig("W1N1", "W1N0");
    const configName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![configName]).toBeDefined();

    runRemoteMining();

    expect(Memory.data!.creepConfigs![configName]).toBeUndefined();
  });

  it("orphans scout config when live creeps still reference it", () => {
    Game.time = 2000;

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    const configName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    const liveCreep = {
      memory: { configName, role: "scout" },
      room: { name: "W1N0" },
    } as unknown as Creep;
    Game.creeps["scout_1"] = liveCreep;

    setupGameMap({ W1N1: { "1": "W1N0" } });

    const store = ensureRemoteMiningStore();
    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 100,
      updatedAt: 100,
    };

    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![configName].roomName).toBe("W1N1");

    runRemoteMining();

    expect(store["W1N0"].status).toBe("abandoned");
    expect(store["W1N0"].abandonedReason).toBe("scout_timeout");
    expect(Memory.data!.creepConfigs![configName]).toBeDefined();
    expect(Memory.data!.creepConfigs![configName].roomName).toBeUndefined();
  });

  it("clears scout from spawn queue on timeout", () => {
    Game.time = 2000;

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    const spawn = createSpawn(rcl7Room);
    Game.spawns["Spawn1"] = spawn;

    const configName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    spawn.memory.spawnList = [configName, "W1N1:worker:0"];

    setupGameMap({ W1N1: { "1": "W1N0" } });

    const store = ensureRemoteMiningStore();
    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 100,
      updatedAt: 100,
    };

    upsertScoutConfig("W1N1", "W1N0");

    runRemoteMining();

    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });

  it("does not timeout within scoutTimeout window", () => {
    Game.time = 200;

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    const store = ensureRemoteMiningStore();
    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 100,
      updatedAt: 100,
    };

    upsertScoutConfig("W1N1", "W1N0");

    runRemoteMining();

    expect(store["W1N0"].status).toBe("scouting");
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

function createConRoom(name: string, options: { level?: number; storage?: StructureStorage } = {}): MockConRoom {
  const structures: Array<Structure<StructureConstant>> = [];
  const sites: Array<ConstructionSite> = [];
  const siteAttempts: Array<{ x: number; y: number; structureType: BuildableStructureConstant }> = [];

  const room = {
    name,
    controller: {
      my: true,
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

  it("respects maxRemoteSitesPerRun=2 cap", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10), createConSource("src2", targetRoom, 35, 35)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path1 = makePathPositions(25, 25, "W1N1", 10, 10, "W1N0");
    const path2 = makePathPositions(25, 25, "W1N1", 35, 35, "W1N0");
    (PathFinder.search as jest.Mock)
      .mockReturnValueOnce({ path: path1, incomplete: false, ops: 10, cost: 10 })
      .mockReturnValueOnce({ path: path2, incomplete: false, ops: 10, cost: 10 });

    setupActiveTask(store, "W1N1", "W1N0", ["src1", "src2"]);
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      if (id === "src2") return createConSource("src2", targetRoom, 35, 35);
      return null;
    });

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(targetRoom.__siteAttempts.length).toBeLessThanOrEqual(2);
    expect(targetRoom.__siteAttempts.every(a => a.structureType === STRUCTURE_ROAD || a.structureType === STRUCTURE_CONTAINER)).toBe(true);
  });

  it("respects global soft cap of 95 construction sites", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path = makePathPositions(25, 25, "W1N1", 10, 10, "W1N0");
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      return null;
    });

    for (let i = 0; i < 95; i++) {
      (Game.constructionSites as Record<string, ConstructionSite>)[`site_${i}`] = { id: `site_${i}` } as ConstructionSite;
    }

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(targetRoom.__siteAttempts.length).toBe(0);
  });

  it("rejects incomplete PathFinder paths without storing plan", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    (PathFinder.search as jest.Mock).mockReturnValue({ path: [], incomplete: true, ops: 100, cost: 0 });

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      return null;
    });

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(task.roadPlan).toBeUndefined();
    expect(targetRoom.__siteAttempts.length).toBe(0);
  });

  it("skips construction when roomPlannerBuild.enabled is false", () => {
    Memory.cfg = { roomPlannerBuild: { enabled: false } };

    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    setupActiveTask(store, "W1N1", "W1N0", ["src1"]);

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(targetRoom.__siteAttempts.length).toBe(0);
    expect(PathFinder.search as jest.Mock).not.toHaveBeenCalled();
  });

  it("skips duplicate road sites over existing roads", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path = makePathPositions(25, 25, "W1N1", 10, 10, "W1N0");
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName })),
      generatedAt: Game.time,
    };

    const firstPathPos = path[0];
    targetRoom.__structures.push({
      structureType: STRUCTURE_ROAD,
      pos: new ConMockRoomPosition(firstPathPos.x, firstPathPos.y, firstPathPos.roomName),
    } as unknown as Structure<StructureConstant>);

    (Game.getObjectById as jest.Mock) = jest.fn();

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    const roadAttempts = targetRoom.__siteAttempts.filter(a => a.structureType === STRUCTURE_ROAD);
    for (const attempt of roadAttempts) {
      expect(attempt.x !== firstPathPos.x || attempt.y !== firstPathPos.y || attempt.structureType !== STRUCTURE_ROAD).toBe(true);
    }
  });

  it("skips duplicate container site when container already exists", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path = makePathPositions(25, 25, "W1N1", 10, 10, "W1N0");
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName })),
      generatedAt: Game.time,
    };
    task.containerPositions = { src1: { x: 11, y: 10, roomName: "W1N0" } };

    targetRoom.__structures.push({
      structureType: STRUCTURE_CONTAINER,
      pos: new ConMockRoomPosition(11, 10, "W1N0"),
    } as unknown as Structure<StructureConstant>);

    (Game.getObjectById as jest.Mock) = jest.fn();

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    const containerAttempts = targetRoom.__siteAttempts.filter(a => a.structureType === STRUCTURE_CONTAINER);
    expect(containerAttempts.length).toBe(0);
  });

  it("only places sites in visible rooms", () => {
    const sourceRoom = createConRoom("W1N1");
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: [
        { x: 25, y: 25, roomName: "W1N1" },
        { x: 1, y: 25, roomName: "W1N0" },
      ],
      generatedAt: Game.time,
    };

    (Game.getObjectById as jest.Mock) = jest.fn();

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(sourceRoom.__siteAttempts.length).toBe(0);

    const invisibleRoomSites = Object.values(Game.constructionSites as Record<string, ConstructionSite>)
      .filter(s => s.pos && (s.pos as any).roomName === "W1N0");
    expect(invisibleRoomSites.length).toBe(0);
  });

  it("places remote roads only in the target room", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path = makePathPositions(25, 25, "W1N1", 10, 10, "W1N0");
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      return null;
    });

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(sourceRoom.__siteAttempts.length).toBe(0);
    expect(targetRoom.__siteAttempts.length).toBeGreaterThan(0);
    expect(targetRoom.__siteAttempts.every(a => a.structureType === STRUCTURE_ROAD || a.structureType === STRUCTURE_CONTAINER)).toBe(true);
  });

  it("does not replan road before roadInterval elapses", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: [{ x: 1, y: 1, roomName: "W1N0" }],
      generatedAt: Game.time,
    };

    (Game.getObjectById as jest.Mock) = jest.fn();

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(PathFinder.search as jest.Mock).not.toHaveBeenCalled();
  });

  it("replans road after roadInterval elapses", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path = makePathPositions(25, 25, "W1N1", 10, 10, "W1N0");
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: [{ x: 1, y: 1, roomName: "W1N0" }],
      generatedAt: Game.time - 101,
    };

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      return null;
    });

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(PathFinder.search as jest.Mock).toHaveBeenCalled();
  });

  it("skips construction for non-active tasks", () => {
    const sourceRoom = createConRoom("W1N1");
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.status = "scouting";

    (Game.getObjectById as jest.Mock) = jest.fn();

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(PathFinder.search as jest.Mock).not.toHaveBeenCalled();
  });

  it("rejects container position with blocking structure, falls back to another tile", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path: RoomPosition[] = [
      new ConMockRoomPosition(25, 25, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(11, 10, "W1N0") as unknown as RoomPosition,
      new ConMockRoomPosition(10, 10, "W1N0") as unknown as RoomPosition,
    ];
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    const blockedTile = { x: 11, y: 10 };
    targetRoom.__structures.push({
      structureType: STRUCTURE_EXTENSION,
      pos: new ConMockRoomPosition(blockedTile.x, blockedTile.y, "W1N0"),
    } as unknown as Structure<StructureConstant>);

    setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      return null;
    });

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    const containerAttempts = targetRoom.__siteAttempts.filter(a => a.structureType === STRUCTURE_CONTAINER);
    expect(containerAttempts.length).toBeGreaterThanOrEqual(1);
    const placed = containerAttempts[0];
    expect(placed.x === blockedTile.x && placed.y === blockedTile.y).toBe(false);
  });

  it("places container site instead of road on container tile", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path: RoomPosition[] = [
      new ConMockRoomPosition(25, 25, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(11, 10, "W1N0") as unknown as RoomPosition,
    ];
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName })),
      generatedAt: Game.time,
    };
    const containerTile = { x: 11, y: 10, roomName: "W1N0" };
    task.containerPositions = { src1: containerTile };

    (Game.getObjectById as jest.Mock) = jest.fn();

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    const roadOnContainerTile = [...sourceRoom.__siteAttempts, ...targetRoom.__siteAttempts].filter(
      a => a.structureType === STRUCTURE_ROAD && a.x === containerTile.x && a.y === containerTile.y,
    );
    expect(roadOnContainerTile.length).toBe(0);

    const containerOnTile = targetRoom.__siteAttempts.filter(
      a => a.structureType === STRUCTURE_CONTAINER && a.x === containerTile.x && a.y === containerTile.y,
    );
    expect(containerOnTile.length).toBe(1);
  });

  it("prioritizes container site over road sites when cap is 1", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path: RoomPosition[] = [
      new ConMockRoomPosition(25, 25, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(20, 20, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(11, 10, "W1N0") as unknown as RoomPosition,
      new ConMockRoomPosition(10, 10, "W1N0") as unknown as RoomPosition,
    ];
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName })),
      generatedAt: Game.time,
    };
    const containerTile = { x: 11, y: 10, roomName: "W1N0" };
    task.containerPositions = { src1: containerTile };

    (Game.getObjectById as jest.Mock) = jest.fn();

    const config = { ...getRemoteMiningConfig(), maxRemoteSitesPerRun: 1 };
    processRemoteConstruction(store, config);

    const allAttempts = [...sourceRoom.__siteAttempts, ...targetRoom.__siteAttempts];
    expect(allAttempts.length).toBe(1);
    expect(allAttempts[0].structureType).toBe(STRUCTURE_CONTAINER);
  });

  it("reuses shared corridor between two source paths and deduplicates road positions", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
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

  it("prefers existing target-room roads in path planning", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");

    // Place an existing road at (25, 20) in the target room
    const existingRoadPos = new ConMockRoomPosition(25, 20, "W1N0");
    targetRoom.__structures.push({
      structureType: STRUCTURE_ROAD,
      pos: existingRoadPos,
    } as unknown as Structure<StructureConstant>);

    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      if (type === FIND_STRUCTURES) return targetRoom.__structures;
      if (type === FIND_CONSTRUCTION_SITES) return targetRoom.__sites;
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path: RoomPosition[] = [
      new ConMockRoomPosition(25, 25, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(25, 20, "W1N0") as unknown as RoomPosition,
      new ConMockRoomPosition(9, 10, "W1N0") as unknown as RoomPosition,
    ];
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      return null;
    });

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    // PathFinder.search was called with roomCallback that has the existing road cheap
    const searchCalls = (PathFinder.search as jest.Mock).mock.calls;
    expect(searchCalls.length).toBeGreaterThanOrEqual(1);
    const options = searchCalls[0][2];
    expect(options.roomCallback).toBeDefined();
    const cm = options.roomCallback("W1N0");
    expect(cm.get(25, 20)).toBe(1);
    const sourceCm = options.roomCallback("W1N1");
    expect(sourceCm).not.toBe(false);
  });

  it("skips container site when my container construction site already exists near source (different position)", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      if (type === FIND_STRUCTURES) return targetRoom.__structures;
      if (type === FIND_CONSTRUCTION_SITES) return targetRoom.__sites;
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path: RoomPosition[] = [
      new ConMockRoomPosition(25, 25, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(11, 10, "W1N0") as unknown as RoomPosition,
    ];
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName })),
      generatedAt: Game.time,
    };

    // Plan wants container at (11,10) but there's already a my container site at (9,10) near source
    task.containerPositions = { src1: { x: 11, y: 10, roomName: "W1N0" } };

    targetRoom.__sites.push({
      id: "existingContainerSite",
      pos: new ConMockRoomPosition(9, 10, "W1N0"),
      structureType: STRUCTURE_CONTAINER,
      my: true,
    } as unknown as ConstructionSite);

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      return null;
    });

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    const containerAttempts = targetRoom.__siteAttempts.filter(a => a.structureType === STRUCTURE_CONTAINER);
    expect(containerAttempts.length).toBe(0);
  });

  it("skips container site when built container already exists near source (different position)", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      if (type === FIND_STRUCTURES) return targetRoom.__structures;
      if (type === FIND_CONSTRUCTION_SITES) return targetRoom.__sites;
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path: RoomPosition[] = [
      new ConMockRoomPosition(25, 25, "W1N1") as unknown as RoomPosition,
      new ConMockRoomPosition(11, 10, "W1N0") as unknown as RoomPosition,
    ];
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName })),
      generatedAt: Game.time,
    };
    task.containerPositions = { src1: { x: 11, y: 10, roomName: "W1N0" } };

    // Built container at (9,10) near source at (10,10) — within range 2
    targetRoom.__structures.push({
      structureType: STRUCTURE_CONTAINER,
      pos: new ConMockRoomPosition(9, 10, "W1N0"),
    } as unknown as Structure<StructureConstant>);

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      return null;
    });

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    const containerAttempts = targetRoom.__siteAttempts.filter(a => a.structureType === STRUCTURE_CONTAINER);
    expect(containerAttempts.length).toBe(0);
  });

  it("creates exactly one container site per source when no existing container or site exists", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_STRUCTURES) return targetRoom.__structures;
      if (type === FIND_CONSTRUCTION_SITES) return targetRoom.__sites;
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1", "src2"]);
    task.roadPlan = {
      positions: [{ x: 11, y: 10, roomName: "W1N0" }, { x: 34, y: 35, roomName: "W1N0" }],
      generatedAt: Game.time,
    };
    task.containerPositions = {
      src1: { x: 11, y: 10, roomName: "W1N0" },
      src2: { x: 34, y: 35, roomName: "W1N0" },
    };

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      if (id === "src2") return createConSource("src2", targetRoom, 35, 35);
      return null;
    });

    const config = { ...getRemoteMiningConfig(), maxRemoteSitesPerRun: 5 };
    processRemoteConstruction(store, config);

    const containerAttempts = targetRoom.__siteAttempts.filter(a => a.structureType === STRUCTURE_CONTAINER);
    expect(containerAttempts.length).toBe(2);
    expect(containerAttempts.some(a => a.x === 11 && a.y === 10)).toBe(true);
    expect(containerAttempts.some(a => a.x === 34 && a.y === 35)).toBe(true);
  });

  it("places container for second source when first source container is within range 2 of both sources", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_STRUCTURES) return targetRoom.__structures;
      if (type === FIND_CONSTRUCTION_SITES) return targetRoom.__sites;
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    // Two sources close together (mirrors E1N56: sources at (5,31) and (6,32))
    // src1 at (10,10), src2 at (11,11) — distance 1 diagonal
    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1", "src2"]);
    task.roadPlan = {
      positions: [{ x: 9, y: 10, roomName: "W1N0" }, { x: 12, y: 11, roomName: "W1N0" }],
      generatedAt: Game.time,
    };
    task.containerPositions = {
      src1: { x: 9, y: 10, roomName: "W1N0" },
      src2: { x: 12, y: 11, roomName: "W1N0" },
    };

    // Built container at src1's planned position (9,10)
    // Distance from (9,10) to src2 at (11,11): |9-11|=2, |10-11|=1 → within range 2
    targetRoom.__structures.push({
      structureType: STRUCTURE_CONTAINER,
      pos: new ConMockRoomPosition(9, 10, "W1N0"),
    } as unknown as Structure<StructureConstant>);

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      if (id === "src2") return createConSource("src2", targetRoom, 11, 11);
      return null;
    });

    const config = { ...getRemoteMiningConfig(), maxRemoteSitesPerRun: 5 };
    processRemoteConstruction(store, config);

    const containerAttempts = targetRoom.__siteAttempts.filter(a => a.structureType === STRUCTURE_CONTAINER);
    // src1 skipped (built container at its planned position), src2 should get a new site
    expect(containerAttempts.length).toBe(1);
    expect(containerAttempts[0].x).toBe(12);
    expect(containerAttempts[0].y).toBe(11);
  });

  it("does not place container for second source when an unassigned container site near that source exists", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_STRUCTURES) return targetRoom.__structures;
      if (type === FIND_CONSTRUCTION_SITES) return targetRoom.__sites;
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1", "src2"]);
    task.roadPlan = {
      positions: [{ x: 9, y: 10, roomName: "W1N0" }, { x: 12, y: 11, roomName: "W1N0" }],
      generatedAt: Game.time,
    };
    task.containerPositions = {
      src1: { x: 9, y: 10, roomName: "W1N0" },
      src2: { x: 12, y: 11, roomName: "W1N0" },
    };

    // Built container at src1's planned position
    targetRoom.__structures.push({
      structureType: STRUCTURE_CONTAINER,
      pos: new ConMockRoomPosition(9, 10, "W1N0"),
    } as unknown as Structure<StructureConstant>);

    // Stale my container site near src2 at a different position than planned
    targetRoom.__sites.push({
      id: "staleContainerSite",
      pos: new ConMockRoomPosition(10, 12, "W1N0"),
      structureType: STRUCTURE_CONTAINER,
      my: true,
    } as unknown as ConstructionSite);

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      if (id === "src2") return createConSource("src2", targetRoom, 11, 11);
      return null;
    });

    const config = { ...getRemoteMiningConfig(), maxRemoteSitesPerRun: 5 };
    processRemoteConstruction(store, config);

    const containerAttempts = targetRoom.__siteAttempts.filter(a => a.structureType === STRUCTURE_CONTAINER);
    // src2 should be skipped because the stale site at (10,12) is near src2 and is not at src1's planned position
    expect(containerAttempts.length).toBe(0);
  });
});

// ─── Config lifecycle tests ──────────────────────────────────────

function ensureConfigStore(): Record<string, import("@/types/system").CreepConfig> {
  Memory.data = Memory.data ?? {};
  Memory.data.creepConfigs = Memory.data.creepConfigs ?? {};
  return Memory.data.creepConfigs;
}

describe("creates remote configs", () => {
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

  it("creates two colonizerHarvester configs and two carrier configs for dual-source active task", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      updatedAt: 100,
    };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    const configs = Memory.data!.creepConfigs!;
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    const h2 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src2");
    expect(configs[h1]).toEqual({ role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" });
    expect(configs[h2]).toEqual({ role: "colonizerHarvester", args: ["W1N0", "src2"], roomName: "W1N1" });

    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    expect(configs[c0]).toBeDefined();
    expect(configs[c0].role).toBe("remoteMiningCarrier");
    expect(configs[c0].args).toEqual(["W1N0", "src1"]);
    expect(configs[c0].roomName).toBe("W1N1");

    const c1 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 1);
    expect(configs[c1]).toBeDefined();
    expect(configs[c1].role).toBe("remoteMiningCarrier");
    expect(configs[c1].args).toEqual(["W1N0", "src2"]);
    expect(configs[c1].roomName).toBe("W1N1");

    const c2 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 2);
    expect(configs[c2]).toBeUndefined();
  });

  it("carrier config has args [targetRoom, sourceId] per source", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      updatedAt: 100,
    };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    const configs = Memory.data!.creepConfigs!;
    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    const c1 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 1);

    expect(configs[c0].args).toEqual(["W1N0", "src1"]);
    expect(configs[c1].args).toEqual(["W1N0", "src2"]);
  });

  it("uses roomName=sourceRoom, never targetRoom", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 100,
      updatedAt: 100,
    };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    const configs = Memory.data!.creepConfigs!;
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    expect(configs[h1].roomName).toBe("W1N1");

    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    expect(configs[c0].roomName).toBe("W1N1");
  });

  it("is idempotent: repeated calls do not duplicate or unnecessarily rewrite configs", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 100,
      updatedAt: 100,
    };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    const configsBefore = { ...Memory.data!.creepConfigs };
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    const configRefBefore = Memory.data!.creepConfigs![h1];

    processRemoteConfigLifecycle(store, config);

    expect(Memory.data!.creepConfigs![h1]).toBe(configRefBefore);
    const configsAfter = { ...Memory.data!.creepConfigs };
    expect(Object.keys(configsBefore).sort()).toEqual(Object.keys(configsAfter).sort());
  });

  it("does not create harvester/carrier configs for scouting tasks", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 100,
      updatedAt: 100,
    };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    const configs = Memory.data!.creepConfigs ?? {};
    for (const key of Object.keys(configs)) {
      expect(key).not.toContain(":harvester:");
      expect(key).not.toContain(":carrier:");
    }
  });

  it("runs config lifecycle even when scan cadence prevents new scans", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    Memory.runtime = { remoteMining: { lastScanAt: 90 } };
    Game.time = 95;

    const existingStore = ensureRemoteMiningStore();
    existingStore["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 50,
    };

    runRemoteMining();

    const configs = Memory.data!.creepConfigs!;
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    expect(configs[h1]).toBeDefined();
    expect(configs[h1].role).toBe("colonizerHarvester");
    expect(Memory.runtime.remoteMining!.lastScanAt).toBe(90);
  });
});

describe("downgrade cleanup", () => {
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

  it("cleans up configs when source room RCL drops below 7", () => {
    const rcl6Room = createRclRoom("W1N1", 6);
    Game.rooms["W1N1"] = rcl6Room;
    Game.spawns["Spawn1"] = createSpawn(rcl6Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const configs = ensureConfigStore();
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    configs[h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };
    configs[c0] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(configs[h1]).toBeUndefined();
    expect(configs[c0]).toBeUndefined();
  });

  it("orphans configs with live creeps instead of deleting them", () => {
    const rcl6Room = createRclRoom("W1N1", 6);
    Game.rooms["W1N1"] = rcl6Room;
    Game.spawns["Spawn1"] = createSpawn(rcl6Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    Memory.data!.creepConfigs![h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };

    const liveCreep = {
      memory: { configName: h1, role: "colonizerHarvester" },
      room: { name: "W1N0" },
    } as unknown as Creep;
    Game.creeps["harvester_1"] = liveCreep;

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(Memory.data!.creepConfigs![h1]).toBeDefined();
    expect(Memory.data!.creepConfigs![h1].roomName).toBeUndefined();
  });

  it("removes configs from spawn queues on cleanup", () => {
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
    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    spawn.memory.spawnList = [h1, c0, "W1N1:worker:0"];

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });

  it("cleans up configs for abandoned tasks", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "abandoned",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 50,
      abandonedReason: "not_dual_source",
    };

    const configs = ensureConfigStore();
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    configs[h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(configs[h1]).toBeUndefined();
  });

  it("cleans up configs when source room is missing", () => {
    Game.rooms = {};
    Game.spawns = {};

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    Memory.data!.creepConfigs![h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(Memory.data!.creepConfigs![h1]).toBeUndefined();
  });

  it("cleans up configs when source room controller is not mine", () => {
    Memory.rooms["W1N1"] = {} as RoomMemory;
    const notMyRoom = {
      name: "W1N1",
      memory: Memory.rooms["W1N1"],
      controller: { my: false, level: 7 } as unknown as StructureController,
      find: jest.fn(() => []),
    } as unknown as Room;
    Game.rooms["W1N1"] = notMyRoom;
    Game.spawns["Spawn1"] = createSpawn(notMyRoom);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    Memory.data!.creepConfigs![h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(Memory.data!.creepConfigs![h1]).toBeUndefined();
  });
});

describe("defense mode cleanup", () => {
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

  it("cleans up configs when source room is in defense_mode", () => {
    const mod = require("@/runtime/defenseMode");
    jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    Memory.data!.creepConfigs![h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };
    Memory.data!.creepConfigs![c0] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(Memory.data!.creepConfigs![h1]).toBeUndefined();
    expect(Memory.data!.creepConfigs![c0]).toBeUndefined();

    (mod.isDefenseMode as jest.Mock).mockRestore();
  });
});

describe("visible unsafe remote suspension cleanup", () => {
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

  it("suspends active task when visible remote becomes unsafe with hostile creeps", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostileCreep = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const unsafeTarget = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      hostileCreeps: [hostileCreep],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = unsafeTarget;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    Memory.data!.creepConfigs![h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };
    Memory.data!.creepConfigs![c0] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(store["W1N0"].status).toBe("suspended");
    expect(store["W1N0"].suspendReason).toBe("hostile_creeps");
    expect(store["W1N0"].suspendedAt).toBe(100);
    expect(store["W1N0"].lastThreatAt).toBe(100);
    expect(store["W1N0"].updatedAt).toBe(100);
    expect(Memory.data!.creepConfigs![h1]).toBeUndefined();
    expect(Memory.data!.creepConfigs![c0]).toBeUndefined();
  });

  it("suspends active task when visible remote has hostile owner", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const unsafeTarget = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      controllerOwner: "enemy",
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = unsafeTarget;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    Memory.data!.creepConfigs![h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(store["W1N0"].status).toBe("suspended");
    expect(store["W1N0"].suspendReason).toBe("hostile_owner");
    expect(store["W1N0"].lastThreatAt).toBe(100);
    expect(Memory.data!.creepConfigs![h1]).toBeUndefined();
  });

  it("does not suspend when target room is not visible", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(store["W1N0"].status).toBe("active");
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    expect(Memory.data!.creepConfigs![h1]).toBeDefined();
  });

  it("cleans up configs for already-suspended tasks", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "suspended",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 80,
      suspendReason: "hostile_creeps",
      suspendedAt: 80,
    };

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    Memory.data!.creepConfigs![h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };
    Memory.data!.creepConfigs![c0] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(Memory.data!.creepConfigs![h1]).toBeUndefined();
    expect(Memory.data!.creepConfigs![c0]).toBeUndefined();
  });
});

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

  it("cleans up stale carrier indexes from previous multi-carrier generation", () => {
    const rcl6Room = createRclRoom("W1N1", 6);
    Game.rooms["W1N1"] = rcl6Room;
    Game.spawns["Spawn1"] = createSpawn(rcl6Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const configs = ensureConfigStore();
    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    const c1 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 1);
    const c2 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 2);
    const c3 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 3);
    configs[c0] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };
    configs[c1] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };
    configs[c2] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };
    configs[c3] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(configs[c0]).toBeUndefined();
    expect(configs[c1]).toBeUndefined();
    expect(configs[c2]).toBeUndefined();
    expect(configs[c3]).toBeUndefined();
  });

  it("cleans up stale harvester configs from changed sourceIds", () => {
    const rcl6Room = createRclRoom("W1N1", 6);
    Game.rooms["W1N1"] = rcl6Room;
    Game.spawns["Spawn1"] = createSpawn(rcl6Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const configs = ensureConfigStore();
    const oldHarvester = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "oldSrc99");
    configs[oldHarvester] = { role: "colonizerHarvester", args: ["W1N0", "oldSrc99"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(configs[oldHarvester]).toBeUndefined();
  });

  it("preserves scout config during harvester/carrier cleanup", () => {
    const rcl6Room = createRclRoom("W1N1", 6);
    Game.rooms["W1N1"] = rcl6Room;
    Game.spawns["Spawn1"] = createSpawn(rcl6Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const configs = ensureConfigStore();
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    configs[scoutName] = { role: "scout", args: ["W1N0"], roomName: "W1N1" };
    configs[h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);

    expect(configs[scoutName]).toEqual({ role: "scout", args: ["W1N0"], roomName: "W1N1" });
    expect(configs[h1]).toBeUndefined();
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

    expect(spawn.memory.spawnList).toEqual([scoutName, "W1N1:worker:0"]);
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

  it("orphans stale carrier config when live creep still references it", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const configs = ensureConfigStore();
    const c1 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 1);
    configs[c1] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };

    const liveCreep = {
      memory: { configName: c1, role: "remoteMiningCarrier" },
      room: { name: "W1N0" },
    } as unknown as Creep;
    Game.creeps["carrier_stale"] = liveCreep;

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(configs[c1]).toBeDefined();
    expect(configs[c1].roomName).toBeUndefined();
  });

  it("removes stale carrier:1+ from spawn queues while keeping valid carriers queued", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    const spawn = createSpawn(rcl7Room);
    Game.spawns["Spawn1"] = spawn;

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
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

    spawn.memory.spawnList = [c0, c1, c2, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(spawn.memory.spawnList).toEqual([c0, "W1N1:worker:0"]);
  });

  it("preserves harvester and reserver configs during carrier reconciliation", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const configs = ensureConfigStore();
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    const c1 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 1);
    const r0 = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    configs[h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };
    configs[c1] = { role: "remoteMiningCarrier", args: ["W1N0", "src1"], roomName: "W1N1" };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(configs[h1]).toBeDefined();
    expect(configs[h1].role).toBe("colonizerHarvester");
    expect(configs[r0]).toBeDefined();
    expect(configs[r0].role).toBe("remoteMiningReserver");
    expect(configs[c1]).toBeUndefined();
  });

  it("old carrier config with stale sourceId args is refreshed to match sourceIds order", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const configs = ensureConfigStore();
    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    configs[c0] = { role: "remoteMiningCarrier", args: ["W1N0", "oldSource"], roomName: "W1N1" };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(configs[c0]).toBeDefined();
    expect(configs[c0].args).toEqual(["W1N0", "src1"]);
  });
});

describe("suspends hostile remote with reason-specific threat detection", () => {
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

  it("suspends with hostile_creeps for ATTACK hostile", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 2 : 0,
    } as unknown as Creep;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].suspendReason).toBe("hostile_creeps");
  });

  it("suspends with hostile_creeps for RANGED_ATTACK hostile", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === RANGED_ATTACK ? 3 : 0,
    } as unknown as Creep;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].suspendReason).toBe("hostile_creeps");
  });

  it("suspends with hostile_creeps for HEAL hostile", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === HEAL ? 1 : 0,
    } as unknown as Creep;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].suspendReason).toBe("hostile_creeps");
  });

  it("does not suspend for WORK-only hostile (competition, not combat danger)", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === WORK ? 4 : 0,
    } as unknown as Creep;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].status).toBe("active");
    expect(store["W1N0"].suspendReason).toBeUndefined();
  });

  it("suspends with hostile_creeps using body array fallback when no getActiveBodyparts", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      body: [{ type: ATTACK, hits: 100 }],
    } as unknown as Creep;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].suspendReason).toBe("hostile_creeps");
  });

  it("does not suspend for harmless claim/move-only hostile", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const harmless = {
      id: "hc1",
      getActiveBodyparts: () => 0,
      body: [{ type: CLAIM, hits: 100 }, { type: MOVE, hits: 100 }],
    } as unknown as Creep;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [harmless],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].status).toBe("active");
  });

  it("suspends with hostile_reservation for non-my reservation", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      reservationUsername: "enemy",
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].suspendReason).toBe("hostile_reservation");
  });

  it("suspends with hostile_owner for non-my controller owner", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      controllerOwner: "enemy",
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].suspendReason).toBe("hostile_owner");
  });

  it("suspends with hostile_structures for hostile structures excluding controller", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostileStructure = {
      id: "hs1",
      structureType: STRUCTURE_EXTENSION,
    } as unknown as Structure;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileStructures: [hostileStructure],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].suspendReason).toBe("hostile_structures");
  });

  it("suspends with source_keeper for keeper lair", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const keeperLair = {
      id: "kl1",
      structureType: STRUCTURE_KEEPER_LAIR,
    } as unknown as Structure;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      keeperLairs: [keeperLair],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].suspendReason).toBe("source_keeper");
  });

  it("prioritizes hostile_owner over hostile_creeps", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      controllerOwner: "enemy",
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(store["W1N0"].suspendReason).toBe("hostile_owner");
  });

  it("does not create defender/warControl/homeDefense configs on suspend", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const configs = Memory.data!.creepConfigs!;
    for (const key of Object.keys(configs)) {
      expect(configs[key].role).not.toBe("homeDefender");
      expect(configs[key].role).not.toBe("meleeAttacker");
      expect(configs[key].role).not.toBe("healer");
    }
    expect(Memory.data!.war).toBeUndefined();
  });
});

describe("suspended remote resume after safe ticks", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
  });

  it("does not resume while still visibly dangerous", () => {
    Game.time = 200;
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "suspended",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 100,
      suspendReason: "hostile_creeps", suspendedAt: 100, lastThreatAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["W1N0"].status).toBe("suspended");
    expect(store["W1N0"].lastThreatAt).toBe(200);
    expect(store["W1N0"].safeSince).toBeUndefined();
  });

  it("starts safe tick tracking when room becomes visible and safe", () => {
    Game.time = 200;
    const rcl7Room = createRclRoom("W1N1", 7);
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "suspended",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 100,
      suspendReason: "hostile_creeps", suspendedAt: 100, lastThreatAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["W1N0"].status).toBe("suspended");
    expect(store["W1N0"].safeSince).toBe(200);
  });

  it("resumes after remoteSafeTicksToResume consecutive safe ticks", () => {
    Game.time = 300;
    const rcl7Room = createRclRoom("W1N1", 7);
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "suspended",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 100,
      suspendReason: "hostile_creeps", suspendedAt: 100, lastThreatAt: 100,
      safeSince: 200,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["W1N0"].status).toBe("active");
    expect(store["W1N0"].suspendReason).toBeUndefined();
    expect(store["W1N0"].suspendedAt).toBeUndefined();
    expect(store["W1N0"].lastThreatAt).toBeUndefined();
    expect(store["W1N0"].safeSince).toBeUndefined();
  });

  it("does not resume before remoteSafeTicksToResume elapsed", () => {
    Game.time = 250;
    const rcl7Room = createRclRoom("W1N1", 7);
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "suspended",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 100,
      suspendReason: "hostile_creeps", suspendedAt: 100, lastThreatAt: 100,
      safeSince: 200,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["W1N0"].status).toBe("suspended");
  });

  it("does not resume when target room is invisible", () => {
    Game.time = 300;
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "suspended",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 100,
      suspendReason: "hostile_creeps", suspendedAt: 100, lastThreatAt: 100,
      safeSince: 200,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["W1N0"].status).toBe("suspended");
  });

  it("resets safeSince when room becomes dangerous again after partial safe ticks", () => {
    Game.time = 250;
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "suspended",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 100,
      suspendReason: "hostile_creeps", suspendedAt: 100, lastThreatAt: 100,
      safeSince: 200,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["W1N0"].status).toBe("suspended");
    expect(store["W1N0"].safeSince).toBeUndefined();
    expect(store["W1N0"].lastThreatAt).toBe(250);
  });

  it("respects custom remoteSafeTicksToResume config", () => {
    Game.time = 200;
    const rcl7Room = createRclRoom("W1N1", 7);
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "suspended",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 100,
      suspendReason: "hostile_creeps", suspendedAt: 100, lastThreatAt: 100,
      safeSince: 140,
    };

    const config = { ...getRemoteMiningConfig(), remoteSafeTicksToResume: 50 };
    processRemoteConfigLifecycle(store, config);

    expect(store["W1N0"].status).toBe("active");
  });

  it("creates harvester/carrier configs after resume", () => {
    Game.time = 300;
    const rcl7Room = createRclRoom("W1N1", 7);
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = target;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "suspended",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 100,
      suspendReason: "hostile_creeps", suspendedAt: 100, lastThreatAt: 100,
      safeSince: 200,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["W1N0"].status).toBe("active");
    const configs = Memory.data!.creepConfigs!;
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    expect(configs[h1]).toBeDefined();
    expect(configs[h1].role).toBe("colonizerHarvester");
  });
});

// ─── Task 9: CPU/cadence regression hardening ────────────────────

describe("scan cadence hardening", () => {
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
  });

  it("does not call describeExits when scan cadence blocks new scanning", () => {
    const describeExitsSpy = jest.fn(() => ({ "1": "W1N0" }));
    (Game.map as any) = {} as GameMap;
    Game.map.describeExits = describeExitsSpy;
    (Game.map as any).findRoute = jest.fn((_from: string, to: string) => [{ room: to, exit: FIND_EXIT_TOP }]);
    (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "normal" }));

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    Memory.runtime = { remoteMining: { lastScanAt: 90 } };
    Game.time = 95;

    runRemoteMining();

    expect(describeExitsSpy).not.toHaveBeenCalled();
  });

  it("still processes existing scout lifecycle when scan is blocked", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    setupGameMap({ W1N1: { "1": "W1N0" } });

    Memory.runtime = { remoteMining: { lastScanAt: 90 } };
    Game.time = 95;

    const store = ensureRemoteMiningStore();
    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 50,
      updatedAt: 50,
    };
    upsertScoutConfig("W1N1", "W1N0");

    runRemoteMining();

    expect(store["W1N0"].status).toBe("active");
    expect(store["W1N0"].sourceIds).toEqual(["src1", "src2"]);
    expect(Memory.runtime.remoteMining!.lastScanAt).toBe(90);
  });
});

describe("road construction cadence hardening", () => {
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

  it("does not call PathFinder.search when cached roadPlan is fresh", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: [{ x: 1, y: 1, roomName: "W1N0" }],
      generatedAt: Game.time,
    };

    (Game.getObjectById as jest.Mock) = jest.fn();

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(PathFinder.search as jest.Mock).not.toHaveBeenCalled();
  });

  it("calls PathFinder.search when roadPlan is stale past roadInterval", () => {
    const sourceRoom = createConRoom("W1N1");
    const targetRoom = createConRoom("W1N0");
    targetRoom.find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) return [createConSource("src1", targetRoom, 10, 10)];
      return [];
    });
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;
    Game.rooms["W1N0"] = targetRoom as unknown as Room;

    const path = makePathPositions(25, 25, "W1N1", 10, 10, "W1N0");
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 10, cost: 10 });

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: [{ x: 1, y: 1, roomName: "W1N0" }],
      generatedAt: Game.time - 101,
    };

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src1") return createConSource("src1", targetRoom, 10, 10);
      return null;
    });

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(PathFinder.search as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it("places no site attempts when cached roadPlan has no visible rooms", () => {
    const sourceRoom = createConRoom("W1N1");
    Game.rooms["W1N1"] = sourceRoom as unknown as Room;

    const task = setupActiveTask(store, "W1N1", "W1N0", ["src1"]);
    task.roadPlan = {
      positions: [{ x: 5, y: 5, roomName: "W1N0" }],
      generatedAt: Game.time,
    };

    (Game.getObjectById as jest.Mock) = jest.fn();

    const config = getRemoteMiningConfig();
    processRemoteConstruction(store, config);

    expect(PathFinder.search as jest.Mock).not.toHaveBeenCalled();
    expect(sourceRoom.__siteAttempts.length).toBe(0);
  });
});

describe("defense recheck outside scan cadence", () => {
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

  it("suspends active remote when threat detected during scan-blocked tick", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    Memory.runtime = { remoteMining: { lastScanAt: 90 } };
    Game.time = 95;

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    Memory.data!.creepConfigs![h1] = { role: "colonizerHarvester", args: ["W1N0", "src1"], roomName: "W1N1" };

    runRemoteMining();

    expect(store["W1N0"].status).toBe("suspended");
    expect(store["W1N0"].suspendReason).toBe("hostile_creeps");
    expect(store["W1N0"].suspendedAt).toBe(95);
    expect(Memory.data!.creepConfigs![h1]).toBeUndefined();
    expect(Memory.runtime.remoteMining!.lastScanAt).toBe(90);
  });

  it("resumes suspended remote during scan-blocked tick when safe ticks elapsed", () => {
    Game.time = 300;
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    Memory.runtime = { remoteMining: { lastScanAt: 290 } };
    Game.time = 295;

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "suspended",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 100,
      suspendReason: "hostile_creeps", suspendedAt: 100, lastThreatAt: 100,
      safeSince: 195,
    };

    runRemoteMining();

    expect(store["W1N0"].status).toBe("active");
    expect(store["W1N0"].suspendReason).toBeUndefined();
    const configs = Memory.data!.creepConfigs!;
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    expect(configs[h1]).toBeDefined();
    expect(configs[h1].role).toBe("colonizerHarvester");
    expect(Memory.runtime.remoteMining!.lastScanAt).toBe(290);
  });

  it("config lifecycle is bounded to existing store tasks, no new rooms discovered during scan-blocked tick", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    const describeExitsSpy = jest.fn(() => ({ "1": "W1N0" }));
    (Game.map as any) = {} as GameMap;
    Game.map.describeExits = describeExitsSpy;
    (Game.map as any).findRoute = jest.fn((_from: string, to: string) => [{ room: to, exit: FIND_EXIT_TOP }]);
    (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "normal" }));

    Memory.runtime = { remoteMining: { lastScanAt: 90 } };
    Game.time = 95;

    store["W1N0"] = {
      sourceRoom: "W1N1", targetRoom: "W1N0", status: "active",
      sourceIds: ["src1"], assignedAt: 50, updatedAt: 50,
    };

    runRemoteMining();

    expect(describeExitsSpy).not.toHaveBeenCalled();
    const configs = Memory.data!.creepConfigs!;
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    expect(configs[h1]).toBeDefined();
    expect(configs[h1].role).toBe("colonizerHarvester");
    expect(Object.keys(store)).toHaveLength(1);
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

  it("creates one reserver config for active invisible remote", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      updatedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![reserverName]).toEqual({
      role: "remoteMiningReserver",
      args: ["W1N0"],
      roomName: "W1N1",
    });
  });

  it("creates one reserver config for unreserved visible active remote", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
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

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![reserverName]).toBeDefined();
    expect(Memory.data!.creepConfigs![reserverName].role).toBe("remoteMiningReserver");
  });

  it("creates reserver when self-reserved below renew threshold", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      reservationUsername: "me",
      reservationTicksToEnd: 2500,
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

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![reserverName]).toBeDefined();
    expect(Memory.data!.creepConfigs![reserverName].role).toBe("remoteMiningReserver");
  });

  it("does not create reserver when self-reserved at or above threshold", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      reservationUsername: "me",
      reservationTicksToEnd: 3500,
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

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![reserverName]).toBeUndefined();
  });

  it("does not create reserver when controller is owned by anyone", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      controllerOwner: "anyone",
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

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![reserverName]).toBeUndefined();
  });

  it("suspends and cleans up reserver on hostile reservation", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      reservationUsername: "enemy",
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

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["W1N0"].status).toBe("suspended");
    expect(store["W1N0"].suspendReason).toBe("hostile_reservation");
    expect(Memory.data!.creepConfigs![reserverName]).toBeUndefined();
  });

  it("does not create reserver for scouting tasks", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "scouting",
      sourceIds: [],
      assignedAt: 100,
      updatedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const configs = Memory.data!.creepConfigs ?? {};
    for (const key of Object.keys(configs)) {
      expect(key).not.toContain(":reserver:");
    }
  });

  it("cleans up reserver config on abandoned task", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "abandoned",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 50,
      abandonedReason: "not_dual_source",
    };

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![reserverName] = {
      role: "remoteMiningReserver",
      args: ["W1N0"],
      roomName: "W1N1",
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![reserverName]).toBeUndefined();
  });

  it("cleans up reserver config on suspended task", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "suspended",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 80,
      suspendReason: "hostile_creeps",
      suspendedAt: 80,
    };

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![reserverName] = {
      role: "remoteMiningReserver",
      args: ["W1N0"],
      roomName: "W1N1",
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![reserverName]).toBeUndefined();
  });

  it("removes reserver from spawn queue on cleanup", () => {
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

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    spawn.memory.spawnList = [reserverName, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });

  it("orphans reserver config when live creep still references it", () => {
    const rcl6Room = createRclRoom("W1N1", 6);
    Game.rooms["W1N1"] = rcl6Room;
    Game.spawns["Spawn1"] = createSpawn(rcl6Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 50,
    };

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![reserverName] = {
      role: "remoteMiningReserver",
      args: ["W1N0"],
      roomName: "W1N1",
    };

    const liveCreep = {
      memory: { configName: reserverName, role: "remoteMiningReserver" },
      room: { name: "W1N0" },
    } as unknown as Creep;
    Game.creeps["reserver_1"] = liveCreep;

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![reserverName]).toBeDefined();
    expect(Memory.data!.creepConfigs![reserverName].roomName).toBeUndefined();
  });

  it("does not create reserver when source room RCL drops below 7", () => {
    const rcl6Room = createRclRoom("W1N1", 6);
    Game.rooms["W1N1"] = rcl6Room;
    Game.spawns["Spawn1"] = createSpawn(rcl6Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 100,
      updatedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![reserverName]).toBeUndefined();
  });

  it("creates reserver config alongside harvester and carrier configs", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      updatedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const configs = Memory.data!.creepConfigs!;
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    const r0 = getRemoteMiningReserverConfigName("W1N1", "W1N0");

    expect(configs[h1]).toBeDefined();
    expect(configs[c0]).toBeDefined();
    expect(configs[r0]).toBeDefined();
    expect(configs[r0].role).toBe("remoteMiningReserver");
    expect(configs[r0].args).toEqual(["W1N0"]);
    expect(configs[r0].roomName).toBe("W1N1");
  });

  it("is idempotent: repeated lifecycle calls keep one reserver config", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 100,
      updatedAt: 100,
    };

    const config = getRemoteMiningConfig();
    processRemoteConfigLifecycle(store, config);
    processRemoteConfigLifecycle(store, config);

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    const matching = Object.keys(Memory.data!.creepConfigs!).filter(k => k.includes(":reserver:"));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toBe(reserverName);
  });

  it("respects custom remoteReservationRenewAt threshold", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      reservationUsername: "me",
      reservationTicksToEnd: 1500,
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

    const config = { ...getRemoteMiningConfig(), remoteReservationRenewAt: 1000 };
    processRemoteConfigLifecycle(store, config);

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![reserverName]).toBeUndefined();
  });

  it("does not create reserver when source room is in defense mode", () => {
    const mod = require("@/runtime/defenseMode");
    jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1"],
      assignedAt: 100,
      updatedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![reserverName]).toBeUndefined();

    (mod.isDefenseMode as jest.Mock).mockRestore();
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

  it("removes queued reserver spawn entry when self-reservation is above threshold", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      reservationUsername: "me",
      reservationTicksToEnd: 4000,
    });
    Game.rooms["W1N1"] = rcl7Room;
    const spawn = createSpawn(rcl7Room);
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = spawn;

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      updatedAt: 100,
    };

    const reserverName = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    spawn.memory.spawnList = [reserverName, h1, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(spawn.memory.spawnList).toEqual([h1, "W1N1:worker:0"]);
  });

describe("suspended scout recovery", () => {
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

  it("upserts spawnable scout config for suspended task with valid source room", () => {
    const rcl7Room = createRclRoom("E1N57", 7);
    Game.rooms["E1N57"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["E1N58"] = {
      sourceRoom: "E1N57",
      targetRoom: "E1N58",
      status: "suspended",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
      lastThreatAt: 100,
    };

    const scoutName = getRemoteMiningScoutConfigName("E1N57", "E1N58");
    Memory.data!.creepConfigs![scoutName] = { role: "scout", args: ["E1N58"] };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["E1N58"].status).toBe("suspended");
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();
    expect(Memory.data!.creepConfigs![scoutName].role).toBe("scout");
    expect(Memory.data!.creepConfigs![scoutName].args).toEqual(["E1N58"]);
    expect(Memory.data!.creepConfigs![scoutName].roomName).toBe("E1N57");
  });

  it("creates scout config from scratch for suspended task with no existing scout", () => {
    const rcl7Room = createRclRoom("E1N57", 7);
    Game.rooms["E1N57"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["E1N58"] = {
      sourceRoom: "E1N57",
      targetRoom: "E1N58",
      status: "suspended",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const scoutName = getRemoteMiningScoutConfigName("E1N57", "E1N58");
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();
    expect(Memory.data!.creepConfigs![scoutName].roomName).toBe("E1N57");
  });

  it("does not create spawnable scout for invalid source room (RCL < 7)", () => {
    const rcl6Room = createRclRoom("E1N57", 6);
    Game.rooms["E1N57"] = rcl6Room;
    Game.spawns["Spawn1"] = createSpawn(rcl6Room);

    store["E1N58"] = {
      sourceRoom: "E1N57",
      targetRoom: "E1N58",
      status: "suspended",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const scoutName = getRemoteMiningScoutConfigName("E1N57", "E1N58");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
  });

  it("does not create spawnable scout when source room is in defense mode", () => {
    const mod = require("@/runtime/defenseMode");
    jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

    const rcl7Room = createRclRoom("E1N57", 7);
    Game.rooms["E1N57"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["E1N58"] = {
      sourceRoom: "E1N57",
      targetRoom: "E1N58",
      status: "suspended",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const scoutName = getRemoteMiningScoutConfigName("E1N57", "E1N58");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();

    (mod.isDefenseMode as jest.Mock).mockRestore();
  });

  it("does not create spawnable scout for abandoned task", () => {
    const rcl7Room = createRclRoom("E1N57", 7);
    Game.rooms["E1N57"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["E1N58"] = {
      sourceRoom: "E1N57",
      targetRoom: "E1N58",
      status: "abandoned",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 100,
      abandonedReason: "not_dual_source",
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const scoutName = getRemoteMiningScoutConfigName("E1N57", "E1N58");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
  });

  it("cleans up harvester/carrier/reserver configs while keeping scout spawnable", () => {
    const rcl7Room = createRclRoom("E1N57", 7);
    Game.rooms["E1N57"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["E1N58"] = {
      sourceRoom: "E1N57",
      targetRoom: "E1N58",
      status: "suspended",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
    };

    const scoutName = getRemoteMiningScoutConfigName("E1N57", "E1N58");
    const h1 = getRemoteMiningHarvesterConfigName("E1N57", "E1N58", "src1");
    const c0 = getRemoteMiningCarrierConfigName("E1N57", "E1N58", 0);
    const r0 = getRemoteMiningReserverConfigName("E1N57", "E1N58");
    Memory.data!.creepConfigs![scoutName] = { role: "scout", args: ["E1N58"] };
    Memory.data!.creepConfigs![h1] = { role: "colonizerHarvester", args: ["E1N58", "src1"], roomName: "E1N57" };
    Memory.data!.creepConfigs![c0] = { role: "remoteMiningCarrier", args: ["E1N58", "src1"], roomName: "E1N57" };
    Memory.data!.creepConfigs![r0] = { role: "remoteMiningReserver", args: ["E1N58"], roomName: "E1N57" };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![h1]).toBeUndefined();
    expect(Memory.data!.creepConfigs![c0]).toBeUndefined();
    expect(Memory.data!.creepConfigs![r0]).toBeUndefined();
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();
    expect(Memory.data!.creepConfigs![scoutName].roomName).toBe("E1N57");
  });

  it("does not create harvester/carrier/reserver configs while suspended", () => {
    const rcl7Room = createRclRoom("E1N57", 7);
    Game.rooms["E1N57"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["E1N58"] = {
      sourceRoom: "E1N57",
      targetRoom: "E1N58",
      status: "suspended",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const configs = Memory.data!.creepConfigs!;
    for (const key of Object.keys(configs)) {
      expect(key).not.toContain(":harvester:");
      expect(key).not.toContain(":carrier:");
      expect(key).not.toContain(":reserver:");
    }
  });

  it("does not create scout when target room is visible and safe past threshold (resumes instead)", () => {
    Game.time = 300;
    const rcl7Room = createRclRoom("E1N57", 7);
    const targetRoom = createVisibleTargetRoom("E1N58", {
      sources: [createSource("src1"), createSource("src2")],
    });
    Game.rooms["E1N57"] = rcl7Room;
    Game.rooms["E1N58"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["E1N58"] = {
      sourceRoom: "E1N57",
      targetRoom: "E1N58",
      status: "suspended",
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
      lastThreatAt: 100,
      safeSince: 200,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["E1N58"].status).toBe("active");
    const scoutName = getRemoteMiningScoutConfigName("E1N57", "E1N58");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
  });

  it("does not create scout when source room is not visible", () => {
    Game.rooms = {};
    Game.spawns = {};

    store["E1N58"] = {
      sourceRoom: "E1N57",
      targetRoom: "E1N58",
      status: "suspended",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const scoutName = getRemoteMiningScoutConfigName("E1N57", "E1N58");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
  });
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

  it("active invisible target creates scout config to reacquire visibility", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);
    // W1N0 is NOT in Game.rooms — invisible target

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      updatedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();
    expect(Memory.data!.creepConfigs![scoutName].role).toBe("scout");
    expect(Memory.data!.creepConfigs![scoutName].args).toEqual(["W1N0"]);
    expect(Memory.data!.creepConfigs![scoutName].roomName).toBe("W1N1");
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

  it("active visible target does not create new scout config", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
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

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
  });

  it("suspended visible target does not create scout (still threatened)", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "suspended",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
      lastThreatAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
  });

  it("suspended visible target removes stale scout config", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    const spawn = createSpawn(rcl7Room);
    Game.spawns["Spawn1"] = spawn;

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "suspended",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
      lastThreatAt: 100,
    };

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![scoutName] = { role: "scout", args: ["W1N0"], roomName: "W1N1" };
    spawn.memory.spawnList = [scoutName, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });

  it("suspended invisible target still creates scout (preserved behavior)", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);
    // W1N0 is NOT in Game.rooms — invisible target

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "suspended",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
      lastThreatAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();
    expect(Memory.data!.creepConfigs![scoutName].roomName).toBe("W1N1");
  });

  it("suspended visible but safe (not enough ticks) does not create scout", () => {
    Game.time = 210;
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "suspended",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
      lastThreatAt: 100,
      safeSince: 200,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    // Only 10 safe ticks, need 100 — still suspended
    expect(store["W1N0"].status).toBe("suspended");
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
  });

  it("active invisible target still creates harvester/carrier/reserver configs alongside scout", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    Game.rooms["W1N1"] = rcl7Room;
    Game.spawns["Spawn1"] = createSpawn(rcl7Room);

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      updatedAt: 100,
    };

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();

    const h1 = getRemoteMiningHarvesterConfigName("W1N1", "W1N0", "src1");
    expect(Memory.data!.creepConfigs![h1]).toBeDefined();

    const c0 = getRemoteMiningCarrierConfigName("W1N1", "W1N0", 0);
    expect(Memory.data!.creepConfigs![c0]).toBeDefined();

    const r0 = getRemoteMiningReserverConfigName("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![r0]).toBeDefined();
  });

  it("orphans stale scout config for active visible target when live scout creep exists", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
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

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![scoutName] = { role: "scout", args: ["W1N0"], roomName: "W1N1" };

    const liveScout = {
      memory: { configName: scoutName, role: "scout" },
      room: { name: "W1N0" },
    } as unknown as Creep;
    Game.creeps["scout_1"] = liveScout;

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    // Config should be orphaned (exists but roomName deleted) not fully removed
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();
    expect(Memory.data!.creepConfigs![scoutName].roomName).toBeUndefined();
  });

  it("active visible target removes stale scout when suspending due to threat", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      hostileCreeps: [hostile],
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

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![scoutName] = { role: "scout", args: ["W1N0"], roomName: "W1N1" };
    spawn.memory.spawnList = [scoutName, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["W1N0"].status).toBe("suspended");
    expect(store["W1N0"].suspendReason).toBe("hostile_creeps");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });

  it("suspended visible target in defense mode removes stale scout", () => {
    const mod = require("@/runtime/defenseMode");
    jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

    const rcl7Room = createRclRoom("W1N1", 7);
    const hostile = {
      id: "hc1",
      getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0,
    } as unknown as Creep;
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1")],
      hostileCreeps: [hostile],
    });
    Game.rooms["W1N1"] = rcl7Room;
    Game.rooms["W1N0"] = targetRoom;
    const spawn = createSpawn(rcl7Room);
    Game.spawns["Spawn1"] = spawn;

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "suspended",
      sourceIds: ["src1"],
      assignedAt: 50,
      updatedAt: 100,
      suspendReason: "hostile_creeps",
      suspendedAt: 100,
      lastThreatAt: 100,
    };

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![scoutName] = { role: "scout", args: ["W1N0"], roomName: "W1N1" };
    spawn.memory.spawnList = [scoutName, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(store["W1N0"].status).toBe("suspended");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);

    (mod.isDefenseMode as jest.Mock).mockRestore();
  });

  it("active visible target with invalid source room removes stale scout", () => {
    const rcl6Room = createRclRoom("W1N1", 6);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
    });
    Game.rooms["W1N1"] = rcl6Room;
    Game.rooms["W1N0"] = targetRoom;
    const spawn = createSpawn(rcl6Room);
    Game.spawns["Spawn1"] = spawn;

    store["W1N0"] = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status: "active",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      updatedAt: 100,
    };

    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![scoutName] = { role: "scout", args: ["W1N0"], roomName: "W1N1" };
    spawn.memory.spawnList = [scoutName, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });
});

   it("orphans pre-existing reserver config when self-reservation above threshold and live creep exists", () => {
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

    const liveCreep = {
      memory: { configName: reserverName, role: "remoteMiningReserver" },
      room: { name: "W1N0" },
    } as unknown as Creep;
    Game.creeps["reserver_1"] = liveCreep;

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(Memory.data!.creepConfigs![reserverName]).toBeDefined();
    expect(Memory.data!.creepConfigs![reserverName].roomName).toBeUndefined();
  });
});
