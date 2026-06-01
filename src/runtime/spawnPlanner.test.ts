jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set()),
}));

import { spawnMaxCarrierRaw } from "@/runtime/consoleCommands";
import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name: string): Room {
  return {
    name,
    controller: {
      my: true,
    } as StructureController,
    storage: {
      id: `${name}-storage`,
      pos: {
        x: 10,
        y: 10,
        roomName: name,
        findPathTo: jest.fn(() => []),
      },
    } as unknown as StructureStorage,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
  } as Room;
}

function createRoomWithoutStorage(name: string): Room {
  const room = createRoom(name);
  room.storage = undefined;
  return room;
}

function createMineral(
  id: string,
  options: {
    amount?: number;
    containerX?: number;
    containerY?: number;
  } = {},
): Mineral {
  const container = {
    id: `${id}-container`,
    structureType: STRUCTURE_CONTAINER,
    pos: {
      x: options.containerX ?? 11,
      y: options.containerY ?? 10,
      roomName: "W1N1",
    },
  } as StructureContainer;

  return {
    id,
    mineralAmount: options.amount ?? 1000,
    pos: {
      x: 10,
      y: 10,
      roomName: "W1N1",
      findInRange: () => [container],
    } as unknown as RoomPosition,
  } as Mineral;
}

function createSource(id: string, x = 10, y = 10, roomName = "W1N1"): Source {
  return {
    id,
    pos: {
      x,
      y,
      roomName,
      findInRange: jest.fn(() => []),
    } as unknown as RoomPosition,
  } as Source;
}

function createSpawn(room: Room, pathLength = 2, name = `${room.name}-spawn`): StructureSpawn {
  const findPathTo = jest.fn(() =>
    Array.from({ length: pathLength }, (_, index) => ({
      x: 20 + index,
      y: 20,
      dx: 1,
      dy: 0,
      direction: RIGHT,
    })),
  );
  const storageFindPathTo = jest.fn(() =>
    Array.from({ length: pathLength }, (_, index) => ({
      x: 10 + index,
      y: 10,
      dx: 1,
      dy: 0,
      direction: RIGHT,
    })),
  );
  if (room.storage) {
    room.storage.pos.findPathTo = storageFindPathTo as RoomPosition["findPathTo"];
  }

  return {
    name,
    id: `${name}-id` as Id<StructureSpawn>,
    room,
    memory: {
      spawnList: [],
    },
    spawning: null,
    pos: {
      x: 13,
      y: 10,
      roomName: room.name,
      findPathTo,
    } as unknown as RoomPosition,
    addTask(configName: string) {
      this.memory.spawnList = [...(this.memory.spawnList || []), configName];
      return this.memory.spawnList.length;
    },
  } as unknown as StructureSpawn;
}

beforeEach(() => {
  (isDefenseMode as jest.Mock).mockReturnValue(false);
  (getSafeZone as jest.Mock).mockReturnValue(new Set());
  (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(() => null) as Game["getObjectById"];
});

describe("spawnPlanner emergency carrier flow", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("queues an emergency max carrier when a room has no live or spawning carrier", () => {
    const room = createRoom("W1N1");
    const spawn = createSpawn(room);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList?.[0]).toContain(":manual:maxcarrier:");
    expect(Memory.data?.creepConfigs?.[spawn.memory.spawnList?.[0] || ""]).toMatchObject({
      role: "carrier",
      roomName: room.name,
      body: [CARRY, MOVE, CARRY, MOVE, CARRY, MOVE],
    });
  });

  it("exposes the same max-carrier behavior through the console wrapper", () => {
    const room = createRoom("W1N2");
    const spawn = createSpawn(room);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;

    expect(spawnMaxCarrierRaw(room.name)).toMatchObject({
      ok: true,
      roomName: room.name,
      spawnName: spawn.name,
      bodyParts: 6,
      pairCount: 3,
    });
    expect(spawn.memory.spawnList?.[0]).toContain(":manual:maxcarrier:");
  });
});

describe("spawnPlanner managed mineral harvester queueing", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("pre-spawns mineral harvesters when ttl is below travel + spawn threshold", () => {
    const room = createRoom("W1N1");
    room.energyCapacityAvailable = 750;
    const spawn = createSpawn(room);
    const mineral = createMineral("mineral-1");
    const mineralConfigName = "W1N1:mineralHarvester:mineral-1";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.carrier1 = {
      name: "carrier1",
      room,
      memory: {
        role: "carrier",
      },
    } as Creep;
    Game.creeps.mh1 = {
      name: "mh1",
      room,
      ticksToLive: 10,
      memory: {
        role: "mineralHarvester",
        configName: mineralConfigName,
      },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [mineralConfigName]: {
          role: "mineralHarvester",
          args: [mineral.id],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === mineral.id) {
        return mineral;
      }

      return null;
    }) as Game["getObjectById"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(mineralConfigName);
  });

  it("does not pre-spawn mineral harvesters when ttl is still above threshold", () => {
    const room = createRoom("W1N2");
    room.energyCapacityAvailable = 750;
    const spawn = createSpawn(room);
    const mineral = createMineral("mineral-2");
    const mineralConfigName = "W1N2:mineralHarvester:mineral-2";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.carrier2 = {
      name: "carrier2",
      room,
      memory: {
        role: "carrier",
      },
    } as Creep;
    Game.creeps.mh2 = {
      name: "mh2",
      room,
      ticksToLive: 300,
      memory: {
        role: "mineralHarvester",
        configName: mineralConfigName,
      },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [mineralConfigName]: {
          role: "mineralHarvester",
          args: [mineral.id],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === mineral.id) {
        return mineral;
      }

      return null;
    }) as Game["getObjectById"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(mineralConfigName);
  });

  it("skips harvester queueing when defense mode is active and the work position is outside the safe zone", () => {
    const room = createRoom("W2N2");
    const spawn = createSpawn(room);
    const source = createSource("source-1", 20, 20, room.name);
    const configName = `${room.name}:harvester:${source.id}`;

    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.carrierX = {
      name: "carrierX",
      room,
      memory: { role: "carrier" },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "harvester",
          args: [source.id],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === source.id) {
        return source;
      }

      return null;
    }) as Game["getObjectById"];
    (isDefenseMode as jest.Mock).mockReturnValue(true);
    (getSafeZone as jest.Mock).mockReturnValue(new Set([10 * 50 + 10]));

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configName);
  });

  it("reuses persisted source worker thresholds across ticks until cache expiry", () => {
    const room = createRoom("W1N3");
    room.energyCapacityAvailable = 750;
    const spawn = createSpawn(room, 5);
    const mineral = createMineral("mineral-3");
    const mineralConfigName = "W1N3:mineralHarvester:mineral-3";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.carrier3 = {
      name: "carrier3",
      room,
      memory: {
        role: "carrier",
      },
    } as Creep;
    Game.creeps.mh3 = {
      name: "mh3",
      room,
      ticksToLive: 20,
      memory: {
        role: "mineralHarvester",
        configName: mineralConfigName,
      },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [mineralConfigName]: {
          role: "mineralHarvester",
          args: [mineral.id],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === mineral.id) {
        return mineral;
      }

      return null;
    }) as Game["getObjectById"];

    scheduleSpawnTasks();

    const anchorFindPathTo = (room.storage!.pos.findPathTo as jest.Mock);
    const spawnFindPathTo = (spawn.pos.findPathTo as jest.Mock);
    expect(anchorFindPathTo).toHaveBeenCalledTimes(1);
    expect(spawnFindPathTo).toHaveBeenCalledTimes(0);

    spawn.memory.spawnList = [];
    Game.time += 1;
    resetRuntimeServices();
    scheduleSpawnTasks();

    expect(anchorFindPathTo).toHaveBeenCalledTimes(1);
    expect(spawnFindPathTo).toHaveBeenCalledTimes(0);

    spawn.memory.spawnList = [];
    Game.time += 1001;
    resetRuntimeServices();
    scheduleSpawnTasks();

    expect(anchorFindPathTo).toHaveBeenCalledTimes(2);
    expect(spawnFindPathTo).toHaveBeenCalledTimes(0);
  });

  it("does not pre-spawn mineral harvesters when mineral is depleted", () => {
    const room = createRoom("W1N6");
    room.energyCapacityAvailable = 750;
    const spawn = createSpawn(room);
    const mineral = createMineral("mineral-depleted", { amount: 0 });
    const mineralConfigName = "W1N6:mineralHarvester:mineral-depleted";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.carrierD = {
      name: "carrierD",
      room,
      memory: {
        role: "carrier",
      },
    } as Creep;
    Game.creeps.mhD = {
      name: "mhD",
      room,
      ticksToLive: 10,
      memory: {
        role: "mineralHarvester",
        configName: mineralConfigName,
      },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [mineralConfigName]: {
          role: "mineralHarvester",
          args: [mineral.id],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === mineral.id) {
        return mineral;
      }

      return null;
    }) as Game["getObjectById"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(mineralConfigName);
  });

  it("does not pre-spawn mineral harvesters when configured mineral is missing", () => {
    const room = createRoom("W1N7");
    room.energyCapacityAvailable = 750;
    const spawn = createSpawn(room);
    const mineralId = "mineral-missing" as Id<Mineral>;
    const mineralConfigName = "W1N7:mineralHarvester:mineral-missing";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.carrierM = {
      name: "carrierM",
      room,
      memory: {
        role: "carrier",
      },
    } as Creep;
    Game.creeps.mhM = {
      name: "mhM",
      room,
      ticksToLive: 10,
      memory: {
        role: "mineralHarvester",
        configName: mineralConfigName,
      },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [mineralConfigName]: {
          role: "mineralHarvester",
          args: [mineralId],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(() => null) as Game["getObjectById"];

    expect(() => scheduleSpawnTasks()).not.toThrow();
    expect(spawn.memory.spawnList).not.toContain(mineralConfigName);
  });

  it("falls back to spawn position when storage is unavailable", () => {
    const room = createRoomWithoutStorage("W1N4");
    room.energyCapacityAvailable = 750;
    const spawn = createSpawn(room, 4);
    const mineral = createMineral("mineral-4");
    const mineralConfigName = "W1N4:mineralHarvester:mineral-4";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.carrier4 = {
      name: "carrier4",
      room,
      memory: {
        role: "carrier",
      },
    } as Creep;
    Game.creeps.mh4 = {
      name: "mh4",
      room,
      ticksToLive: 10,
      memory: {
        role: "mineralHarvester",
        configName: mineralConfigName,
      },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [mineralConfigName]: {
          role: "mineralHarvester",
          args: [mineral.id],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === mineral.id) {
        return mineral;
      }

      return null;
    }) as Game["getObjectById"];

    scheduleSpawnTasks();

    expect((spawn.pos.findPathTo as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(Memory.runtime?.spawnPlanner?.sourceWorkerCommutes).toEqual(
      expect.objectContaining({
        [`${room.name}:${room.name}:${spawn.pos.x}:${spawn.pos.y}:${mineral.pos.roomName}:11:10`]: {
          commute: 4,
          updatedAt: Game.time,
        },
      }),
    );
  });
});

describe("spawnPlanner source-role cutover queueing", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("skips orphaned stale harvester configs after a source switches to miner", () => {
    const room = createRoom("W1N5");
    room.controller.level = 5;
    room.energyCapacityAvailable = 1200;
    const spawn = createSpawn(room);
    const minerConfigName = "W1N5:miner:source-a";
    const harvesterConfigName = "W1N5:harvester:source-a";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Memory.data = {
      creepConfigs: {
        [harvesterConfigName]: {
          role: "harvester",
          args: ["source-a"],
        },
        [minerConfigName]: {
          role: "miner",
          args: ["source-a"],
          roomName: room.name,
        },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(minerConfigName);
    expect(spawn.memory.spawnList).not.toContain(harvesterConfigName);
  });
});

describe("spawnPlanner powerbank hauler distribution", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("distributes powerbank haulers across all room spawns", () => {
    const room = createRoom("W3N3");
    const spawnA = createSpawn(room, 2, "W3N3-spawn-a");
    const spawnB = createSpawn(room, 2, "W3N3-spawn-b");
    const spawnC = createSpawn(room, 2, "W3N3-spawn-c");
    Game.rooms[room.name] = room;
    Game.spawns[spawnA.name] = spawnA;
    Game.spawns[spawnB.name] = spawnB;
    Game.spawns[spawnC.name] = spawnC;
    Game.creeps.carrier = {
      name: "carrier",
      room,
      memory: { role: "carrier" },
    } as Creep;

    Memory.data = {
      creepConfigs: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `W3N3:powerbank:E3N60:hauler:${index}`,
          {
            role: "powerBankHauler",
            args: ["E3N60", ""],
            roomName: room.name,
          },
        ]),
      ),
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawnA.memory.spawnList).toEqual([
      "W3N3:powerbank:E3N60:hauler:0",
      "W3N3:powerbank:E3N60:hauler:3",
    ]);
    expect(spawnB.memory.spawnList).toEqual([
      "W3N3:powerbank:E3N60:hauler:1",
      "W3N3:powerbank:E3N60:hauler:4",
    ]);
    expect(spawnC.memory.spawnList).toEqual([
      "W3N3:powerbank:E3N60:hauler:2",
    ]);
  });

  it("does not queue the same powerbank hauler on multiple spawns", () => {
    const room = createRoom("W3N4");
    const spawnA = createSpawn(room, 2, "W3N4-spawn-a");
    const spawnB = createSpawn(room, 2, "W3N4-spawn-b");
    const configName = "W3N4:powerbank:E3N60:hauler:0";
    spawnB.memory.spawnList = [configName];
    Game.rooms[room.name] = room;
    Game.spawns[spawnA.name] = spawnA;
    Game.spawns[spawnB.name] = spawnB;
    Game.creeps.carrier = {
      name: "carrier",
      room,
      memory: { role: "carrier" },
    } as Creep;

    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "powerBankHauler",
          args: ["E3N60", ""],
          roomName: room.name,
        },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawnA.memory.spawnList).toEqual([]);
    expect(spawnB.memory.spawnList).toEqual([configName]);
  });

  it("does not queue replacement haulers after hauling target is empty", () => {
    const room = createRoom("W3N5");
    const spawn = createSpawn(room, 2, "W3N5-spawn");
    const configName = "W3N5:powerbank:E3N60:hauler:0";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.carrier = {
      name: "carrier",
      room,
      memory: { role: "carrier" },
    } as Creep;

    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "powerBankHauler",
          args: ["E3N60", ""],
          roomName: room.name,
        },
      },
      powerBankHarvest: {
        task: {
          id: "task",
          status: "hauling",
          sourceRoom: room.name,
          targetRoom: "E3N60",
          bankId: "bank",
          bankPos: { x: 25, y: 25 },
          hits: 0,
          power: 1000,
          ticksToDecay: 0,
          freeTiles: 1,
          discoveredTick: Game.time - 100,
          lastSeenTick: Game.time - 10,
          haulerIds: [],
          boostLabs: [],
          compoundTransferTaskIds: [],
          haulingStartedTick: Game.time - 10,
          haulingEmptySince: Game.time,
        },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toEqual([]);
  });
});

describe("spawnPlanner no-spawn safety", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("does not throw and does not mutate any queue when a room has configs but no spawn", () => {
    const room = createRoom("W5N1");
    room.controller.level = 3;
    room.energyCapacityAvailable = 800;
    const source = createSource("source-y", 20, 20, room.name);
    const configName = `${room.name}:harvester:${source.id}`;

    Game.rooms[room.name] = room;
    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "harvester",
          args: [source.id],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === source.id) {
        return source;
      }
      return null;
    }) as Game["getObjectById"];

    expect(() => scheduleSpawnTasks()).not.toThrow();

    const allQueues = Object.values(Game.spawns)
      .map((s) => s.memory.spawnList ?? []);
    expect(allQueues.every((q) => q.length === 0)).toBe(true);
  });
});

describe("spawnPlanner standard managed config distribution", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  /** Helper: create a room with a live carrier to suppress emergency spawning. */
  function setupRoomWithCarrier(roomName: string): { room: Room } {
    const room = createRoom(roomName);
    Game.rooms[room.name] = room;
    Game.creeps[`carrier-${roomName}`] = {
      name: `carrier-${roomName}`,
      room,
      memory: { role: "carrier" },
    } as Creep;
    return { room };
  }

  /** Helper: add worker configs to Memory.data.creepConfigs. */
  function addWorkerConfigs(roomName: string, count: number): string[] {
    if (!Memory.data) {
      Memory.data = {} as Memory["data"];
    }
    if (!Memory.data.creepConfigs) {
      Memory.data.creepConfigs = {};
    }
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const name = `${roomName}:worker:${i}`;
      Memory.data.creepConfigs[name] = { role: "worker", args: [], roomName };
      names.push(name);
    }
    return names;
  }

  it("distributes four standard configs across two spawns with 2/2 split and no duplicates", () => {
    const { room } = setupRoomWithCarrier("W6N1");
    const spawnA = createSpawn(room, 2, "W6N1-spawn-a");
    const spawnB = createSpawn(room, 2, "W6N1-spawn-b");
    Game.spawns[spawnA.name] = spawnA;
    Game.spawns[spawnB.name] = spawnB;

    const configNames = addWorkerConfigs(room.name, 4);

    scheduleSpawnTasks();

    const allQueued = [
      ...spawnA.memory.spawnList!,
      ...spawnB.memory.spawnList!,
    ];
    for (const cn of configNames) {
      expect(allQueued.filter((q) => q === cn)).toHaveLength(1);
    }

    expect(spawnA.memory.spawnList).toHaveLength(2);
    expect(spawnB.memory.spawnList).toHaveLength(2);

    expect(spawnA.memory.spawnList).toEqual([configNames[0], configNames[2]]);
    expect(spawnB.memory.spawnList).toEqual([configNames[1], configNames[3]]);
  });

  it("distributes five standard configs across three spawns with 2/2/1 split", () => {
    const { room } = setupRoomWithCarrier("W6N2");
    const spawnA = createSpawn(room, 2, "W6N2-spawn-a");
    const spawnB = createSpawn(room, 2, "W6N2-spawn-b");
    const spawnC = createSpawn(room, 2, "W6N2-spawn-c");
    Game.spawns[spawnA.name] = spawnA;
    Game.spawns[spawnB.name] = spawnB;
    Game.spawns[spawnC.name] = spawnC;

    const configNames = addWorkerConfigs(room.name, 5);

    scheduleSpawnTasks();

    const allQueued = [
      ...spawnA.memory.spawnList!,
      ...spawnB.memory.spawnList!,
      ...spawnC.memory.spawnList!,
    ];
    for (const cn of configNames) {
      expect(allQueued.filter((q) => q === cn)).toHaveLength(1);
    }

    expect(spawnA.memory.spawnList).toHaveLength(2);
    expect(spawnB.memory.spawnList).toHaveLength(2);
    expect(spawnC.memory.spawnList).toHaveLength(1);

    // Least-loaded/name-tiebreak: a(0)→0, b(0)→1, c(0)→2, a=b=c(1)→a→3, b→4
    expect(spawnA.memory.spawnList).toEqual([configNames[0], configNames[3]]);
    expect(spawnB.memory.spawnList).toEqual([configNames[1], configNames[4]]);
    expect(spawnC.memory.spawnList).toEqual([configNames[2]]);
  });

  it("queues all standard configs on the single spawn in a single-spawn room", () => {
    const { room } = setupRoomWithCarrier("W6N3");
    const spawn = createSpawn(room, 2, "W6N3-spawn");
    Game.spawns[spawn.name] = spawn;

    const configNames = addWorkerConfigs(room.name, 3);

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toEqual(configNames);
  });

  it("does not duplicate a config already queued on a secondary spawn", () => {
    const { room } = setupRoomWithCarrier("W6N4");
    const spawnA = createSpawn(room, 2, "W6N4-spawn-a");
    const spawnB = createSpawn(room, 2, "W6N4-spawn-b");
    Game.spawns[spawnA.name] = spawnA;
    Game.spawns[spawnB.name] = spawnB;

    const configNames = addWorkerConfigs(room.name, 2);
    spawnB.memory.spawnList = [configNames[0]];

    scheduleSpawnTasks();

    expect(spawnA.memory.spawnList).not.toContain(configNames[0]);
    expect(spawnB.memory.spawnList.filter((q) => q === configNames[0])).toHaveLength(1);
    expect(spawnA.memory.spawnList).toContain(configNames[1]);
  });
});
