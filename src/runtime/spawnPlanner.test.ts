import { spawnMaxCarrierRaw } from "@/runtime/consoleCommands";
import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";

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

function createSpawn(room: Room, pathLength = 2): StructureSpawn {
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
    name: `${room.name}-spawn`,
    id: `${room.name}-spawn-id` as Id<StructureSpawn>,
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
