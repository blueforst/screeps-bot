import { getWarStatus, runWarControl, stopWarRoom } from "@/runtime/warControl";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { createMockStore, MockPos } from "@mock/powerBank";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

type WarTaskWithBoostState = NonNullable<NonNullable<Memory["data"]>["war"]>[string] & {
  boostStatus?: "preparing" | "ready" | "failed";
  boostLabs?: string[];
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createBoostLab(id: string, compound: ResourceConstant, amount: number): StructureLab {
  return {
    id: id as Id<StructureLab>,
    pos: new MockPos(20, 20, "E1N57") as unknown as RoomPosition,
    room: { name: "E1N57" } as Room,
    structureType: STRUCTURE_LAB,
    mineralType: compound as MineralConstant,
    mineralAmount: amount,
    store: createMockStore({ [compound]: amount }),
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

function createTargetRoom(options?: { hostileCreeps?: Creep[]; hostileStructures?: Structure[]; reservationUsername?: string }): Room {
  return {
    name: "E3N57",
    controller: {
      my: false,
      owner: undefined,
      reservation: options?.reservationUsername ? { username: options.reservationUsername, ticksToEnd: 1000 } : undefined,
    } as StructureController,
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return options?.hostileCreeps ?? [];
      if (type === FIND_HOSTILE_STRUCTURES) return options?.hostileStructures ?? [];
      return [];
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

  it("creates a front-tough T3 duo with boosted MOVE ratio and queued configs", () => {
    const labs = [
      createBoostLab("lab-tough", RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 600),
      createBoostLab("lab-attack", RESOURCE_CATALYZED_UTRIUM_ACID, 900),
      createBoostLab("lab-heal", RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, 600),
      createBoostLab("lab-move", RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, 540),
    ];
    const sourceRoom = createSourceRoom(labs);
    const spawn = createSpawn(sourceRoom);
    Game.rooms.E1N57 = sourceRoom;
    Game.spawns.Spawn1 = spawn;
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) =>
      labs.find((lab) => lab.id === id) ?? null
    ) as Game["getObjectById"];

    runWarControl();

    const task = Memory.data?.war?.E3N57 as WarTaskWithBoostState | undefined;
    expect(task?.boostStatus).toBe("ready");
    expect(task?.boostLabs).toHaveLength(4);

    const configs = Memory.data?.creepConfigs ?? {};
    const attacker = configs["E1N57:war:E3N57:meleeAttacker:0"];
    const healer = configs["E1N57:war:E3N57:healer:0"];

    expect(configs["E1N57:war:E3N57:meleeAttacker:1"]).toBeUndefined();
    expect(configs["E1N57:war:E3N57:healer:1"]).toBeUndefined();
    expect(attacker.args).toEqual([
      "E3N57",
      "",
      "war:E1N57:E3N57",
      `${RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE}|${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}|${RESOURCE_CATALYZED_UTRIUM_ACID}`,
    ]);
    expect(healer.args[3]).toBe(
      `${RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE}|${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}|${RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE}`,
    );

    expect(attacker.body?.slice(0, 10)).toEqual(Array(10).fill(TOUGH));
    expect(countParts(attacker.body ?? [], TOUGH)).toBe(10);
    expect(countParts(attacker.body ?? [], ATTACK)).toBe(30);
    expect(countParts(attacker.body ?? [], MOVE)).toBe(10);
    expect(healer.body?.slice(0, 10)).toEqual(Array(10).fill(TOUGH));
    expect(countParts(healer.body ?? [], TOUGH)).toBe(10);
    expect(countParts(healer.body ?? [], HEAL)).toBe(20);
    expect(countParts(healer.body ?? [], MOVE)).toBe(8);

    expect(spawn.memory.spawnList).toEqual([
      "E1N57:war:E3N57:healer:0",
      "E1N57:war:E3N57:meleeAttacker:0",
    ]);
  });

  it("keeps preparing and requests cross-room transfer when a boost compound is not local", () => {
    const labs = [
      createBoostLab("lab-tough", RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 600),
      createBoostLab("lab-attack", RESOURCE_CATALYZED_UTRIUM_ACID, 0),
      createBoostLab("lab-heal", RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, 600),
      createBoostLab("lab-move", RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, 540),
    ];
    const sourceRoom = createSourceRoom(labs);
    const spawn = createSpawn(sourceRoom);
    Game.rooms.E1N57 = sourceRoom;
    Game.rooms.E2N57 = createDonorRoom("E2N57", { [RESOURCE_CATALYZED_UTRIUM_ACID]: 900 });
    Game.spawns.Spawn1 = spawn;
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) =>
      labs.find((lab) => lab.id === id) ?? null
    ) as Game["getObjectById"];

    runWarControl();

    const task = Memory.data?.war?.E3N57 as WarTaskWithBoostState | undefined;
    expect(task?.boostStatus).toBe("preparing");
    expect(Memory.data?.creepConfigs?.["E1N57:war:E3N57:meleeAttacker:0"]).toBeUndefined();

    const transferTasks = Object.values(ensureResourceTransferTaskStore());
    expect(transferTasks).toEqual([
      expect.objectContaining({
        fromRoomName: "E2N57",
        toRoomName: "E1N57",
        resource: RESOURCE_CATALYZED_UTRIUM_ACID,
        amount: 900,
        remainingAmount: 900,
        status: "pending",
        reason: "powerBankBoost:war:E1N57:E3N57",
      }),
    ]);
  });

  it("debounces a visible clear room before completing and writes war telemetry", () => {
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "staging",
          reason: "manual",
          attempts: 1,
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];
    const sourceRoom = createSourceRoom([]);
    const spawn = createSpawn(sourceRoom);
    Game.rooms.E1N57 = sourceRoom;
    Game.rooms.E3N57 = createTargetRoom();
    Game.spawns.Spawn1 = spawn;

    runWarControl();

    expect(Memory.data?.war?.E3N57?.status).toBe("clearing");
    expect(Memory.data?.war?.E3N57?.clearSince).toBe(1000);
    expect(Memory.analytics?.war?.tasks.E3N57).toEqual(
      expect.objectContaining({
        status: "clearing",
        clearTicks: 1,
        targetVisible: true,
        hostileCreeps: 0,
        hostileStructures: 0,
      }),
    );

    Game.time = 1018;
    runWarControl();

    expect(Memory.data?.war?.E3N57?.status).toBe("clearing");
    expect(Memory.analytics?.war?.tasks.E3N57.clearTicks).toBe(19);

    Game.time = 1019;
    runWarControl();

    expect(Memory.data?.war?.E3N57?.status).toBe("done");
    expect(Memory.data?.war?.E3N57?.completedAt).toBe(1019);
    expect(Memory.analytics?.war?.tasks.E3N57.status).toBe("done");
  });

  it("resets clear debounce when hostiles reappear", () => {
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          reason: "manual",
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

  it("reports war status and stops manual war production", () => {
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
        "E1N57:war:E3N57:meleeAttacker:0": { role: "meleeAttacker", args: ["E3N57"], roomName: "E1N57" },
        "E1N57:war:E3N57:healer:0": { role: "healer", args: ["E3N57"], roomName: "E1N57" },
      },
    } as Memory["data"];
    const sourceRoom = createSourceRoom([]);
    const spawn = createSpawn(sourceRoom);
    spawn.memory.spawnList = ["E1N57:war:E3N57:meleeAttacker:0", "worker:keep"];
    Game.rooms.E1N57 = sourceRoom;
    Game.spawns.Spawn1 = spawn;

    expect(getWarStatus("E3N57").tasks[0]).toEqual(
      expect.objectContaining({
        targetRoom: "E3N57",
        status: "clearing",
        queuedConfigs: ["E1N57:war:E3N57:meleeAttacker:0"],
      }),
    );

    const result = stopWarRoom("E3N57");

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        targetRoom: "E3N57",
        removedTask: true,
        removedConfigs: 2,
        removedQueuedTasks: 1,
        cancelledSpawns: 0,
        suicidedCreeps: 0,
      }),
    );
    expect(Memory.data?.war?.E3N57).toBeUndefined();
    expect(Memory.data?.creepConfigs?.["E1N57:war:E3N57:meleeAttacker:0"]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(["worker:keep"]);
    expect(Memory.analytics?.war?.tasks).toEqual({});
  });
});
