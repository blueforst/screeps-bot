import { getWarStatus, runWarControl, startWarPatrol, startWarRoom, stopWarRoom } from "@/runtime/warControl";
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
