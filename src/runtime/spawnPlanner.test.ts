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
import { HUB_UPGRADER_BODY, getLinkMinerBodyForRegenSourceLevel } from "@/config/spawnProfiles";
import { resetPowerCreepControlCacheForTest } from "@/runtime/powerCreepControl";
import {
  RCL8_UPGRADER_MAINTENANCE_BODY,
  RCL8_UPGRADER_RECOVERY_START_TICKS,
} from "@/runtime/upgraderPolicy";
import { getPowerBankConfigName } from "@/runtime/powerBankConstants";

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
  resetPowerCreepControlCacheForTest();
});

describe("spawnPlanner emergency carrier flow", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
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

  it("keeps the managed carrier behind the emergency request on the earliest available spawn", () => {
    const room = createRoom("W1N10");
    room.controller = { my: true, level: 6 } as StructureController;
    const primarySpawn = createSpawn(room, 2, "W1N10-spawn-a");
    const availableSpawn = createSpawn(room, 2, "W1N10-spawn-b");
    const managed = `${room.name}:carrier:0`;
    primarySpawn.spawning = { name: "worker-busy" } as Spawning;
    availableSpawn.memory.spawnList = [managed];
    Game.rooms[room.name] = room;
    Game.spawns[primarySpawn.name] = primarySpawn;
    Game.spawns[availableSpawn.name] = availableSpawn;
    Memory.creeps[primarySpawn.spawning.name] = {
      role: "worker",
      configName: `${room.name}:worker:0`,
    } as CreepMemory;
    Memory.data = {
      creepConfigs: {
        [managed]: { role: "carrier", args: [], roomName: room.name },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(primarySpawn.memory.spawnList).toEqual([]);
    expect(availableSpawn.memory.spawnList).toEqual([
      expect.stringMatching(new RegExp(`^${room.name}:manual:maxcarrier:`)),
      managed,
    ]);
  });
});

describe("spawnPlanner PowerBank hauler ownership", () => {
  const sourceRoom = "W4N4";
  const targetRoom = "E3N60";

  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  function setupRoom(): StructureSpawn {
    const room = createRoom(sourceRoom);
    room.controller = { my: true, level: 8 } as StructureController;
    const spawn = createSpawn(room);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps[`carrier-${room.name}`] = {
      name: `carrier-${room.name}`,
      room,
      memory: { role: "carrier" },
    } as Creep;
    return spawn;
  }

  function task(id: string, haulingEmptySince?: number): PowerBankHarvestTask {
    return {
      id,
      sourceRoom,
      targetRoom,
      status: "hauling",
      haulingEmptySince,
    } as PowerBankHarvestTask;
  }

  it("does not let an exhausted task suppress a concurrent task with the same rooms", () => {
    const spawn = setupRoom();
    const taskA = "bank-task-a";
    const taskB = "bank-task-b";
    const configA = getPowerBankConfigName(sourceRoom, targetRoom, "hauler", 0, taskA, 0);
    const configB = getPowerBankConfigName(sourceRoom, targetRoom, "hauler", 0, taskB, 0);

    Memory.data = {
      powerBankHarvest: {
        [taskA]: task(taskA, Game.time - 1),
        [taskB]: task(taskB),
      },
      creepConfigs: {
        [configA]: {
          role: "powerBankHauler",
          args: [targetRoom, ""],
          roomName: sourceRoom,
          taskId: taskA,
          powerBankGeneration: 0,
        },
        [configB]: {
          role: "powerBankHauler",
          args: [targetRoom, ""],
          roomName: sourceRoom,
          taskId: taskB,
          powerBankGeneration: 0,
        },
      },
    } as unknown as Memory["data"];

    scheduleSpawnTasks();

    expect(configA).not.toBe(configB);
    expect(spawn.memory.spawnList).not.toContain(configA);
    expect(spawn.memory.spawnList).toContain(configB);
  });

  it("uses the owner token when an owned config has not yet persisted task metadata", () => {
    const spawn = setupRoom();
    const taskA = "bank-task-token-a";
    const taskB = "bank-task-token-b";
    const configA = getPowerBankConfigName(sourceRoom, targetRoom, "hauler", 0, taskA, 0);
    const configB = getPowerBankConfigName(sourceRoom, targetRoom, "hauler", 0, taskB, 0);

    Memory.data = {
      powerBankHarvest: {
        [taskA]: task(taskA, Game.time - 1),
        [taskB]: task(taskB),
      },
      creepConfigs: {
        [configA]: { role: "powerBankHauler", args: [targetRoom, ""], roomName: sourceRoom },
        [configB]: { role: "powerBankHauler", args: [targetRoom, ""], roomName: sourceRoom },
      },
    } as unknown as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configA);
    expect(spawn.memory.spawnList).toContain(configB);
  });

  it("does not guess ownership for an ambiguous legacy config", () => {
    const spawn = setupRoom();
    const legacyConfig = getPowerBankConfigName(sourceRoom, targetRoom, "hauler", 0);

    Memory.data = {
      powerBankHarvest: {
        "bank-task-legacy-a": task("bank-task-legacy-a", Game.time - 1),
        "bank-task-legacy-b": task("bank-task-legacy-b"),
      },
      creepConfigs: {
        [legacyConfig]: { role: "powerBankHauler", args: [targetRoom, ""], roomName: sourceRoom },
      },
    } as unknown as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(legacyConfig);
  });

  it("preserves exhausted detection for an unambiguous legacy task", () => {
    const spawn = setupRoom();
    const legacyConfig = getPowerBankConfigName(sourceRoom, targetRoom, "hauler", 0);

    Memory.data = {
      powerBankHarvest: {
        "bank-task-legacy": task("bank-task-legacy", Game.time - 1),
      },
      creepConfigs: {
        [legacyConfig]: { role: "powerBankHauler", args: [targetRoom, ""], roomName: sourceRoom },
      },
    } as unknown as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(legacyConfig);
  });
});

describe("spawnPlanner strategic priority", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("does not queue an ordinary upgrader in an owned RCL1-7 room", () => {
    const room = createRoom("E4N58");
    room.controller!.level = 7;
    const spawn = createSpawn(room, 2, "E4N58-spawn-a");
    const ordinary = "E4N58:upgrader:0";
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps = {
      carrier: {
        name: "carrier",
        room,
        memory: { role: "carrier" },
      } as Creep,
    };
    Memory.data = {
      manualUpgraders: {
        [room.name]: { createdAt: Game.time, updatedAt: Game.time },
      },
      creepConfigs: {
        [ordinary]: {
          role: "upgrader",
          args: [room.name],
          roomName: room.name,
          body: [...HUB_UPGRADER_BODY],
        },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(ordinary);
  });

  it("does not cancel or requeue the only RCL8 maintenance creep while it is spawning across ticks", () => {
    const room = createRoom("E4N58");
    room.controller!.level = 8;
    room.controller!.ticksToDowngrade = RCL8_UPGRADER_RECOVERY_START_TICKS;
    const primarySpawn = createSpawn(room, 2, "E4N58-spawn-a");
    const secondarySpawn = createSpawn(room, 2, "E4N58-spawn-b");
    const maintenance = "E4N58:upgrader:0";
    const cancel = jest.fn(() => OK);
    secondarySpawn.spawning = { name: "maintenance-spawning", cancel } as unknown as Spawning;
    Game.rooms[room.name] = room;
    Game.spawns[primarySpawn.name] = primarySpawn;
    Game.spawns[secondarySpawn.name] = secondarySpawn;
    Game.creeps = {
      carrier: {
        name: "carrier",
        room,
        memory: { role: "carrier" },
      } as Creep,
      "maintenance-spawning": {
        name: "maintenance-spawning",
        room,
        spawning: true,
        memory: { role: "upgrader", configName: maintenance },
      } as Creep,
    };
    Memory.creeps[secondarySpawn.spawning.name] = {
      role: "upgrader",
      configName: maintenance,
    } as CreepMemory;
    Memory.data = {
      manualUpgraders: {
        [room.name]: { createdAt: Game.time, updatedAt: Game.time, maintenance: true },
      },
      creepConfigs: {
        [maintenance]: {
          role: "upgrader",
          args: [room.name],
          roomName: room.name,
          body: [...RCL8_UPGRADER_MAINTENANCE_BODY],
        },
      },
    } as Memory["data"];

    scheduleSpawnTasks();
    Game.time += 1;
    scheduleSpawnTasks();

    expect(cancel).not.toHaveBeenCalled();
    expect(primarySpawn.memory.spawnList).not.toContain(maintenance);
    expect(secondarySpawn.memory.spawnList).not.toContain(maintenance);
    expect(secondarySpawn.spawning?.name).toBe("maintenance-spawning");
  });

  it("cancels a queued and spawning replacement when a finished live maintenance creep exists", () => {
    const room = createRoom("E4N58");
    room.controller!.level = 8;
    room.controller!.ticksToDowngrade = RCL8_UPGRADER_RECOVERY_START_TICKS;
    const maintenance = "E4N58:upgrader:0";
    const primarySpawn = createSpawn(room, 2, "E4N58-spawn-a");
    const secondarySpawn = createSpawn(room, 2, "E4N58-spawn-b");
    const cancel = jest.fn(() => OK);
    primarySpawn.memory.spawnList = [maintenance];
    secondarySpawn.spawning = { name: "replacement-spawning", cancel } as unknown as Spawning;
    Game.rooms[room.name] = room;
    Game.spawns[primarySpawn.name] = primarySpawn;
    Game.spawns[secondarySpawn.name] = secondarySpawn;
    Game.creeps = {
      carrier: {
        name: "carrier",
        room,
        memory: { role: "carrier" },
      } as Creep,
      "maintenance-live": {
        name: "maintenance-live",
        room,
        spawning: false,
        memory: { role: "upgrader", configName: maintenance },
      } as Creep,
      "replacement-spawning": {
        name: "replacement-spawning",
        room,
        spawning: true,
        memory: { role: "upgrader", configName: maintenance },
      } as Creep,
    };
    Memory.creeps["replacement-spawning"] = {
      role: "upgrader",
      configName: maintenance,
    } as CreepMemory;
    Memory.data = {
      manualUpgraders: {
        [room.name]: { createdAt: Game.time, updatedAt: Game.time, maintenance: true },
      },
      creepConfigs: {
        [maintenance]: {
          role: "upgrader",
          args: [room.name],
          roomName: room.name,
          body: [...RCL8_UPGRADER_MAINTENANCE_BODY],
        },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(primarySpawn.memory.spawnList).not.toContain(maintenance);
    expect(cancel).toHaveBeenCalledTimes(1);
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
});

describe("spawnPlanner source-role cutover queueing", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("queues a replacement when the expanded miner capacity makes the live body obsolete", () => {
    const room = createRoom("W1N5");
    room.controller.level = 8;
    room.energyCapacityAvailable = 5600;
    const spawn = createSpawn(room);
    const source = createSource("source-a", 10, 10, room.name);
    const configName = `${room.name}:miner:${source.id}`;
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.oldMiner = {
      name: "oldMiner",
      room,
      ticksToLive: 1_400,
      body: [
        ...Array<BodyPartConstant>(12).fill(WORK),
        ...Array<BodyPartConstant>(6).fill(CARRY),
        ...Array<BodyPartConstant>(5).fill(MOVE),
      ].map((type) => ({ type, hits: 100 })),
      memory: { role: "miner", configName },
    } as Creep;
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {
      Operator: {
        name: "Operator",
        memory: { homeRoom: room.name },
        powers: {
          [PWR_REGEN_SOURCE]: { level: 4, cooldown: 0 },
        },
      } as unknown as PowerCreep,
    };
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) =>
      id === source.id ? source : null,
    ) as Game["getObjectById"];
    Memory.data = {
      creepConfigs: {
        [configName]: { role: "miner", args: [source.id], roomName: room.name },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(configName);
  });

  it("does not replace a current REGEN_SOURCE-sized miner before its prespawn window", () => {
    const room = createRoom("W1N6");
    room.controller.level = 8;
    room.energyCapacityAvailable = 5600;
    const spawn = createSpawn(room);
    const source = createSource("source-b", 10, 10, room.name);
    const configName = `${room.name}:miner:${source.id}`;
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Game.creeps.currentMiner = {
      name: "currentMiner",
      room,
      ticksToLive: 1_400,
      body: getLinkMinerBodyForRegenSourceLevel(4).map((type) => ({ type, hits: 100 })),
      memory: { role: "miner", configName },
    } as Creep;
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {
      Operator: {
        name: "Operator",
        memory: { homeRoom: room.name },
        powers: {
          [PWR_REGEN_SOURCE]: { level: 4, cooldown: 0 },
        },
      } as unknown as PowerCreep,
    };
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) =>
      id === source.id ? source : null,
    ) as Game["getObjectById"];
    Memory.data = {
      creepConfigs: {
        [configName]: { role: "miner", args: [source.id], roomName: room.name },
      },
    } as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configName);
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

  it("does not pre-spawn reserver when live reserver TTL is above threshold", () => {
    // threshold = 18 + 100 = 118; TTL = 200 > 118
    const { spawn, configName } = setupReserverRoom("W9N5", { reserverTtl: 200 });

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configName);
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
