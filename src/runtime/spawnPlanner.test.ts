jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set()),
}));

import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { getPowerBankConfigName } from "@/runtime/powerBankConstants";
import { resetPowerCreepControlCacheForTest } from "@/runtime/powerCreepControl";
import { clearSpawnActiveCacheForTest } from "@/runtime/tickContext";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name: string, level = 6): Room {
  return {
    name,
    controller: { my: true, level } as StructureController,
    storage: {
      id: `${name}-storage`,
      pos: { x: 10, y: 10, roomName: name, findPathTo: jest.fn(() => []) },
    } as unknown as StructureStorage,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
  } as Room;
}

function createSpawn(room: Room, name: string, active = true): StructureSpawn {
  return {
    name,
    id: `${name}-id` as Id<StructureSpawn>,
    room,
    memory: { spawnList: [] },
    spawning: null,
    isActive: jest.fn(() => active),
    pos: {
      x: 13,
      y: 10,
      roomName: room.name,
      findPathTo: jest.fn(() => []),
    } as unknown as RoomPosition,
    addTask(configName: string) {
      this.memory.spawnList = [...(this.memory.spawnList || []), configName];
      return this.memory.spawnList.length;
    },
  } as unknown as StructureSpawn;
}

function addLiveCarrier(room: Room): void {
  Game.creeps[`carrier-${room.name}`] = {
    name: `carrier-${room.name}`,
    room,
    memory: { role: "carrier" },
  } as Creep;
}

beforeEach(() => {
  (isDefenseMode as jest.Mock).mockReturnValue(false);
  (getSafeZone as jest.Mock).mockReturnValue(new Set());
  resetRuntimeServices();
  resetPowerCreepControlCacheForTest();
  clearSpawnActiveCacheForTest();
  Game.time += 1;
});

describe("spawnPlanner queue ownership", () => {
  it("distributes managed configs across active spawns without duplicate owners", () => {
    const room = createRoom("W6N1");
    const spawnA = createSpawn(room, "W6N1-spawn-a");
    const spawnB = createSpawn(room, "W6N1-spawn-b");
    Game.rooms[room.name] = room;
    Game.spawns[spawnA.name] = spawnA;
    Game.spawns[spawnB.name] = spawnB;
    addLiveCarrier(room);

    const configNames = Array.from({ length: 4 }, (_, slot) => `${room.name}:worker:${slot}`);
    Memory.data = { creepConfigs: Object.fromEntries(configNames.map((configName) => [
      configName,
      { role: "worker", args: [], roomName: room.name },
    ])) } as Memory["data"];

    scheduleSpawnTasks();

    const allQueued = [...spawnA.memory.spawnList!, ...spawnB.memory.spawnList!];
    for (const configName of configNames) {
      expect(allQueued.filter((queued) => queued === configName)).toHaveLength(1);
    }
    expect(spawnA.memory.spawnList).toEqual([configNames[0], configNames[2]]);
    expect(spawnB.memory.spawnList).toEqual([configNames[1], configNames[3]]);
  });

  it("moves stale inactive ownership to an active spawn without rewriting spawnOnce time", () => {
    const room = createRoom("E4N63");
    const inactive = createSpawn(room, "E4N63-spawn-a", false);
    const active = createSpawn(room, "E4N63-spawn-b", true);
    Game.rooms[room.name] = room;
    Game.spawns[inactive.name] = inactive;
    Game.spawns[active.name] = active;
    addLiveCarrier(room);

    const worker = `${room.name}:worker:0`;
    const spawnOnce = `${room.name}:war:once`;
    const queuedAt = Game.time - 25;
    Memory.data = { creepConfigs: {
      [worker]: { role: "worker", args: [], roomName: room.name },
      [spawnOnce]: {
        role: "claimer",
        args: [],
        roomName: room.name,
        spawnOnce: { queuedAt },
      },
    } } as Memory["data"];
    inactive.memory.spawnList = [worker, spawnOnce];

    scheduleSpawnTasks();

    expect(inactive.memory.spawnList).toEqual([]);
    expect(active.memory.spawnList).toEqual(expect.arrayContaining([worker, spawnOnce]));
    expect(active.memory.spawnList!.filter((name) => name === worker)).toHaveLength(1);
    expect(active.memory.spawnList!.filter((name) => name === spawnOnce)).toHaveLength(1);
    expect(Memory.data.creepConfigs![spawnOnce].spawnOnce?.queuedAt).toBe(queuedAt);
  });

  it("removes every queued copy when the config already has a spawning owner", () => {
    const room = createRoom("E4N64");
    const spawnA = createSpawn(room, "E4N64-spawn-a");
    const spawnB = createSpawn(room, "E4N64-spawn-b");
    Game.rooms[room.name] = room;
    Game.spawns[spawnA.name] = spawnA;
    Game.spawns[spawnB.name] = spawnB;
    addLiveCarrier(room);

    const configName = `${room.name}:worker:0`;
    Memory.data = { creepConfigs: {
      [configName]: { role: "worker", args: [], roomName: room.name },
    } } as Memory["data"];
    Memory.creeps["worker-spawning"] = { configName } as CreepMemory;
    spawnA.spawning = {
      name: "worker-spawning",
      remainingTime: 3,
      needTime: 9,
    } as Spawning;
    spawnA.memory.spawnList = [configName];
    spawnB.memory.spawnList = [configName];

    scheduleSpawnTasks();

    expect(spawnA.memory.spawnList).not.toContain(configName);
    expect(spawnB.memory.spawnList).not.toContain(configName);
    expect(spawnA.spawning?.name).toBe("worker-spawning");
  });

  it("uses PowerBank owner tokens and does not guess ambiguous legacy ownership", () => {
    const sourceRoom = "W4N4";
    const sharedTarget = "E3N60";
    const uniqueTarget = "E4N60";
    const room = createRoom(sourceRoom, 8);
    const spawn = createSpawn(room, `${sourceRoom}-spawn`);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    addLiveCarrier(room);

    const taskA = "bank-task-a";
    const taskB = "bank-task-b";
    const taskC = "bank-task-c";
    const configA = getPowerBankConfigName(sourceRoom, sharedTarget, "hauler", 0, taskA, 0);
    const configB = getPowerBankConfigName(sourceRoom, sharedTarget, "hauler", 0, taskB, 0);
    const ambiguousLegacy = getPowerBankConfigName(sourceRoom, sharedTarget, "hauler", 1);
    const exhaustedLegacy = getPowerBankConfigName(sourceRoom, uniqueTarget, "hauler", 0);
    const task = (id: string, targetRoom: string, exhausted: boolean): PowerBankHarvestTask => ({
      id,
      sourceRoom,
      targetRoom,
      status: "hauling",
      haulingEmptySince: exhausted ? Game.time - 1 : undefined,
    } as PowerBankHarvestTask);
    Memory.data = {
      powerBankHarvest: {
        [taskA]: task(taskA, sharedTarget, true),
        [taskB]: task(taskB, sharedTarget, false),
        [taskC]: task(taskC, uniqueTarget, true),
      },
      creepConfigs: {
        [configA]: { role: "powerBankHauler", args: [sharedTarget, ""], roomName: sourceRoom },
        [configB]: { role: "powerBankHauler", args: [sharedTarget, ""], roomName: sourceRoom },
        [ambiguousLegacy]: {
          role: "powerBankHauler",
          args: [sharedTarget, ""],
          roomName: sourceRoom,
        },
        [exhaustedLegacy]: {
          role: "powerBankHauler",
          args: [uniqueTarget, ""],
          roomName: sourceRoom,
        },
      },
    } as unknown as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configA);
    expect(spawn.memory.spawnList).toContain(configB);
    expect(spawn.memory.spawnList).toContain(ambiguousLegacy);
    expect(spawn.memory.spawnList).not.toContain(exhaustedLegacy);
  });
});
