import { runWarControl } from "@/runtime/warControl";
import { createMockStore, MockPos } from "@mock/powerBank";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createSourceRoom(): Room {
  return {
    name: "E1N57",
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: "storage" as Id<StructureStorage>,
      structureType: STRUCTURE_STORAGE,
      store: createMockStore({}),
    } as unknown as StructureStorage,
    terminal: {
      id: "terminal" as Id<StructureTerminal>,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      store: createMockStore({}),
    } as unknown as StructureTerminal,
    find: jest.fn(() => []),
  } as unknown as Room;
}

function createTargetRoom(hostileCreeps: Creep[] = []): Room {
  return {
    name: "E3N57",
    controller: { my: false, level: 0 } as StructureController,
    find: jest.fn((type: FindConstant, opts?: { filter?: (value: Creep | Structure) => boolean }) => {
      const values: Array<Creep | Structure> = type === FIND_HOSTILE_CREEPS ? hostileCreeps : [];
      return opts?.filter ? values.filter((value) => opts.filter?.(value)) : values;
    }),
  } as unknown as Room;
}

function createSpawn(room: Room): StructureSpawn {
  return {
    id: "spawn-1" as Id<StructureSpawn>,
    name: "Spawn1",
    room,
    owner: { username: "me" } as Owner,
    memory: { spawnList: [] },
    spawning: null,
    isActive: jest.fn(() => true),
    addTask(configName: string): number {
      this.memory.spawnList.push(configName);
      return this.memory.spawnList.length;
    },
  } as unknown as StructureSpawn;
}

function createWarCreep(
  name: string,
  role: "meleeAttacker" | "healer",
  configName: string,
  roomName = "E1N57",
): Creep {
  return {
    name,
    room: { name: roomName } as Room,
    pos: new MockPos(25, 25, roomName) as unknown as RoomPosition,
    memory: { role, configName },
    body: [],
    hits: 5_000,
    hitsMax: 5_000,
    spawning: false,
  } as unknown as Creep;
}

describe("runWarControl", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 1000;
    Memory.runtime = {};
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "staging",
          reason: "manual",
          squad: "t3Duo",
          boostTier: "t3",
          attempts: 1,
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
  });

  it("does not expire an old task that is already clearing visible hostiles", () => {
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          statusSince: Game.time - 3000,
          reason: "npc_reservation",
          attempts: 1,
          createdAt: Game.time - 3000,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];
    const hostile = { owner: { username: "enemy" } } as Creep;
    Game.rooms.E1N57 = createSourceRoom();
    Game.rooms.E3N57 = createTargetRoom([hostile]);

    runWarControl();

    expect(Memory.data?.war?.E3N57?.status).toBe("clearing");
    expect(Memory.data?.war?.E3N57?.lastHostileSeenAt).toBe(Game.time);
  });

  it("terminalizes and detaches live and spawning members while removing production immediately", () => {
    const attackerConfig = "E1N57:war:E3N57:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:healer:0";
    const attackerSuicide = jest.fn(() => OK);
    const attacker = createWarCreep("attacker", "meleeAttacker", attackerConfig);
    attacker.memory.roleArgs = ["E3N57", "", "", "", healerConfig];
    attacker.memory._warPartnerConfigName = healerConfig;
    attacker.suicide = attackerSuicide;
    const spawningMemory = {
      role: "healer" as const,
      roleArgs: ["E3N57", "", "", "", attackerConfig],
      configName: healerConfig,
      _warPartnerConfigName: attackerConfig,
    } as CreepMemory;
    const cancel = jest.fn(() => ERR_BUSY);
    const sourceRoom = createSourceRoom();
    const spawn = createSpawn(sourceRoom);
    spawn.memory.spawnList = [attackerConfig, healerConfig];
    (spawn as StructureSpawn & { spawning: Spawning }).spawning = {
      name: "forming-healer",
      cancel,
    } as unknown as Spawning;

    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          reason: "npc_reservation",
          squad: "standard",
          attempts: 1,
          createdAt: 900,
          updatedAt: 999,
          statusSince: 900,
          clearSince: 981,
        },
      },
      creepConfigs: {
        [attackerConfig]: { role: "meleeAttacker", args: [...attacker.memory.roleArgs!], roomName: "E1N57" },
        [healerConfig]: { role: "healer", args: [...spawningMemory.roleArgs!], roomName: "E1N57" },
      },
    } as Memory["data"];
    Memory.creeps = { "forming-healer": spawningMemory };
    Game.rooms = { E1N57: sourceRoom, E3N57: createTargetRoom() };
    Game.spawns = { Spawn1: spawn };
    Game.creeps = { attacker };
    resetRuntimeServices();

    runWarControl();

    expect(Memory.data?.war?.E3N57).toMatchObject({
      status: "done",
      completedAt: 1000,
      assetsReleasedAt: 1000,
    });
    expect(Memory.data?.creepConfigs?.[attackerConfig]).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[healerConfig]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual([]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(attacker.memory).toMatchObject({
      role: "meleeAttacker",
      roleArgs: ["E3N57", "", "", "", healerConfig],
      _warDetached: true,
    });
    expect(attacker.memory.configName).toBeUndefined();
    expect(attacker.memory._warPartnerConfigName).toBeUndefined();
    expect(attackerSuicide).not.toHaveBeenCalled();
    expect(spawningMemory._warDetached).toBe(true);
    expect(spawningMemory.configName).toBeUndefined();
    expect(spawningMemory._warPartnerConfigName).toBeUndefined();
  });

  it("fails an exhausted one-shot generation instead of leaving it deployed forever", () => {
    const attackerConfig = "E1N57:war:E3N57:g1:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:g1:healer:0";
    const attacker = createWarCreep("attacker", "meleeAttacker", attackerConfig, "E3N57");
    attacker.memory._warPartnerConfigName = healerConfig;
    attacker.memory.roleArgs = ["E3N57", "", "war:E1N57:E3N57:g1", "boosts", healerConfig];
    attacker.suicide = jest.fn(() => OK);
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          reason: "manual",
          squad: "t3Duo",
          boostTier: "t3",
          oneShot: true,
          attempts: 1,
          createdAt: 900,
          updatedAt: 999,
          activeGeneration: {
            id: 1,
            phase: "deployed",
            createdAt: 900,
            deployedAt: 950,
            boostTaskId: "war:E1N57:E3N57:g1",
            configNames: { meleeAttacker: attackerConfig, healer: healerConfig },
          },
        },
      },
      creepConfigs: {
        [attackerConfig]: { role: "meleeAttacker", args: [...attacker.memory.roleArgs!], roomName: "E1N57" },
        [healerConfig]: { role: "healer", args: [], roomName: "E1N57" },
      },
    } as Memory["data"];
    Game.rooms = { E1N57: createSourceRoom() };
    Game.creeps = { attacker };
    resetRuntimeServices();

    runWarControl();

    expect(Memory.data?.war?.E3N57).toMatchObject({
      status: "failed",
      failReason: "generation_exhausted",
      completedAt: 1000,
      assetsReleasedAt: 1000,
    });
    expect(attacker.memory._warDetached).toBe(true);
    expect(attacker.memory.configName).toBeUndefined();
    expect(attacker.memory._warPartnerConfigName).toBeUndefined();
    expect(Memory.data?.war?.E3N57?.activeGeneration?.id).toBe(1);
  });

  it("replaces an exhausted reusable generation with a monotonically newer generation", () => {
    const attackerConfig = "E1N57:war:E3N57:g1:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:g1:healer:0";
    const attacker = createWarCreep("attacker", "meleeAttacker", attackerConfig, "E3N57");
    attacker.memory._warPartnerConfigName = healerConfig;
    attacker.suicide = jest.fn(() => OK);
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          reason: "manual",
          squad: "t3Duo",
          boostTier: "t3",
          oneShot: false,
          attempts: 1,
          createdAt: 900,
          updatedAt: 999,
          generationCounter: 1,
          activeGeneration: {
            id: 1,
            phase: "deployed",
            createdAt: 900,
            deployedAt: 950,
            boostTaskId: "war:E1N57:E3N57:g1",
            configNames: { meleeAttacker: attackerConfig, healer: healerConfig },
          },
        },
      },
      creepConfigs: {
        [attackerConfig]: { role: "meleeAttacker", args: ["E3N57"], roomName: "E1N57" },
        [healerConfig]: { role: "healer", args: ["E3N57"], roomName: "E1N57" },
      },
    } as Memory["data"];
    Game.rooms = { E1N57: createSourceRoom() };
    Game.creeps = { attacker };
    resetRuntimeServices();

    runWarControl();

    expect(Memory.data?.war?.E3N57).toMatchObject({
      status: "clearing",
      generationCounter: 2,
      activeGeneration: { id: 2, phase: "preparing" },
    });
    expect(attacker.memory._warDetached).toBe(true);
    expect(attacker.memory.configName).toBeUndefined();
    expect(attacker.memory._warPartnerConfigName).toBeUndefined();
    expect(Memory.data?.war?.E3N57?.completedAt).toBeUndefined();
  });
});
