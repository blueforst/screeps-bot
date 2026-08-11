import {
  clearWarRoomTask,
  getWarStatus,
  requestWarRoomClear,
  runWarControl,
  startWarPatrol,
  startWarRoom,
  stopWarRoom,
} from "@/runtime/warControl";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { listCarrierTasksByRoom } from "@/runtime/carrierTaskBoard";
import { createMockStore, MockPos } from "@mock/powerBank";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

const MAX_STAGING_TICKS_FOR_TEST = 2_500;

type WarTaskWithBoostState = NonNullable<NonNullable<Memory["data"]>["war"]>[string] & {
  boostStatus?: "preparing" | "ready" | "failed";
  boostLabs?: string[];
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createBoostLab(
  id: string,
  compound: ResourceConstant,
  amount: number,
  energy = 2_000,
): StructureLab {
  return {
    id: id as Id<StructureLab>,
    pos: new MockPos(20, 20, "E1N57") as unknown as RoomPosition,
    room: { name: "E1N57" } as Room,
    structureType: STRUCTURE_LAB,
    mineralType: compound as MineralConstant,
    mineralAmount: amount,
    store: createMockStore({ [compound]: amount, [RESOURCE_ENERGY]: energy }),
    boostCreep: jest.fn(() => OK),
  } as unknown as StructureLab;
}

function createSourceRoom(labs: StructureLab[]): Room {
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
    find: jest.fn((type: FindConstant, opts?: { filter?: (structure: Structure) => boolean }) => {
      if (type !== FIND_MY_STRUCTURES) return [];
      return opts?.filter ? labs.filter((lab) => opts.filter?.(lab as Structure)) : labs;
    }),
  } as unknown as Room;
}

function createTargetRoom(options?: {
  hostileCreeps?: Creep[];
  hostileStructures?: Structure[];
  reservationUsername?: string;
  ownerUsername?: string;
  controllerLevel?: number;
}): Room {
  return {
    name: "E3N57",
    controller: {
      my: false,
      owner: options?.ownerUsername ? { username: options.ownerUsername } : undefined,
      level: options?.controllerLevel ?? 0,
      reservation: options?.reservationUsername ? { username: options.reservationUsername, ticksToEnd: 1000 } : undefined,
    } as StructureController,
    find: jest.fn((type: FindConstant, opts?: { filter?: (value: Creep | Structure) => boolean }) => {
      const values: Array<Creep | Structure> = type === FIND_HOSTILE_CREEPS
        ? options?.hostileCreeps ?? []
        : type === FIND_HOSTILE_STRUCTURES
          ? options?.hostileStructures ?? []
          : [];
      return opts?.filter ? values.filter((value) => opts.filter?.(value)) : values;
    }),
  } as unknown as Room;
}

function createDonorRoom(roomName: string, stock: Record<string, number>): Room {
  return {
    name: roomName,
    controller: { my: true, level: 8 } as StructureController,
    terminal: {
      id: `${roomName}-terminal` as Id<StructureTerminal>,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      store: createMockStore(stock),
    } as unknown as StructureTerminal,
    find: jest.fn(() => []),
  } as unknown as Room;
}

function createSpawn(room: Room): StructureSpawn {
  const spawn = {
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

  return spawn;
}

function setupWarBoostRoom(attackAmount = 900): { spawn: StructureSpawn; labs: StructureLab[] } {
  const labs = [
    createBoostLab("lab-tough", RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 600),
    createBoostLab("lab-attack", RESOURCE_CATALYZED_UTRIUM_ACID, attackAmount),
    createBoostLab("lab-heal", RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, 600),
    createBoostLab("lab-move", RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, 540),
  ];
  const sourceRoom = createSourceRoom(labs);
  const spawn = createSpawn(sourceRoom);
  Game.rooms.E1N57 = sourceRoom;
  Game.spawns.Spawn1 = spawn;
  Game.getObjectById = jest.fn((id: string) => labs.find((lab) => lab.id === id) ?? null) as typeof Game.getObjectById;
  return { spawn, labs };
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

function countParts(body: BodyPartConstant[], part: BodyPartConstant): number {
  return body.filter((bodyPart) => bodyPart === part).length;
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

  it("dispatches the controller attacker while a dangerous hostile creep remains after spawn and towers are gone", () => {
    Memory.data!.war!.E3N57!.squad = "standard";
    Memory.data!.war!.E3N57!.boostTier = undefined;
    const sourceRoom = createSourceRoom([]);
    sourceRoom.energyCapacityAvailable = 5_600;
    const spawn = createSpawn(sourceRoom);
    const defender = {
      owner: { username: "enemy" },
      getActiveBodyparts: jest.fn((part: BodyPartConstant) => part === RANGED_ATTACK ? 8 : 0),
    } as unknown as Creep;
    Game.rooms.E1N57 = sourceRoom;
    Game.rooms.E3N57 = createTargetRoom({
      ownerUsername: "enemy",
      controllerLevel: 8,
      hostileCreeps: [defender],
    });
    Game.spawns.Spawn1 = spawn;

    runWarControl();

    const configName = "E1N57:war:E3N57:controllerAttacker:0";
    expect(Memory.data!.war!.E3N57!.status).toBe("downgrading");
    expect(Memory.data!.creepConfigs![configName]).toMatchObject({ role: "claimer" });
    expect(spawn.memory.spawnList).toContain(configName);
  });

  it("completes a defeated manual target even when a dangerous hostile creep remains", () => {
    Memory.data!.war!.E3N57!.squad = "standard";
    Memory.data!.war!.E3N57!.boostTier = undefined;
    const sourceRoom = createSourceRoom([]);
    const spawn = createSpawn(sourceRoom);
    const hostile = {
      owner: { username: "enemy" },
      getActiveBodyparts: jest.fn((part: BodyPartConstant) => part === RANGED_ATTACK ? 8 : 0),
    } as unknown as Creep;
    Game.rooms.E1N57 = sourceRoom;
    Game.rooms.E3N57 = createTargetRoom({ hostileCreeps: [hostile] });
    Game.spawns.Spawn1 = spawn;

    runWarControl();

    expect(Memory.data!.war!.E3N57!.status).toBe("clearing");
    expect(Memory.data!.war!.E3N57!.clearSince).toBe(1000);

    Game.time = 1019;
    runWarControl();

    expect(Memory.data!.war!.E3N57!.status).toBe("done");
    expect(Memory.data!.war!.E3N57!.completedAt).toBe(1019);
  });

  it("resets clear debounce when hostiles reappear", () => {
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          reason: "npc_reservation",
          attempts: 1,
          createdAt: Game.time,
          updatedAt: Game.time,
          clearSince: Game.time,
        },
      },
    } as Memory["data"];
    const hostile = { owner: { username: "enemy" } } as Creep;
    Game.rooms.E1N57 = createSourceRoom([]);
    Game.rooms.E3N57 = createTargetRoom({ hostileCreeps: [hostile] });

    Game.time = 1005;
    runWarControl();

    expect(Memory.data?.war?.E3N57?.status).toBe("clearing");
    expect(Memory.data?.war?.E3N57?.clearSince).toBeUndefined();
    expect(Memory.data?.war?.E3N57?.lastHostileSeenAt).toBe(1005);
    expect(Memory.analytics?.war?.tasks.E3N57.hostileCreeps).toBe(1);
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
    Game.rooms.E1N57 = createSourceRoom([]);
    Game.rooms.E3N57 = createTargetRoom({ hostileCreeps: [hostile] });

    runWarControl();

    expect(Memory.data?.war?.E3N57?.status).toBe("clearing");
    expect(Memory.data?.war?.E3N57?.lastHostileSeenAt).toBe(Game.time);
  });

  it("removes production configs when stopping while the current squad remains alive", () => {
    const attackerConfig = "E1N57:war:E3N57:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:healer:0";
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          reason: "manual",
          attempts: 1,
          createdAt: Game.time - 50,
          updatedAt: Game.time,
        },
      },
      creepConfigs: {
        [attackerConfig]: { role: "meleeAttacker", args: ["E3N57"], roomName: "E1N57" },
        [healerConfig]: { role: "healer", args: ["E3N57"], roomName: "E1N57" },
      },
    } as Memory["data"];
    const attackerSuicide = jest.fn(() => OK);
    const healerSuicide = jest.fn(() => OK);
    Game.creeps = {
      attacker: {
        name: "attacker",
        room: { name: "E1N57" },
        memory: { role: "meleeAttacker", configName: attackerConfig },
        suicide: attackerSuicide,
      } as unknown as Creep,
      healer: {
        name: "healer",
        room: { name: "E1N57" },
        memory: { role: "healer", configName: healerConfig },
        suicide: healerSuicide,
      } as unknown as Creep,
    };
    const sourceRoom = createSourceRoom([]);
    Game.rooms.E1N57 = sourceRoom;
    Game.spawns.Spawn1 = createSpawn(sourceRoom);

    const result = stopWarRoom("E3N57");

    expect(result).toEqual(expect.objectContaining({ removedConfigs: 2, suicidedCreeps: 0 }));
    expect(Memory.data?.creepConfigs?.[attackerConfig]).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[healerConfig]).toBeUndefined();
    expect(attackerSuicide).not.toHaveBeenCalled();
    expect(healerSuicide).not.toHaveBeenCalled();
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
    const sourceRoom = createSourceRoom([]);
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
    Game.rooms = { E1N57: createSourceRoom([]) };
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
    Game.rooms = { E1N57: createSourceRoom([]) };
    Game.creeps = { attacker };
    resetRuntimeServices();

    runWarControl();

    expect(Memory.data?.war?.E3N57).toMatchObject({
      status: "clearing",
      generationCounter: 2,
      activeGeneration: {
        id: 2,
        phase: "preparing",
      },
    });
    expect(attacker.memory._warDetached).toBe(true);
    expect(attacker.memory.configName).toBeUndefined();
    expect(attacker.memory._warPartnerConfigName).toBeUndefined();
    expect(Memory.data?.war?.E3N57?.completedAt).toBeUndefined();
  });

  it("releases the old exact owner before restarting the same target from another source", () => {
    const oldConfig = "E1N57:war:E3N57:meleeAttacker:0";
    const otherConfig = "E5N57:war:E7N57:meleeAttacker:0";
    const survivor = createWarCreep("old-attacker", "meleeAttacker", oldConfig);
    survivor.memory.roleArgs = ["E3N57", "", "", "", ""];
    survivor.suicide = jest.fn(() => OK);
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "done",
          reason: "manual",
          attempts: 1,
          createdAt: 900,
          updatedAt: 999,
          completedAt: 990,
        },
        E7N57: {
          targetRoom: "E7N57",
          sourceRoom: "E5N57",
          status: "clearing",
          reason: "manual",
          attempts: 1,
          createdAt: 900,
          updatedAt: 999,
        },
      },
      creepConfigs: {
        [oldConfig]: { role: "meleeAttacker", args: [...survivor.memory.roleArgs!], roomName: "E1N57" },
        [otherConfig]: { role: "meleeAttacker", args: ["E7N57"], roomName: "E5N57" },
      },
    } as Memory["data"];
    Game.rooms = { E1N57: createSourceRoom([]) };
    Game.creeps = { survivor };
    resetRuntimeServices();

    requestWarRoomClear("E3N57", "E2N57", { reason: "npc_reservation" });

    expect(Memory.data?.war?.E3N57).toMatchObject({ sourceRoom: "E2N57", status: "staging", attempts: 2 });
    expect(Memory.data?.creepConfigs?.[oldConfig]).toBeUndefined();
    expect(survivor.memory._warDetached).toBe(true);
    expect(survivor.memory.configName).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[otherConfig]).toBeDefined();
    expect(Memory.data?.war?.E7N57).toBeDefined();
  });

  it("uses the compatibility clear gateway to release assets before deleting the owner", () => {
    const configName = "E1N57:war:E3N57:meleeAttacker:0";
    const survivor = createWarCreep("attacker", "meleeAttacker", configName);
    survivor.suicide = jest.fn(() => OK);
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "done",
          reason: "npc_reservation",
          attempts: 1,
          createdAt: 900,
          updatedAt: 999,
          completedAt: 990,
        },
      },
      creepConfigs: {
        [configName]: { role: "meleeAttacker", args: ["E3N57"], roomName: "E1N57" },
      },
    } as Memory["data"];
    Game.rooms = { E1N57: createSourceRoom([]) };
    Game.creeps = { survivor };
    resetRuntimeServices();

    clearWarRoomTask("E3N57");

    expect(Memory.data?.war?.E3N57).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[configName]).toBeUndefined();
    expect(survivor.memory._warDetached).toBe(true);
    expect(survivor.memory.configName).toBeUndefined();
    expect(survivor.suicide).not.toHaveBeenCalled();
  });

  it("does not ensure an empty War store when clearing an absent owner", () => {
    Memory.data = undefined;
    resetRuntimeServices();

    clearWarRoomTask("E3N57");

    expect(Memory.data).toBeUndefined();
  });

  it("reconciles a legacy terminal owner once and records release evidence", () => {
    const configName = "E1N57:war:E3N57:meleeAttacker:0";
    const survivor = createWarCreep("legacy-terminal-attacker", "meleeAttacker", configName);
    survivor.memory._warPartnerConfigName = "E1N57:war:E3N57:healer:0";
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "done",
          reason: "manual",
          attempts: 1,
          createdAt: 900,
          updatedAt: 999,
          completedAt: 990,
        },
      },
      creepConfigs: {
        [configName]: { role: "meleeAttacker", args: ["E3N57"], roomName: "E1N57" },
      },
    } as Memory["data"];
    Game.rooms = { E1N57: createSourceRoom([]) };
    Game.creeps = { [survivor.name]: survivor };
    resetRuntimeServices();

    runWarControl();

    expect(Memory.data?.war?.E3N57).toMatchObject({
      status: "done",
      completedAt: 990,
      assetsReleasedAt: 1000,
    });
    expect(Memory.data?.creepConfigs?.[configName]).toBeUndefined();
    expect(survivor.memory).toMatchObject({ _warDetached: true });
    expect(survivor.memory.configName).toBeUndefined();
    expect(survivor.memory._warPartnerConfigName).toBeUndefined();
  });

  it("publishes explicit standard pair identities without pairing attacker index one", () => {
    Memory.data!.war!.E3N57!.squad = "standard";
    Memory.data!.war!.E3N57!.boostTier = undefined;
    Memory.data!.war!.E3N57!.oneShot = false;
    const sourceRoom = createSourceRoom([]);
    Game.rooms = { E1N57: sourceRoom };
    Game.spawns = { Spawn1: createSpawn(sourceRoom) };

    runWarControl();

    expect(Memory.data?.creepConfigs?.["E1N57:war:E3N57:meleeAttacker:0"]?.args).toEqual([
      "E3N57", "", "", "", "E1N57:war:E3N57:healer:0",
    ]);
    expect(Memory.data?.creepConfigs?.["E1N57:war:E3N57:meleeAttacker:1"]?.args).toEqual([
      "E3N57", "", "", "", "",
    ]);
    expect(Memory.data?.creepConfigs?.["E1N57:war:E3N57:healer:0"]?.args).toEqual([
      "E3N57", "", "", "", "E1N57:war:E3N57:meleeAttacker:0",
    ]);
  });

  it("appends exact T3 duo partners without shifting the existing Boost arguments", () => {
    setupWarBoostRoom();

    runWarControl();

    const generation = Memory.data?.war?.E3N57?.activeGeneration;
    expect(generation).toBeDefined();
    const attackerArgs = Memory.data?.creepConfigs?.[generation!.configNames.meleeAttacker]?.args;
    const healerArgs = Memory.data?.creepConfigs?.[generation!.configNames.healer]?.args;
    expect(attackerArgs?.slice(0, 4)).toEqual([
      "E3N57",
      "",
      generation!.boostTaskId,
      [
        RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
        RESOURCE_CATALYZED_UTRIUM_ACID,
      ].join("|"),
    ]);
    expect(healerArgs?.slice(0, 4)).toEqual([
      "E3N57",
      "",
      generation!.boostTaskId,
      [
        RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ].join("|"),
    ]);
    expect(attackerArgs?.[4]).toBe(generation!.configNames.healer);
    expect(healerArgs?.[4]).toBe(generation!.configNames.meleeAttacker);
  });

  it("refreshes explicit partner args on already deployed legacy T3 members", () => {
    const attackerConfig = "E1N57:war:E3N57:g1:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:g1:healer:0";
    const boostTaskId = "war:E1N57:E3N57:g1";
    const attacker = createWarCreep("attacker", "meleeAttacker", attackerConfig, "E3N57");
    const healer = createWarCreep("healer", "healer", healerConfig, "E3N57");
    attacker.owner = { username: "me" } as Owner;
    healer.owner = { username: "me" } as Owner;
    attacker.memory.roleArgs = ["E3N57", "", boostTaskId, "legacy-attacker-boosts"];
    healer.memory.roleArgs = ["E3N57", "", boostTaskId, "legacy-healer-boosts"];
    const hostile = { owner: { username: "enemy" } } as Creep;
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          reason: "npc_reservation",
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
            boostTaskId,
            configNames: { meleeAttacker: attackerConfig, healer: healerConfig },
          },
        },
      },
      creepConfigs: {},
    } as Memory["data"];
    Game.rooms = {
      E1N57: createSourceRoom([]),
      E3N57: createTargetRoom({ hostileCreeps: [hostile] }),
    };
    Game.creeps = { attacker, healer };
    resetRuntimeServices();

    runWarControl();

    expect(attacker.memory.roleArgs?.[4]).toBe(healerConfig);
    expect(healer.memory.roleArgs?.[4]).toBe(attackerConfig);
    expect(attacker.memory.roleArgs?.[2]).toBe(boostTaskId);
    expect(healer.memory.roleArgs?.[2]).toBe(boostTaskId);
  });
});

describe("war patrol", () => {
  const patrolRooms = ["E3N57", "E2N54", "E3N53"];

  function createPatrolTask(index: number, status: string = "clearing") {
    const targetRoom = patrolRooms[index];
    const attackerConfig = `E1N57:war:${patrolRooms[0]}:g1:meleeAttacker:0`;
    const healerConfig = `E1N57:war:${patrolRooms[0]}:g1:healer:0`;
    return {
      targetRoom,
      sourceRoom: "E1N57",
      status,
      reason: "manual",
      squad: "t3Duo",
      boostTier: "t3",
      oneShot: false,
      attempts: 1,
      createdAt: Game.time,
      updatedAt: Game.time,
      statusSince: Game.time,
      clearSince: status === "clearing" ? Game.time - 19 : undefined,
      generationCounter: 1,
      activeGeneration: {
        id: 1,
        phase: "deployed",
        createdAt: Game.time - 100,
        deployedAt: Game.time - 50,
        boostTaskId: `war:E1N57:${patrolRooms[0]}:g1`,
        configNames: { meleeAttacker: attackerConfig, healer: healerConfig },
      },
      patrolRooms,
      patrolIndex: index,
      patrolInterval: 1000,
      patrolNextSweepAt: status === "patrol_waiting" ? Game.time + 1000 : undefined,
    } as any;
  }

  function createNamedClearRoom(roomName: string): Room {
    const room = createTargetRoom();
    (room as Room & { name: string }).name = roomName;
    return room;
  }

  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 1000;
    Memory.runtime = {};
    Memory.data = { war: {}, creepConfigs: {} };
    Game.rooms = { E1N57: createSourceRoom([]) };
    Game.spawns = { Spawn1: createSpawn(Game.rooms.E1N57) };
    Game.creeps = {};
  });

  it("deduplicates patrol rooms and enforces the minimum interval", () => {
    const result = startWarPatrol("E1N57", ["E3N57", "E3N57", "E2N54"], { intervalTicks: 1 });

    expect(result).toMatchObject({
      ok: true,
      patrolRooms: ["E3N57", "E2N54"],
      patrolInterval: 20,
    });
  });
});
