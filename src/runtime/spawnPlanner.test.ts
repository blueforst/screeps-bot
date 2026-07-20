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

  it("keeps only one emergency carrier request while the spawn is busy", () => {
    const room = createRoom("W1N3");
    const spawn = createSpawn(room);
    spawn.spawning = {
      name: "meleeAttacker-busy",
    } as Spawning;
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Memory.creeps[spawn.spawning.name] = {
      role: "meleeAttacker",
      configName: `${room.name}:war:W2N3:g1:meleeAttacker:0`,
    } as CreepMemory;

    scheduleSpawnTasks();
    Game.time += 1;
    scheduleSpawnTasks();

    const emergencyConfigs = spawn.memory.spawnList!.filter((name) => name.includes(":manual:maxcarrier:"));
    expect(emergencyConfigs).toHaveLength(1);
    expect(Object.keys(Memory.data!.creepConfigs!).filter((name) => name.includes(":manual:maxcarrier:"))).toHaveLength(1);
  });

  it("recognizes a spawning transient carrier after its config has been removed", () => {
    const room = createRoom("W1N4");
    const spawn = createSpawn(room);
    spawn.spawning = {
      name: "carrier-spawning",
    } as Spawning;
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Memory.creeps[spawn.spawning.name] = {
      role: "carrier",
      configName: `${room.name}:manual:maxcarrier:${Game.time}`,
    } as CreepMemory;

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList!.some((name) => name.includes(":manual:maxcarrier:"))).toBe(false);
  });

  it("removes stale queued emergency carriers once a carrier is spawning", () => {
    const room = createRoom("W1N5");
    const spawn = createSpawn(room);
    const staleA = `${room.name}:manual:maxcarrier:${Game.time - 2}`;
    const staleB = `${room.name}:manual:maxcarrier:${Game.time - 1}`;
    spawn.spawning = {
      name: "carrier-spawning-cleanup",
    } as Spawning;
    spawn.memory.spawnList = [staleA, "unrelated:worker", staleB];
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Memory.creeps[spawn.spawning.name] = {
      role: "carrier",
      configName: `${room.name}:manual:maxcarrier:${Game.time}`,
    } as CreepMemory;
    Memory.data = {
      creepConfigs: {
        [staleA]: { role: "carrier", args: [], roomName: room.name },
        [staleB]: { role: "carrier", args: [], roomName: room.name },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toEqual(["unrelated:worker"]);
    expect(Memory.data!.creepConfigs![staleA]).toBeUndefined();
    expect(Memory.data!.creepConfigs![staleB]).toBeUndefined();
  });

  it("moves an emergency carrier request off an inactive spawn", () => {
    const room = createRoom("W1N6");
    const inactiveSpawn = createSpawn(room, 2, "W1N6-spawn-inactive");
    const activeSpawn = createSpawn(room, 2, "W1N6-spawn-active");
    const stale = `${room.name}:manual:maxcarrier:${Game.time - 1}`;
    inactiveSpawn.isActive = jest.fn(() => false);
    activeSpawn.isActive = jest.fn(() => true);
    inactiveSpawn.memory.spawnList = [stale];
    Game.rooms[room.name] = room;
    Game.spawns[inactiveSpawn.name] = inactiveSpawn;
    Game.spawns[activeSpawn.name] = activeSpawn;
    Memory.data = {
      creepConfigs: {
        [stale]: { role: "carrier", args: [], roomName: room.name },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(inactiveSpawn.memory.spawnList).toEqual([]);
    expect(activeSpawn.memory.spawnList).toHaveLength(1);
    expect(activeSpawn.memory.spawnList![0]).toContain(":manual:maxcarrier:");
  });

  it("queues a missing managed carrier while a healthy emergency carrier keeps working", () => {
    const room = createRoom("W1N7");
    const spawn = createSpawn(room);
    const managed = `${room.name}:carrier:0`;
    const suicide = jest.fn();
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.emergencyCarrier = {
      name: "emergencyCarrier",
      room,
      ticksToLive: 1400,
      suicide,
      memory: {
        role: "carrier",
        configName: `${room.name}:manual:maxcarrier:${Game.time - 100}`,
      },
    } as unknown as Creep;
    Memory.data = {
      creepConfigs: {
        [managed]: { role: "carrier", args: [], roomName: room.name },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(managed);
    expect(suicide).not.toHaveBeenCalled();
  });

  it("does not let one emergency carrier cover any managed carrier slots", () => {
    const room = createRoom("W1N8");
    const spawn = createSpawn(room);
    const first = `${room.name}:carrier:0`;
    const second = `${room.name}:carrier:1`;
    spawn.memory.spawnList = [first, second];
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.emergencyCarrier = {
      name: "emergencyCarrier",
      room,
      ticksToLive: 1400,
      memory: {
        role: "carrier",
        configName: `${room.name}:manual:maxcarrier:${Game.time - 100}`,
      },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [first]: { role: "carrier", args: [], roomName: room.name },
        [second]: { role: "carrier", args: [], roomName: room.name },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    const managedQueue = spawn.memory.spawnList!.filter((name) => name.startsWith(`${room.name}:carrier:`));
    expect(managedQueue).toEqual([first, second]);
  });

  it("queues the managed replacement when the emergency carrier is near expiry", () => {
    const room = createRoom("W1N9");
    const spawn = createSpawn(room);
    const managed = `${room.name}:carrier:0`;
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.emergencyCarrier = {
      name: "emergencyCarrier",
      room,
      ticksToLive: 1,
      memory: {
        role: "carrier",
        configName: `${room.name}:manual:maxcarrier:${Game.time - 1400}`,
      },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [managed]: { role: "carrier", args: [], roomName: room.name },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(managed);
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

describe("spawnPlanner strategic priority", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("orders only the source-room carrier ahead of war, then the hub upgrader", () => {
    const room = createRoom("E4N58");
    room.controller!.level = 7;
    const spawn = createSpawn(room);
    const homeCarrier = "E4N58:carrier:0";
    const warHealer = "E4N58:war:E5N58:g1:healer:0";
    const hubUpgrader = "E4N58:hubUpgrader:0";
    const remoteCarrier = "E4N58:remoteMine:E4N59:carrier:0";
    const miner = "E4N58:miner:source0";
    const worker = "E4N58:worker:0";
    spawn.memory.spawnList = [worker, miner, remoteCarrier, hubUpgrader, warHealer, homeCarrier];
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.homeCarrier = {
      name: "homeCarrier",
      room,
      memory: { role: "carrier" },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [homeCarrier]: { role: "carrier", args: [], roomName: room.name },
        [warHealer]: { role: "healer", args: [], roomName: room.name },
        [hubUpgrader]: { role: "hubUpgrader", args: [], roomName: room.name },
        [remoteCarrier]: { role: "remoteCarrier", args: [], roomName: "E4N59" },
        [miner]: { role: "miner", args: ["source0"], roomName: room.name },
        [worker]: { role: "worker", args: [], roomName: room.name },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toEqual([
      homeCarrier,
      warHealer,
      hubUpgrader,
      remoteCarrier,
      miner,
      worker,
    ]);
  });
});

describe("spawnPlanner one-shot configs", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("does not requeue a spawnOnce config after it has been queued once", () => {
    const room = createRoom("W1N3");
    const spawn = createSpawn(room);
    const configName = "W1N3:war:W2N3:meleeAttacker:0";
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
          role: "meleeAttacker",
          args: ["W2N3"],
          roomName: room.name,
          spawnOnce: { queuedAt: Game.time - 10 },
        },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configName);
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

describe("remoteMiningCarrier defense mode", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("does not queue remoteMiningCarrier when source room is in defense mode", () => {
    const room = createRoom("W7N1");
    const spawn = createSpawn(room);
    const configName = "W7N1:remoteMiningCarrier:W7N0:src1";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps["carrier-rm"] = {
      name: "carrier-rm",
      room,
      memory: { role: "carrier" },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "remoteMiningCarrier",
          args: ["W7N0", "src1"],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (isDefenseMode as jest.Mock).mockReturnValue(true);

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configName);
  });

  it("queues remoteMiningCarrier when source room is not in defense mode", () => {
    const room = createRoom("W7N2");
    const spawn = createSpawn(room);
    const configName = "W7N2:remoteMiningCarrier:W7N1:src2";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps["carrier-rm2"] = {
      name: "carrier-rm2",
      room,
      memory: { role: "carrier" },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "remoteMiningCarrier",
          args: ["W7N1", "src2"],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (isDefenseMode as jest.Mock).mockReturnValue(false);

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(configName);
  });

  it("remoteMiningCarrier is not priority 0 (not treated as emergency carrier/miner)", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const src = readFileSync(resolve(__dirname, "spawnPlanner.ts"), "utf-8");

    const priorityBlockMatch = src.match(/function getSpawnRolePriority[\s\S]*?^}/m);
    expect(priorityBlockMatch).not.toBeNull();

    const priorityBlock = priorityBlockMatch![0];
    expect(priorityBlock).not.toContain("remoteMiningCarrier");

    expect(priorityBlock).toContain('role === "carrier" || role === "remoteCarrier"');
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

describe("remoteMiningReserver spawn planner", () => {
  const reserverBody = [CLAIM, MOVE, CLAIM, MOVE, CLAIM, MOVE]; // 6 parts

  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  function setupReserverRoom(
    roomName: string,
    overrides?: { reserverTtl?: number; alreadyQueued?: boolean; alreadySpawning?: boolean },
  ): { room: Room; spawn: StructureSpawn; configName: string } {
    const room = createRoom(roomName);
    room.energyCapacityAvailable = 2300;
    const spawn = createSpawn(room);
    const configName = `${roomName}:remoteMine:W8N1:reserver:0`;
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps[`carrier-${roomName}`] = {
      name: `carrier-${roomName}`,
      room,
      memory: { role: "carrier" },
    } as Creep;

    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "remoteMiningReserver",
          args: ["W8N1"],
          roomName: room.name,
          body: reserverBody,
        },
      },
    } as Memory["data"];

    if (overrides?.reserverTtl !== undefined) {
      Game.creeps["reserver-live"] = {
        name: "reserver-live",
        room,
        ticksToLive: overrides.reserverTtl,
        memory: {
          role: "remoteMiningReserver",
          configName,
        },
      } as Creep;
    }

    if (overrides?.alreadyQueued) {
      spawn.memory.spawnList = [configName];
    }

    if (overrides?.alreadySpawning) {
      spawn.spawning = {
        name: "reserver-spawning",
        remainingTime: 5,
        needTime: 6,
      } as Spawning;
      Memory.creeps = Memory.creeps || {};
      Memory.creeps["reserver-spawning"] = {
        configName,
      } as any;
    }

    return { room, spawn, configName };
  }

  // ── Defense mode skip ──

  it("does not queue remoteMiningReserver when source room is in defense mode", () => {
    const { spawn, configName } = setupReserverRoom("W9N1");
    (isDefenseMode as jest.Mock).mockReturnValue(true);

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configName);
  });

  it("queues remoteMiningReserver when source room is not in defense mode", () => {
    const { spawn, configName } = setupReserverRoom("W9N2");
    (isDefenseMode as jest.Mock).mockReturnValue(false);

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(configName);
  });

  // ── Priority ──

  it("remoteMiningReserver has priority 1 (same tier as colonizerHarvester, not priority 0)", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const src = readFileSync(resolve(__dirname, "spawnPlanner.ts"), "utf-8");

    const priorityBlockMatch = src.match(/function getSpawnRolePriority[\s\S]*?^}/m);
    expect(priorityBlockMatch).not.toBeNull();

    const priorityBlock = priorityBlockMatch![0];

    // Must be in the priority-1 tier alongside harvester/miner/colonizerHarvester
    const p1Line = priorityBlock.match(/role === "harvester" \|[^]*?return 1/);
    expect(p1Line).not.toBeNull();
    expect(p1Line![0]).toContain("remoteMiningReserver");

    // Must NOT be in priority-0 tier
    const p0Line = priorityBlock.match(/return 0[^]*?role === "carrier"/);
    if (p0Line) {
      expect(p0Line[0]).not.toContain("remoteMiningReserver");
    }
  });

  it("remoteMiningReserver is higher priority than remoteMiningCarrier (priority 3 default)", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const src = readFileSync(resolve(__dirname, "spawnPlanner.ts"), "utf-8");

    const priorityBlockMatch = src.match(/function getSpawnRolePriority[\s\S]*?^}/m);
    expect(priorityBlockMatch).not.toBeNull();

    const priorityBlock = priorityBlockMatch![0];

    // remoteMiningCarrier is not in any explicit tier → falls to return 3
    expect(priorityBlock).not.toContain("remoteMiningCarrier");
    // remoteMiningReserver is explicitly in tier 1
    expect(priorityBlock).toContain("remoteMiningReserver");
  });

  // ── Pre-spawn: queue when no live reserver exists ──

  it("queues reserver when no live reserver exists", () => {
    const { spawn, configName } = setupReserverRoom("W9N3");

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(configName);
  });

  // ── Pre-spawn: queue when live reserver TTL is below threshold ──

  it("pre-spawns reserver when live reserver TTL is below spawnTime + 100", () => {
    // reserverBody has 6 parts → spawnTime = 6 * 3 = 18 ticks; threshold = 18 + 100 = 118
    const { spawn, configName } = setupReserverRoom("W9N4", { reserverTtl: 100 });

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(configName);
  });

  it("does not pre-spawn reserver when live reserver TTL is above threshold", () => {
    // threshold = 18 + 100 = 118; TTL = 200 > 118
    const { spawn, configName } = setupReserverRoom("W9N5", { reserverTtl: 200 });

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configName);
  });

  // ── No duplicate queueing ──

  it("does not queue reserver when already queued on a spawn", () => {
    const { spawn, configName } = setupReserverRoom("W9N6", { alreadyQueued: true });

    scheduleSpawnTasks();

    // Should still be exactly 1 entry, not duplicated
    const count = spawn.memory.spawnList!.filter((n) => n === configName).length;
    expect(count).toBe(1);
  });

  it("does not queue reserver when already spawning", () => {
    const { spawn, configName } = setupReserverRoom("W9N7", { alreadySpawning: true });

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configName);
  });

  // ── Outbound non-war role check ──

  it("remoteMiningReserver is in the outbound non-war role list", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const src = readFileSync(resolve(__dirname, "spawnPlanner.ts"), "utf-8");

    const outboundMatch = src.match(/function isOutboundNonWarRole[\s\S]*?^}/m);
    expect(outboundMatch).not.toBeNull();
    expect(outboundMatch![0]).toContain("remoteMiningReserver");
  });
});

describe("remoteWorker and remoteDefender defense mode", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("does not queue remoteWorker when source room is in defense mode", () => {
    const room = createRoom("W8N1");
    const spawn = createSpawn(room);
    const configName = "W8N1:remoteMine:W8N0:worker:0";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps["carrier-rw"] = {
      name: "carrier-rw",
      room,
      memory: { role: "carrier" },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "remoteWorker",
          args: ["W8N0"],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (isDefenseMode as jest.Mock).mockReturnValue(true);

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configName);
  });

  it("queues remoteWorker when source room is not in defense mode", () => {
    const room = createRoom("W8N2");
    const spawn = createSpawn(room);
    const configName = "W8N2:remoteMine:W8N1:worker:0";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps["carrier-rw2"] = {
      name: "carrier-rw2",
      room,
      memory: { role: "carrier" },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "remoteWorker",
          args: ["W8N1"],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (isDefenseMode as jest.Mock).mockReturnValue(false);

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(configName);
  });

  it("does not queue remoteDefender when source room is in defense mode", () => {
    const room = createRoom("W9N1");
    const spawn = createSpawn(room);
    const configName = "W9N1:remoteMine:W9N0:defender:0";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps["carrier-rd"] = {
      name: "carrier-rd",
      room,
      memory: { role: "carrier" },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "remoteDefender",
          args: ["W9N0"],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (isDefenseMode as jest.Mock).mockReturnValue(true);

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configName);
  });

  it("queues remoteDefender when source room is not in defense mode", () => {
    const room = createRoom("W9N2");
    const spawn = createSpawn(room);
    const configName = "W9N2:remoteMine:W9N1:defender:0";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps["carrier-rd2"] = {
      name: "carrier-rd2",
      room,
      memory: { role: "carrier" },
    } as Creep;
    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "remoteDefender",
          args: ["W9N1"],
          roomName: room.name,
        },
      },
    } as Memory["data"];
    (isDefenseMode as jest.Mock).mockReturnValue(false);

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(configName);
  });

  it("remoteWorker and remoteDefender are in the outbound non-war role list", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const src = readFileSync(resolve(__dirname, "spawnPlanner.ts"), "utf-8");

    const outboundMatch = src.match(/function isOutboundNonWarRole[\s\S]*?^}/m);
    expect(outboundMatch).not.toBeNull();
    expect(outboundMatch![0]).toContain("remoteWorker");
    expect(outboundMatch![0]).toContain("remoteDefender");
  });
});

describe("inactive spawn filtering", () => {
  function createSpawnWithActive(room: Room, name: string, active: boolean): StructureSpawn {
    const spawn = createSpawn(room, 2, name);
    (spawn as any).isActive = jest.fn(() => active);
    return spawn;
  }

  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("selects the active spawn as primary when the first spawn is inactive", () => {
    const room = createRoom("E4N58");
    const inactiveSpawn = createSpawnWithActive(room, "E4N58-Spawn2", false);
    const activeSpawn = createSpawnWithActive(room, "E4N58-Spawn10", true);
    Game.rooms[room.name] = room;
    Game.spawns[inactiveSpawn.name] = inactiveSpawn;
    Game.spawns[activeSpawn.name] = activeSpawn;

    const { getTickContextService } = require("@/runtime/runtimeServices");
    const primary = getTickContextService().getPrimarySpawnByRoom(room.name);
    expect(primary).toBeDefined();
    expect(primary!.name).toBe("E4N58-Spawn10");
  });

  it("queues emergency carrier to active spawn when primary is inactive", () => {
    const room = createRoom("E4N59");
    const inactiveSpawn = createSpawnWithActive(room, "E4N59-Spawn2", false);
    const activeSpawn = createSpawnWithActive(room, "E4N59-Spawn10", true);
    Game.rooms[room.name] = room;
    Game.spawns[inactiveSpawn.name] = inactiveSpawn;
    Game.spawns[activeSpawn.name] = activeSpawn;

    scheduleSpawnTasks();

    expect(activeSpawn.memory.spawnList?.[0]).toContain(":manual:maxcarrier:");
    expect(inactiveSpawn.memory.spawnList?.length ?? 0).toBe(0);
  });

  it("distributes worker configs to active spawn when inactive spawn has shorter queue", () => {
    const room = createRoom("E4N60");
    room.controller = { my: true, level: 6 } as StructureController;
    const inactiveSpawn = createSpawnWithActive(room, "E4N60-Spawn2", false);
    const activeSpawn = createSpawnWithActive(room, "E4N60-Spawn10", true);
    Game.rooms[room.name] = room;
    Game.spawns[inactiveSpawn.name] = inactiveSpawn;
    Game.spawns[activeSpawn.name] = activeSpawn;

    Game.creeps["carrier-e4n60"] = {
      name: "carrier-e4n60",
      room,
      memory: { role: "carrier" },
    } as Creep;

    const configNames = [`${room.name}:worker:0`, `${room.name}:worker:1`];
    Memory.data = {
      creepConfigs: {
        [configNames[0]]: { role: "worker", args: [], roomName: room.name },
        [configNames[1]]: { role: "worker", args: [], roomName: room.name },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(activeSpawn.memory.spawnList).toContain(configNames[0]);
    expect(activeSpawn.memory.spawnList).toContain(configNames[1]);
    expect(inactiveSpawn.memory.spawnList?.length ?? 0).toBe(0);
  });

  it("falls back to inactive spawn when no active spawn exists", () => {
    const room = createRoom("E4N61");
    const inactiveSpawn = createSpawnWithActive(room, "E4N61-Spawn2", false);
    Game.rooms[room.name] = room;
    Game.spawns[inactiveSpawn.name] = inactiveSpawn;

    scheduleSpawnTasks();

    expect(inactiveSpawn.memory.spawnList?.[0]).toContain(":manual:maxcarrier:");
  });

  it("queues config on active spawn when stale entry exists only on inactive spawn", () => {
    const room = createRoom("E4N62");
    room.controller = { my: true, level: 6 } as StructureController;
    const inactiveSpawn = createSpawnWithActive(room, "E4N62-Spawn2", false);
    const activeSpawn = createSpawnWithActive(room, "E4N62-Spawn10", true);
    Game.rooms[room.name] = room;
    Game.spawns[inactiveSpawn.name] = inactiveSpawn;
    Game.spawns[activeSpawn.name] = activeSpawn;

    const configName = `${room.name}:worker:0`;
    Memory.data = {
      creepConfigs: {
        [configName]: { role: "worker", args: [], roomName: room.name },
      },
    } as Memory["data"];

    // Simulate stale queue entry on inactive spawn
    inactiveSpawn.memory.spawnList = [configName];

    scheduleSpawnTasks();

    // Active spawn should receive the config despite stale entry on inactive spawn
    expect(activeSpawn.memory.spawnList).toContain(configName);
  });
});
