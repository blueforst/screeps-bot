jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

import { runCrossShardColonizationByFlag } from "@/runtime/crossShardColonization";
import { isDefenseMode } from "@/runtime/defenseMode";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name: string): Room {
  const memory = {} as RoomMemory;
  Memory.rooms[name] = memory;
  return {
    name,
    memory,
    energyCapacityAvailable: 1000,
    controller: {
      my: true,
      level: 5,
    } as StructureController,
    find: jest.fn(() => []),
  } as unknown as Room;
}

function createSpawn(name: string, room: Room): StructureSpawn {
  const spawn = {
    name,
    room,
    memory: {
      spawnList: [],
    },
    isActive: jest.fn(() => true),
  } as unknown as StructureSpawn;

  spawn.addTask = jest.fn((configName: string) => {
    if (!spawn.memory.spawnList) {
      spawn.memory.spawnList = [];
    }
    if (!spawn.memory.spawnList.includes(configName)) {
      spawn.memory.spawnList.push(configName);
    }
    return spawn.memory.spawnList.length;
  });

  return spawn;
}

function createFlag(name: string): Flag {
  return {
    name,
    remove: jest.fn(),
  } as unknown as Flag;
}

describe("runCrossShardColonizationByFlag", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRuntimeServices();
    Game.time = 10000;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Game.flags = {};
    Game.shard = { name: "shard0" } as Game["shard"];
    Memory.data = undefined;
    Memory.rooms = {};
    Memory.creeps = {};
    (isDefenseMode as jest.Mock).mockReturnValue(false);

    Object.assign(Game, {
      map: {
        getRoomLinearDistance: jest.fn(() => 1),
      },
    });
  });

  it("blocks instead of silently switching away from an unavailable preferred source room", () => {
    const sourceRoom = createRoom("W1N1");
    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.spawns.Spawn1 = createSpawn("Spawn1", sourceRoom);
    Game.flags.CLX_shard1_W9N9_W2N2 = createFlag("CLX_shard1_W9N9_W2N2");
    Memory.data = {
      interShardPortals: {
        portal1: {
          id: "portal1" as Id<StructurePortal>,
          originRoom: "W1N2",
          destinationShard: "shard1",
          destinationRoom: "W9N8",
          discoveredAt: Game.time,
          lastSeenAt: Game.time,
          ticksToDecay: 10000,
        },
      },
    } as Memory["data"];

    runCrossShardColonizationByFlag();

    const task = Memory.data?.crossShardColonization?.["shard1:W9N9"];
    expect(task?.status).toBe("blocked");
    expect(task?.sourceRoom).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual([]);
  });

  it("retries an in-transit claimer after the remote claim timeout", () => {
    const sourceRoom = createRoom("W1N1");
    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.spawns.Spawn1 = createSpawn("Spawn1", sourceRoom);
    Memory.data = {
      creepConfigs: {},
      interShardPortals: {
        portal1: {
          id: "portal1" as Id<StructurePortal>,
          originRoom: "W1N2",
          destinationShard: "shard1",
          destinationRoom: "W9N8",
          discoveredAt: Game.time,
          lastSeenAt: Game.time,
          ticksToDecay: 10000,
        },
      },
      crossShardColonization: {
        "shard1:W9N9": {
          targetShard: "shard1",
          targetRoom: "W9N9",
          sourceRoom: "W1N1",
          status: "in_transit",
          flagName: "CLX_shard1_W9N9",
          portalRoom: "W1N2",
          destinationRoom: "W9N8",
          claimerConfigName: "W1N1:crossShard:shard1:W9N9:claimer:0",
          claimerName: "old-claimer",
          launchedAt: Game.time - 1501,
          createdAt: Game.time - 2000,
          updatedAt: Game.time - 1,
        },
      },
    } as Memory["data"];

    runCrossShardColonizationByFlag();

    const configName = "W1N1:crossShard:shard1:W9N9:claimer:0";
    const task = Memory.data?.crossShardColonization?.["shard1:W9N9"];
    expect(task?.status).toBe("ready");
    expect(task?.launchedAt).toBeUndefined();
    expect(task?.claimerName).not.toBe("old-claimer");
    expect(Memory.data?.creepConfigs?.[configName]?.roomName).toBe("W1N1");
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual([configName]);
  });

  it("reissues a bootstrap squad after waiting too long without a target spawn", () => {
    const sourceRoom = createRoom("W1N1");
    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.spawns.Spawn1 = createSpawn("Spawn1", sourceRoom);
    Memory.data = {
      creepConfigs: {},
      interShardPortals: {
        portal1: {
          id: "portal1" as Id<StructurePortal>,
          originRoom: "W1N2",
          destinationShard: "shard1",
          destinationRoom: "W9N8",
          discoveredAt: Game.time,
          lastSeenAt: Game.time,
          ticksToDecay: 10000,
        },
      },
      crossShardColonization: {
        "shard1:W9N9": {
          targetShard: "shard1",
          targetRoom: "W9N9",
          sourceRoom: "W1N1",
          status: "bootstrapping",
          flagName: "CLX_shard1_W9N9",
          portalRoom: "W1N2",
          destinationRoom: "W9N8",
          claimedAt: Game.time - 2500,
          bootstrapConfigNames: ["stale-bootstrap"],
          bootstrapDispatchedAt: Game.time - 2001,
          createdAt: Game.time - 3000,
          updatedAt: Game.time - 1,
        },
      },
    } as Memory["data"];

    runCrossShardColonizationByFlag();

    const task = Memory.data?.crossShardColonization?.["shard1:W9N9"];
    expect(task?.status).toBe("bootstrapping");
    expect(task?.bootstrapDispatchedAt).toBe(Game.time);
    expect(task?.bootstrapConfigNames).toHaveLength(4);
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual(task?.bootstrapConfigNames);
  });

  it("enqueues claimer to the least-loaded spawn in a multi-spawn room", () => {
    const sourceRoom = createRoom("W1N1");
    Game.rooms[sourceRoom.name] = sourceRoom;
    const spawnA = createSpawn("SpawnA", sourceRoom);
    spawnA.memory.spawnList = ["existing-task-1", "existing-task-2"];
    const spawnB = createSpawn("SpawnB", sourceRoom);
    Game.spawns.SpawnA = spawnA;
    Game.spawns.SpawnB = spawnB;
    Memory.data = {
      creepConfigs: {},
      interShardPortals: {
        portal1: {
          id: "portal1" as Id<StructurePortal>,
          originRoom: "W1N2",
          destinationShard: "shard1",
          destinationRoom: "W9N8",
          discoveredAt: Game.time,
          lastSeenAt: Game.time,
          ticksToDecay: 10000,
        },
      },
      crossShardColonization: {
        "shard1:W9N9": {
          targetShard: "shard1",
          targetRoom: "W9N9",
          sourceRoom: "W1N1",
          status: "planning",
          flagName: "CLX_shard1_W9N9",
          portalRoom: "W1N2",
          destinationRoom: "W9N8",
          createdAt: Game.time - 100,
          updatedAt: Game.time - 1,
        },
      },
    } as Memory["data"];

    runCrossShardColonizationByFlag();

    const configName = "W1N1:crossShard:shard1:W9N9:claimer:0";
    expect(spawnB.memory.spawnList).toContain(configName);
    expect(spawnA.memory.spawnList).not.toContain(configName);
  });

  it("does not duplicate a claimer already queued on a secondary spawn", () => {
    const sourceRoom = createRoom("W1N1");
    Game.rooms[sourceRoom.name] = sourceRoom;
    const configName = "W1N1:crossShard:shard1:W9N9:claimer:0";
    const spawnA = createSpawn("SpawnA", sourceRoom);
    const spawnB = createSpawn("SpawnB", sourceRoom);
    spawnB.memory.spawnList = [configName];
    Game.spawns.SpawnA = spawnA;
    Game.spawns.SpawnB = spawnB;
    Memory.data = {
      creepConfigs: {},
      interShardPortals: {
        portal1: {
          id: "portal1" as Id<StructurePortal>,
          originRoom: "W1N2",
          destinationShard: "shard1",
          destinationRoom: "W9N8",
          discoveredAt: Game.time,
          lastSeenAt: Game.time,
          ticksToDecay: 10000,
        },
      },
      crossShardColonization: {
        "shard1:W9N9": {
          targetShard: "shard1",
          targetRoom: "W9N9",
          sourceRoom: "W1N1",
          status: "planning",
          flagName: "CLX_shard1_W9N9",
          portalRoom: "W1N2",
          destinationRoom: "W9N8",
          claimerConfigName: configName,
          createdAt: Game.time - 100,
          updatedAt: Game.time - 1,
        },
      },
    } as Memory["data"];

    runCrossShardColonizationByFlag();

    expect(spawnA.memory.spawnList).not.toContain(configName);
    expect(spawnB.memory.spawnList).toContain(configName);
  });
});
