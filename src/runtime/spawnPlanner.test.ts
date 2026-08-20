jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set()),
}));

import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { getPowerBankConfigName, POWER_BANK_STATUS } from "@/runtime/powerBankConstants";
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

describe("spawnPlanner powerbank combat guard", () => {
  function setupCombatRoom(roomName = "E3N59"): { room: Room; spawn: StructureSpawn } {
    const room = createRoom(roomName, 7);
    const spawn = createSpawn(room, `${roomName}-spawn`);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    addLiveCarrier(room);
    return { room, spawn };
  }

  function makeCombatConfig(
    sourceRoom: string,
    taskId: string | undefined,
  ): { name: string; config: Record<string, unknown> } {
    const name = getPowerBankConfigName(sourceRoom, "E0N60", "attacker", 0, taskId ?? "orphan-task", 0);
    return {
      name,
      config: {
        role: "powerBankAttacker",
        args: ["E0N60", `${sourceRoom}|E0N60`],
        roomName: sourceRoom,
        taskId,
      },
    };
  }

  it("prunes combat configs whose owning task is in hauling stage and strips queue leftovers", () => {
    const { spawn } = setupCombatRoom();
    const config = makeCombatConfig("E3N59", "task-hauling");
    Memory.data = {
      powerBankHarvest: {
        "task-hauling": {
          id: "task-hauling",
          sourceRoom: "W1N57",
          targetRoom: "E0N60",
          status: "hauling",
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];
    spawn.memory.spawnList = [config.name];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeUndefined();
  });

  it("prunes combat configs left under a previous source room after task re-discovery", () => {
    const { spawn } = setupCombatRoom();
    const config = makeCombatConfig("E3N59", "task-rediscovered");
    Memory.data = {
      powerBankHarvest: {
        "task-rediscovered": {
          id: "task-rediscovered",
          sourceRoom: "W1N57",
          targetRoom: "E0N60",
          status: POWER_BANK_STATUS.SPAWNING,
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];
    spawn.memory.spawnList = [config.name];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeUndefined();
  });

  it("prunes combat configs whose owning task no longer exists", () => {
    const { spawn } = setupCombatRoom();
    const config = makeCombatConfig("E3N59", "task-gone");
    Memory.data = {
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];
    spawn.memory.spawnList = [config.name];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeUndefined();
  });

  it("queues combat configs for an active combat task in the current source room", () => {
    const { spawn } = setupCombatRoom();
    const config = makeCombatConfig("E3N59", "task-active");
    Memory.data = {
      powerBankHarvest: {
        "task-active": {
          id: "task-active",
          sourceRoom: "E3N59",
          targetRoom: "E0N60",
          status: POWER_BANK_STATUS.SPAWNING,
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeDefined();
  });

  it("keeps a retired config alive while its creep still lives but strips its queue entries", () => {
    const { room, spawn } = setupCombatRoom();
    const config = makeCombatConfig("E3N59", "task-hauling-live");
    Game.creeps["powerBankAttacker-live"] = {
      name: "powerBankAttacker-live",
      room,
      memory: { role: "powerBankAttacker", configName: config.name },
    } as Creep;
    Memory.data = {
      powerBankHarvest: {
        "task-hauling-live": {
          id: "task-hauling-live",
          sourceRoom: "E3N59",
          targetRoom: "E0N60",
          status: "hauling",
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];
    spawn.memory.spawnList = [config.name];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeDefined();
  });
});

describe("spawnPlanner powerbank combat guard edge cases", () => {
  function setupCombatRoom(roomName = "E3N59"): { room: Room; spawn: StructureSpawn } {
    const room = createRoom(roomName, 7);
    const spawn = createSpawn(room, `${roomName}-spawn`);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    addLiveCarrier(room);
    return { room, spawn };
  }

  function makeCombatConfigEntry(options: {
    sourceRoom: string;
    taskId?: string;
    role?: "powerBankAttacker" | "powerBankHealer";
    index?: number;
    generation?: number;
  }): { name: string; config: Record<string, unknown> } {
    const taskId = options.taskId ?? "task-edge";
    const name = getPowerBankConfigName(
      options.sourceRoom,
      "E0N60",
      options.role === "powerBankHealer" ? "healer" : "attacker",
      options.index ?? 0,
      taskId,
      options.generation ?? 0,
    );
    return {
      name,
      config: {
        role: options.role ?? "powerBankAttacker",
        args: ["E0N60", `${options.sourceRoom}|E0N60`],
        roomName: options.sourceRoom,
        taskId,
        powerBankGeneration: options.generation ?? 0,
      },
    };
  }

  it("queues reinforcement combat configs for an active task", () => {
    const { spawn } = setupCombatRoom();
    const reinforcement = makeCombatConfigEntry({
      sourceRoom: "E3N59",
      taskId: "task-reinforcement",
      index: 1,
      generation: 1,
    });
    Memory.data = {
      powerBankHarvest: {
        "task-reinforcement": {
          id: "task-reinforcement",
          sourceRoom: "E3N59",
          targetRoom: "E0N60",
          status: POWER_BANK_STATUS.ATTACKING,
          reinforcement: { index: 1, generation: 1, stage: "spawning" },
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [reinforcement.name]: reinforcement.config },
    } as unknown as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(reinforcement.name);
    expect(Memory.data.creepConfigs?.[reinforcement.name]).toBeDefined();
  });

  it("keeps a retired config while its creep is still spawning", () => {
    const { room, spawn } = setupCombatRoom();
    const config = makeCombatConfigEntry({ sourceRoom: "E3N59", taskId: "task-spawning" });
    Memory.creeps["powerBankHealer-spawning"] = {
      configName: config.name,
      role: "powerBankHealer",
    } as CreepMemory;
    spawn.spawning = {
      name: "powerBankHealer-spawning",
      remainingTime: 10,
      needTime: 40,
    } as Spawning;
    Memory.data = {
      powerBankHarvest: {
        "task-spawning": {
          id: "task-spawning",
          sourceRoom: "E3N59",
          targetRoom: "E0N60",
          status: "hauling",
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];
    spawn.memory.spawnList = [config.name];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeDefined();
    expect(spawn.spawning?.name).toBe("powerBankHealer-spawning");
    expect(room).toBeDefined();
  });

  it("skips queueing combat configs while the source room is in defense mode", () => {
    (isDefenseMode as jest.Mock).mockReturnValue(true);
    try {
      const { spawn } = setupCombatRoom();
      const config = makeCombatConfigEntry({ sourceRoom: "E3N59", taskId: "task-defense" });
      Memory.data = {
        powerBankHarvest: {
          "task-defense": {
            id: "task-defense",
            sourceRoom: "E3N59",
            targetRoom: "E0N60",
            status: POWER_BANK_STATUS.SPAWNING,
          } as PowerBankHarvestTask,
        },
        creepConfigs: { [config.name]: config.config },
      } as unknown as Memory["data"];

      scheduleSpawnTasks();

      expect(spawn.memory.spawnList).not.toContain(config.name);
      expect(Memory.data.creepConfigs?.[config.name]).toBeDefined();
    } finally {
      (isDefenseMode as jest.Mock).mockReturnValue(false);
    }
  });
});
