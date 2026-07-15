import { getWarStatus, runWarControl, startWarRoom, stopWarRoom } from "@/runtime/warControl";
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

  it("migrates an empty legacy T3 task into generation one without queuing before boosts are ready", () => {
    setupWarBoostRoom(0);

    runWarControl();

    const task = Memory.data!.war!.E3N57;
    expect(task.activeGeneration).toMatchObject({ id: 1, phase: "preparing" });
    expect(task.activeGeneration?.boostGateOpenedAt).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual([]);
  });

  it("waits for boost labs reserved by another war instead of failing permanently", () => {
    const waitingLabs = [
      createBoostLab("lab-tough", RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 600),
      createBoostLab("lab-attack", RESOURCE_CATALYZED_UTRIUM_ACID, 900),
    ];
    const waitingRoom = createSourceRoom(waitingLabs);
    const waitingSpawn = createSpawn(waitingRoom);
    Game.rooms.E1N57 = waitingRoom;
    Game.spawns.Spawn1 = waitingSpawn;
    Game.getObjectById = jest.fn((id: string) =>
      waitingLabs.find((lab) => lab.id === id) ?? null
    ) as typeof Game.getObjectById;

    runWarControl();

    const waitingTask = Memory.data!.war!.E3N57;
    expect(waitingTask.status).toBe("staging");
    expect(waitingTask.boostStatus).toBe("preparing");
    expect(waitingTask.failReason).toBe("insufficient_labs");
    expect(waitingTask.activeGeneration).toMatchObject({ id: 1, phase: "preparing" });
    expect(waitingSpawn.memory.spawnList).toEqual([]);

    Game.time += MAX_STAGING_TICKS_FOR_TEST + 1;
    runWarControl();

    expect(Memory.data!.war!.E3N57!.status).toBe("staging");
  });

  it("runs only one active frontline per source room and queues the rest", () => {
    Memory.data!.war!.E3N53 = {
      targetRoom: "E3N53",
      sourceRoom: "E1N57",
      status: "staging",
      reason: "manual",
      squad: "t3Duo",
      boostTier: "t3",
      attempts: 1,
      createdAt: Game.time + 1,
      updatedAt: Game.time + 1,
    };
    const { spawn } = setupWarBoostRoom();

    runWarControl();

    expect(Memory.data!.war!.E3N57).toMatchObject({
      status: "staging",
      activeGeneration: { id: 1, phase: "assembling" },
    });
    expect(Memory.data!.war!.E3N53).toMatchObject({ status: "queued" });
    expect(Memory.data!.war!.E3N53!.activeGeneration).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(expect.arrayContaining([
      "E1N57:war:E3N57:g1:meleeAttacker:0",
      "E1N57:war:E3N57:g1:healer:0",
    ]));
    expect(spawn.memory.spawnList.some((configName) => configName.includes(":E3N53:"))).toBe(false);
    expect(Memory.analytics!.war!.tasks.E3N53.status).toBe("queued");
  });

  it("activates the next queued frontline after the current target is done", () => {
    Memory.data!.war!.E3N57!.status = "done";
    Memory.data!.war!.E3N53 = {
      targetRoom: "E3N53",
      sourceRoom: "E1N57",
      status: "queued",
      reason: "manual",
      squad: "t3Duo",
      boostTier: "t3",
      attempts: 1,
      createdAt: Game.time + 1,
      updatedAt: Game.time + 1,
      statusSince: Game.time,
    };
    const { spawn } = setupWarBoostRoom();

    runWarControl();

    expect(Memory.data!.war!.E3N53).toMatchObject({
      status: "staging",
      activeGeneration: { id: 1, phase: "assembling" },
    });
    expect(spawn.memory.spawnList).toEqual(expect.arrayContaining([
      "E1N57:war:E3N53:g1:meleeAttacker:0",
      "E1N57:war:E3N53:g1:healer:0",
    ]));
  });

  it("opens generation one once and queues generation-scoped configs", () => {
    const { spawn } = setupWarBoostRoom();

    runWarControl();

    const task = Memory.data!.war!.E3N57;
    expect(task.activeGeneration).toMatchObject({ id: 1, phase: "assembling" });
    expect(task.activeGeneration?.boostGateOpenedAt).toBe(Game.time);
    expect(spawn.memory.spawnList).toEqual(expect.arrayContaining([
      "E1N57:war:E3N57:g1:meleeAttacker:0",
      "E1N57:war:E3N57:g1:healer:0",
    ]));
    expect(Memory.analytics?.war?.tasks.E3N57).toEqual(expect.objectContaining({
      generationId: 1,
      generationPhase: "assembling",
      boostGateOpen: true,
      generationAge: 0,
      deployedAge: 0,
    }));
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
    const attacker = configs["E1N57:war:E3N57:g1:meleeAttacker:0"];
    const healer = configs["E1N57:war:E3N57:g1:healer:0"];

    expect(configs["E1N57:war:E3N57:meleeAttacker:1"]).toBeUndefined();
    expect(configs["E1N57:war:E3N57:healer:1"]).toBeUndefined();
    expect(attacker.args).toEqual([
      "E3N57",
      "",
      "war:E1N57:E3N57:g1",
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
      "E1N57:war:E3N57:g1:healer:0",
      "E1N57:war:E3N57:g1:meleeAttacker:0",
    ]);
    expect(attacker.spawnOnce?.queuedAt).toBeUndefined();
  });

  it("starts a manual one-shot T3 duo by default", () => {
    Memory.data = {} as Memory["data"];

    const result = startWarRoom("E3N57", "E1N57");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      targetRoom: "E3N57",
      sourceRoom: "E1N57",
      squad: "t3Duo",
      boostTier: "t3",
      oneShot: true,
    }));
    expect(Memory.data?.war?.E3N57).toEqual(expect.objectContaining({
      reason: "manual",
      squad: "t3Duo",
      boostTier: "t3",
      oneShot: true,
    }));
  });

  it("does not requeue one-shot war configs after their first queue", () => {
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "staging",
          reason: "manual",
          squad: "t3Duo",
          boostTier: "t3",
          oneShot: true,
          attempts: 1,
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];
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

    expect(spawn.memory.spawnList).toEqual([
      "E1N57:war:E3N57:g1:healer:0",
      "E1N57:war:E3N57:g1:meleeAttacker:0",
    ]);
    expect(Memory.data?.creepConfigs?.["E1N57:war:E3N57:g1:meleeAttacker:0"].spawnOnce?.queuedAt).toBe(Game.time);

    spawn.memory.spawnList = [];
    Game.time += 1;
    runWarControl();

    expect(spawn.memory.spawnList).toEqual([]);
    expect(Memory.data?.creepConfigs?.["E1N57:war:E3N57:g1:meleeAttacker:0"].spawnOnce?.queuedAt).toBe(1000);
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
        reason: "powerBankBoost:war:E1N57:E3N57:g1",
      }),
    ]);
  });

  it("migrates queued legacy combat configs into generation zero without closing their boost gate", () => {
    const labs = [
      createBoostLab("lab-tough", RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 600),
      createBoostLab("lab-attack", RESOURCE_CATALYZED_UTRIUM_ACID, 0),
      createBoostLab("lab-heal", RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, 600),
      createBoostLab("lab-move", RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, 540),
    ];
    const sourceRoom = createSourceRoom(labs);
    const spawn = createSpawn(sourceRoom);
    const attackerConfig = "E1N57:war:E3N57:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:healer:0";
    spawn.memory.spawnList = [attackerConfig, healerConfig];
    Memory.data!.creepConfigs = {
      [attackerConfig]: { role: "meleeAttacker", args: ["E3N57"], roomName: "E1N57" },
      [healerConfig]: { role: "healer", args: ["E3N57"], roomName: "E1N57" },
    };
    Game.rooms.E1N57 = sourceRoom;
    Game.rooms.E2N57 = createDonorRoom("E2N57", { [RESOURCE_CATALYZED_UTRIUM_ACID]: 900 });
    Game.spawns.Spawn1 = spawn;
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) =>
      labs.find((lab) => lab.id === id) ?? null
    ) as Game["getObjectById"];

    runWarControl();

    expect((Memory.data?.war?.E3N57 as WarTaskWithBoostState | undefined)?.boostStatus).toBe("preparing");
    expect(Memory.data?.war?.E3N57?.activeGeneration).toMatchObject({
      id: 0,
      phase: "assembling",
      boostGateOpenedAt: Game.time,
      configNames: { meleeAttacker: attackerConfig, healer: healerConfig },
    });
    expect(spawn.memory.spawnList).toEqual([attackerConfig, healerConfig]);
    expect(Memory.data?.creepConfigs?.[attackerConfig]).toBeDefined();
    expect(Memory.data?.creepConfigs?.[healerConfig]).toBeDefined();
  });

  it("migrates a live legacy attacker and queued healer into generation zero", () => {
    const sourceRoom = createSourceRoom([]);
    const spawn = createSpawn(sourceRoom);
    const attackerConfig = "E1N57:war:E3N57:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:healer:0";
    Memory.data!.creepConfigs = {
      [attackerConfig]: { role: "meleeAttacker", args: ["E3N57"], roomName: "E1N57" },
      [healerConfig]: { role: "healer", args: ["E3N57"], roomName: "E1N57" },
    };
    Game.creeps = {
      attacker: {
        name: "attacker",
        room: sourceRoom,
        pos: new MockPos(25, 25, "E1N57") as unknown as RoomPosition,
        memory: { role: "meleeAttacker", configName: attackerConfig },
        body: [],
        hits: 5000,
        hitsMax: 5000,
        spawning: false,
      } as unknown as Creep,
    };
    spawn.memory.spawnList = [healerConfig];
    Game.rooms.E1N57 = sourceRoom;
    Game.spawns.Spawn1 = spawn;

    runWarControl();

    expect(Memory.data?.war?.E3N57?.activeGeneration).toMatchObject({
      id: 0,
      phase: "assembling",
      boostGateOpenedAt: Game.time,
      configNames: { meleeAttacker: attackerConfig, healer: healerConfig },
    });
    expect(Memory.data?.war?.E3N57?.boostStatus).toBe("preparing");
    expect(spawn.memory.spawnList).toContain(healerConfig);
    expect(Memory.data?.creepConfigs?.[healerConfig]).toBeDefined();
  });

  it("requeues only the missing generation slot before the squad departs", () => {
    const { spawn } = setupWarBoostRoom();
    runWarControl();
    const generation = Memory.data!.war!.E3N57!.activeGeneration!;
    spawn.memory.spawnList = [];
    Game.creeps = {
      healer: createWarCreep("healer", "healer", generation.configNames.healer),
    };
    Game.time += 1;

    runWarControl();

    expect(Memory.data!.war!.E3N57!.activeGeneration).toMatchObject({ id: 1, phase: "assembling" });
    expect(spawn.memory.spawnList).toEqual([generation.configNames.meleeAttacker]);
    expect(Memory.data!.creepConfigs![generation.configNames.healer]).toBeDefined();
  });

  it("keeps an opened gate while replenishing only the missing pre-departure slot", () => {
    const { spawn, labs } = setupWarBoostRoom();
    runWarControl();
    const generation = Memory.data!.war!.E3N57!.activeGeneration!;
    const attacker = createWarCreep("attacker", "meleeAttacker", generation.configNames.meleeAttacker);
    attacker.body = [
      ...Array.from({ length: 10 }, () => ({ type: TOUGH, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE })),
      ...Array.from({ length: 30 }, () => ({ type: ATTACK, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID })),
      ...Array.from({ length: 10 }, () => ({ type: MOVE, hits: 100, boost: RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE })),
    ] as BodyPartDefinition[];
    const healLab = labs.find((lab) => lab.id === "lab-heal")!;
    healLab.store = createMockStore({
      [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 0,
      [RESOURCE_ENERGY]: 0,
    }) as unknown as StructureLab["store"];
    const sourceRoom = Game.rooms.E1N57;
    sourceRoom.storage!.store = createMockStore({
      [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 600,
      [RESOURCE_ENERGY]: 100_000,
    }) as unknown as StructureStorage["store"];
    spawn.memory.spawnList = [generation.configNames.healer];
    Game.creeps = { attacker };
    Game.time += 1;

    runWarControl();

    const task = Memory.data!.war!.E3N57!;
    expect(task.activeGeneration).toMatchObject({
      id: 1,
      phase: "assembling",
      boostGateOpenedAt: 1000,
    });
    expect(task.boostStatus).toBe("preparing");
    expect(spawn.memory.spawnList).toContain(generation.configNames.healer);
    expect(listCarrierTasksByRoom("E1N57")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: [expect.objectContaining({
          resource: RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
          amount: 600,
          toId: healLab.id,
        })],
      }),
    ]));
  });

  it("detaches a deployed survivor and creates a full next generation after its partner dies", () => {
    const { spawn } = setupWarBoostRoom();
    runWarControl();
    const generation = Memory.data!.war!.E3N57!.activeGeneration!;
    const attacker = createWarCreep(
      "attacker",
      "meleeAttacker",
      generation.configNames.meleeAttacker,
      "E3N57",
    );
    const healer = createWarCreep("healer", "healer", generation.configNames.healer);
    spawn.memory.spawnList = [];
    Game.creeps = { attacker, healer };
    Game.time += 1;

    runWarControl();

    expect(Memory.data!.war!.E3N57!.activeGeneration).toMatchObject({ id: 1, phase: "deployed" });
    Game.creeps = { attacker };
    Game.time += 1;

    runWarControl();

    expect(attacker.memory._warDetached).toBe(true);
    expect(Memory.data!.war!.E3N57!.activeGeneration).toMatchObject({ id: 2, phase: "preparing" });
    expect(Memory.data!.war!.E3N57!.activeGeneration!.configNames).toEqual({
      meleeAttacker: "E1N57:war:E3N57:g2:meleeAttacker:0",
      healer: "E1N57:war:E3N57:g2:healer:0",
    });
    expect(Memory.analytics!.war!.tasks.E3N57.creeps).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "attacker", detached: true }),
    ]));
  });

  it("detaches a broken one-shot squad without creating another generation", () => {
    Memory.data!.war!.E3N57!.oneShot = true;
    const { spawn } = setupWarBoostRoom();
    runWarControl();
    const generation = Memory.data!.war!.E3N57!.activeGeneration!;
    const attacker = createWarCreep(
      "attacker",
      "meleeAttacker",
      generation.configNames.meleeAttacker,
      "E3N57",
    );
    const healer = createWarCreep("healer", "healer", generation.configNames.healer);
    spawn.memory.spawnList = [];
    Game.creeps = { attacker, healer };
    Game.time += 1;
    runWarControl();
    Game.creeps = { attacker };
    Game.time += 1;

    runWarControl();

    expect(attacker.memory._warDetached).toBe(true);
    expect(Memory.data!.war!.E3N57!.generationCounter).toBe(1);
    expect(Memory.data!.war!.E3N57!.activeGeneration).toMatchObject({ id: 1, phase: "deployed" });
    expect(Object.keys(Memory.data!.creepConfigs ?? {}).some((name) => name.includes(":g2:"))).toBe(false);
    expect(spawn.memory.spawnList.some((name) => name.includes(":g2:"))).toBe(false);
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

  it("enters controller downgrade mode and queues the largest mobile claim attacker the source room can spawn", () => {
    Memory.data!.war!.E3N57!.squad = "standard";
    Memory.data!.war!.E3N57!.boostTier = undefined;
    const sourceRoom = createSourceRoom([]);
    sourceRoom.energyCapacityAvailable = 5_600;
    const spawn = createSpawn(sourceRoom);
    Game.rooms.E1N57 = sourceRoom;
    Game.rooms.E3N57 = createTargetRoom({ ownerUsername: "enemy", controllerLevel: 8 });
    Game.spawns.Spawn1 = spawn;

    runWarControl();

    const configName = "E1N57:war:E3N57:controllerAttacker:0";
    expect(Memory.data!.war!.E3N57!.status).toBe("downgrading");
    expect(Memory.data!.creepConfigs![configName]).toMatchObject({
      role: "claimer",
      args: ["E3N57", "", "attack"],
      roomName: "E1N57",
      spawnOnce: { queuedAt: 1000 },
    });
    expect(Memory.data!.war!.E3N57!.controllerAttackerLastQueuedAt).toBe(1000);
    const body = Memory.data!.creepConfigs![configName].body ?? [];
    expect(countParts(body, CLAIM)).toBe(8);
    expect(countParts(body, MOVE)).toBe(8);
    expect(body.reduce((sum, part) => sum + BODYPART_COST[part], 0)).toBeLessThanOrEqual(5_600);
    expect(spawn.memory.spawnList).toContain(configName);

    spawn.memory.spawnList = [];
    Game.time += 1;
    runWarControl();

    expect(spawn.memory.spawnList).not.toContain(configName);

    Game.time = 1999;
    runWarControl();
    expect(spawn.memory.spawnList).not.toContain(configName);

    Game.time = 2000;
    runWarControl();
    expect(spawn.memory.spawnList).toContain(configName);
    expect(Memory.data!.war!.E3N57!.controllerAttackerLastQueuedAt).toBe(2000);
  });

  it("infers the previous controller attacker production tick during live migration", () => {
    Memory.data!.war!.E3N57!.squad = "standard";
    Memory.data!.war!.E3N57!.boostTier = undefined;
    const sourceRoom = createSourceRoom([]);
    sourceRoom.energyCapacityAvailable = 5_600;
    const spawn = createSpawn(sourceRoom);
    Game.rooms.E1N57 = sourceRoom;
    Game.rooms.E3N57 = createTargetRoom({ ownerUsername: "enemy", controllerLevel: 8 });
    Game.spawns.Spawn1 = spawn;
    Game.time = 1600;
    const configName = "E1N57:war:E3N57:controllerAttacker:0";
    const claimer = createWarCreep("claimer-1000", "claimer" as never, configName, "E3N57");
    claimer.ticksToLive = 48;
    claimer.body = [
      ...Array(8).fill(null).map(() => ({ type: CLAIM, hits: 100 })),
      ...Array(8).fill(null).map(() => ({ type: MOVE, hits: 100 })),
    ] as BodyPartDefinition[];
    Game.creeps = { [claimer.name]: claimer };

    runWarControl();

    expect(Memory.data!.war!.E3N57!.controllerAttackerLastQueuedAt).toBe(1000);
    expect(spawn.memory.spawnList).not.toContain(configName);
  });

  it.each([STRUCTURE_SPAWN, STRUCTURE_TOWER])(
    "does not dispatch the controller attacker while an enemy %s remains",
    (structureType) => {
      Memory.data!.war!.E3N57!.squad = "standard";
      Memory.data!.war!.E3N57!.boostTier = undefined;
      const sourceRoom = createSourceRoom([]);
      sourceRoom.energyCapacityAvailable = 5_600;
      const spawn = createSpawn(sourceRoom);
      const blocker = {
        structureType,
      } as Structure;
      Game.rooms.E1N57 = sourceRoom;
      Game.rooms.E3N57 = createTargetRoom({
        ownerUsername: "enemy",
        controllerLevel: 8,
        hostileStructures: [blocker],
      });
      Game.spawns.Spawn1 = spawn;

      runWarControl();

      expect(Memory.data!.war!.E3N57!.status).toBe("clearing");
      expect(Memory.data!.creepConfigs!["E1N57:war:E3N57:controllerAttacker:0"]).toBeUndefined();
      expect(spawn.memory.spawnList).not.toContain("E1N57:war:E3N57:controllerAttacker:0");
    },
  );

  it("marks a manual war done only after the enemy controller reaches level zero", () => {
    Memory.data!.war!.E3N57!.squad = "standard";
    Memory.data!.war!.E3N57!.boostTier = undefined;
    const sourceRoom = createSourceRoom([]);
    const spawn = createSpawn(sourceRoom);
    const targetRoom = createTargetRoom({ ownerUsername: "enemy", controllerLevel: 8 });
    Game.rooms.E1N57 = sourceRoom;
    Game.rooms.E3N57 = targetRoom;
    Game.spawns.Spawn1 = spawn;
    runWarControl();
    expect(Memory.data!.war!.E3N57!.status).toBe("downgrading");

    targetRoom.controller!.owner = undefined;
    targetRoom.controller!.level = 0;
    Game.time = 1001;
    runWarControl();

    expect(Memory.data!.war!.E3N57!.status).toBe("clearing");
    expect(Memory.data!.war!.E3N57!.clearSince).toBe(1001);
    expect(spawn.memory.spawnList).not.toContain("E1N57:war:E3N57:controllerAttacker:0");

    Game.time = 1020;
    runWarControl();

    expect(Memory.data!.war!.E3N57!.status).toBe("done");
    expect(Memory.data!.war!.E3N57!.completedAt).toBe(1020);
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

  it("does not expire an old task that is already clearing visible hostiles", () => {
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          statusSince: Game.time - 3000,
          reason: "manual",
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

  it("still expires a task that remains in staging past the timeout", () => {
    Memory.data!.war!.E3N57!.createdAt = Game.time - 3000;

    runWarControl();

    expect(Memory.data?.war?.E3N57?.status).toBe("failed");
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

  it("removes queued and configured members from every generation when stopping a war", () => {
    const g0Attacker = "E1N57:war:E3N57:g0:meleeAttacker:0";
    const g1Attacker = "E1N57:war:E3N57:g1:meleeAttacker:0";
    const g2Attacker = "E1N57:war:E3N57:g2:meleeAttacker:0";
    const g2Healer = "E1N57:war:E3N57:g2:healer:0";
    const boostTaskId = "war:E1N57:E3N57:g2";
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
          generationCounter: 2,
          activeGeneration: {
            id: 2,
            phase: "assembling",
            createdAt: Game.time,
            boostTaskId,
            boostGateOpenedAt: Game.time,
            configNames: { meleeAttacker: g2Attacker, healer: g2Healer },
          },
        },
      },
      creepConfigs: Object.fromEntries(
        [g0Attacker, g1Attacker, g2Attacker, g2Healer].map((name) => [
          name,
          { role: "meleeAttacker", args: ["E3N57"], roomName: "E1N57" },
        ]),
      ),
    } as Memory["data"];
    Memory.runtime = {
      powerBankBoost: {
        [boostTaskId]: {
          taskId: boostTaskId,
          sourceRoomName: "E1N57",
          labs: {},
        },
      },
    } as Memory["runtime"];
    const sourceRoom = createSourceRoom([]);
    const spawn = createSpawn(sourceRoom);
    spawn.memory.spawnList = [g0Attacker, g2Attacker, g2Healer, "worker:keep"];
    const survivor = createWarCreep("g1-survivor", "meleeAttacker", g1Attacker, "E3N57");
    survivor.memory._warDetached = true;
    survivor.suicide = jest.fn(() => OK);
    Game.rooms.E1N57 = sourceRoom;
    Game.spawns.Spawn1 = spawn;
    Game.creeps = { survivor };

    const result = stopWarRoom("E3N57");

    expect(result).toEqual(expect.objectContaining({ removedConfigs: 4, removedQueuedTasks: 3 }));
    expect(Object.keys(Memory.data!.creepConfigs ?? {}).filter((name) => name.includes(":war:E3N57:"))).toEqual([]);
    expect(spawn.memory.spawnList).toEqual(["worker:keep"]);
    expect(Memory.runtime?.powerBankBoost?.[boostTaskId]).toBeUndefined();
    expect(survivor.suicide).not.toHaveBeenCalled();
  });
});
