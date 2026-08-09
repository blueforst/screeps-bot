jest.mock("@/movement/pathing", () => ({
  moveToTarget: jest.fn((powerCreep: PowerCreep, target: RoomObject, range: number) =>
    powerCreep.moveTo(target, { reusePath: 5, range }),
  ),
}));

import {
  getPowerCreepRoomEnergyPolicy,
  getRegenSourceLevelForRoom,
  listPowerCreepTasks,
  resetPowerCreepControlCacheForTest,
  runPowerCreepControl,
} from "@/runtime/powerCreepControl";
import {
  clearCreepMovementStateForTest,
  ensureCreepMovementState,
  getCreepMovementState,
} from "@/movement/creepState";

type ResourceAmounts = Partial<Record<ResourceConstant, number>>;

function createStore(
  amounts: ResourceAmounts = {},
  capacities: ResourceAmounts = {},
  totalCapacity = 100,
): StoreDefinition {
  return {
    getUsedCapacity(resource?: ResourceConstant) {
      if (resource !== undefined) {
        return amounts[resource] || 0;
      }
      return Object.values(amounts).reduce((sum, amount) => sum + (amount || 0), 0);
    },
    getCapacity(resource?: ResourceConstant) {
      if (resource !== undefined && capacities[resource] !== undefined) {
        return capacities[resource] || 0;
      }
      return totalCapacity;
    },
    getFreeCapacity(resource?: ResourceConstant) {
      const capacity = resource !== undefined && capacities[resource] !== undefined
        ? capacities[resource] || 0
        : totalCapacity;
      const used = resource !== undefined
        ? amounts[resource] || 0
        : Object.values(amounts).reduce((sum, amount) => sum + (amount || 0), 0);
      return Math.max(0, capacity - used);
    },
  } as StoreDefinition;
}

function createPos(roomName: string, x: number): RoomPosition {
  return {
    x,
    y: 25,
    roomName,
    getRangeTo: () => 1,
  } as unknown as RoomPosition;
}

function createRoom(options: {
  name?: string;
  controllerPowerEnabled?: boolean;
  storage?: StructureStorage | null;
  terminal?: StructureTerminal | null;
  extensions?: StructureExtension[];
  sources?: Source[];
} = {}): { room: Room; controller: StructureController; powerSpawn: StructurePowerSpawn } {
  const name = options.name || "E4N58";
  const controller = {
    id: `${name}-controller`,
    my: true,
    level: 8,
    isPowerEnabled: options.controllerPowerEnabled ?? true,
    pos: createPos(name, 20),
  } as unknown as StructureController;
  const powerSpawn = {
    id: `${name}-power-spawn`,
    structureType: STRUCTURE_POWER_SPAWN,
    my: true,
    pos: createPos(name, 21),
    store: createStore({}, {
      [RESOURCE_ENERGY]: 5_000,
      [RESOURCE_POWER]: 100,
    }, 5_100),
  } as unknown as StructurePowerSpawn;
  const extensions = options.extensions || [];
  const sources = options.sources || [];
  const myStructures: Structure<StructureConstant>[] = [
    powerSpawn as unknown as Structure<StructureConstant>,
    ...extensions as unknown as Structure<StructureConstant>[],
  ];
  const structures: Structure<StructureConstant>[] = [
    ...myStructures,
    ...(options.storage ? [options.storage as unknown as Structure<StructureConstant>] : []),
    ...(options.terminal ? [options.terminal as unknown as Structure<StructureConstant>] : []),
  ];
  const room = {
    name,
    controller,
    storage: options.storage || null,
    terminal: options.terminal || null,
    find(type: FindConstant) {
      if (type === FIND_MY_STRUCTURES) return myStructures;
      if (type === FIND_STRUCTURES) return structures;
      if (type === FIND_SOURCES) return sources;
      return [];
    },
  } as unknown as Room;

  Game.rooms[name] = room;
  return { room, controller, powerSpawn };
}

function createStorage(roomName = "E4N58", options: {
  energy?: number;
  ops?: number;
  effects?: RoomObjectEffect[];
} = {}): StructureStorage {
  return {
    id: `${roomName}-storage`,
    structureType: STRUCTURE_STORAGE,
    pos: createPos(roomName, 22),
    effects: options.effects || [],
    store: createStore({
      [RESOURCE_ENERGY]: options.energy || 0,
      [RESOURCE_OPS]: options.ops || 0,
    }, {}, 1_000_000),
  } as unknown as StructureStorage;
}

function createSource(roomName: string, id: string, x: number): Source {
  return {
    id,
    pos: createPos(roomName, x),
    effects: [],
  } as unknown as Source;
}

function createExtension(roomName = "E4N58", energy = 0): StructureExtension {
  return {
    id: `${roomName}-extension`,
    structureType: STRUCTURE_EXTENSION,
    pos: createPos(roomName, 23),
    store: createStore({ [RESOURCE_ENERGY]: energy }, { [RESOURCE_ENERGY]: 50 }, 50),
  } as unknown as StructureExtension;
}

function createPowerCreep(options: {
  name?: string;
  room?: Room;
  ticksToLive?: number | null;
  ops?: number;
  capacity?: number;
  powers?: Partial<Record<PowerConstant, { level: number; cooldown: number }>>;
  usePowerResult?: ScreepsReturnCode;
  renewResult?: ScreepsReturnCode;
  transferResult?: ScreepsReturnCode;
  rangeToTarget?: number;
} = {}): PowerCreep {
  const usePower = jest.fn(() => options.usePowerResult ?? OK);
  const powerCreep = {
    name: options.name || "E4N58",
    memory: {},
    room: options.room,
    pos: {
      x: 10,
      y: 10,
      roomName: options.room?.name || options.name || "E4N58",
      getRangeTo: () => options.rangeToTarget ?? 1,
    } as unknown as RoomPosition,
    ticksToLive: options.ticksToLive,
    powers: options.powers || {},
    store: createStore(
      { [RESOURCE_OPS]: options.ops || 0 },
      {},
      options.capacity || 100,
    ),
    spawn: jest.fn(() => OK),
    enableRoom: jest.fn(() => OK),
    renew: jest.fn(() => options.renewResult ?? OK),
    transfer: jest.fn(() => options.transferResult ?? OK),
    usePower,
    moveTo: jest.fn(() => OK),
  } as unknown as PowerCreep;
  return powerCreep;
}

function installGameObjects(objects: Array<{ id: string }>): void {
  const byId = new Map(objects.map((object) => [object.id, object]));
  (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
    (id: string) => byId.get(id) || null,
  ) as unknown as Game["getObjectById"];
}

function installPowerCreeps(...powerCreeps: PowerCreep[]): void {
  (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = Object.fromEntries(
    powerCreeps.map((powerCreep) => [powerCreep.name, powerCreep]),
  );
  (Game as Game & { shard: Shard }).shard = { name: "shard1", type: "normal", ptr: false };
}

describe("powerCreepControl", () => {
  beforeEach(() => {
    resetPowerCreepControlCacheForTest();
    clearCreepMovementStateForTest();
    Memory.powerCreeps = {};
  });

  it("按同名拥有房间建立归属，并在未出生时从 PowerSpawn 出生", () => {
    const { powerSpawn } = createRoom({ name: "E4N58" });
    const powerCreep = createPowerCreep({
      name: "E4N58",
      ticksToLive: null,
      powers: {
        [PWR_OPERATE_EXTENSION]: { level: 4, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([powerSpawn]);

    runPowerCreepControl();

    expect(powerCreep.memory.homeRoom).toBe("E4N58");
    expect(powerCreep.spawn).toHaveBeenCalledWith(powerSpawn);
    expect(getPowerCreepRoomEnergyPolicy("E4N58")).toEqual({
      suppressSpawnSupply: true,
      suppressExtensionSupply: false,
      managePowerSpawnSupply: true,
    });
  });

  it("有寿命但当前 shard 尚无位置时跳过任务执行", () => {
    const { room, powerSpawn } = createRoom({ name: "E6N59" });
    const powerCreep = createPowerCreep({
      name: "E6N59",
      ticksToLive: 1_000,
      powers: {
        [PWR_GENERATE_OPS]: { level: 1, cooldown: 0 },
      },
    });
    powerCreep.memory.homeRoom = room.name;
    (powerCreep as PowerCreep & { pos?: RoomPosition }).pos = undefined;
    installPowerCreeps(powerCreep);
    installGameObjects([powerSpawn]);

    expect(() => runPowerCreepControl()).not.toThrow();
    expect(powerCreep.memory.lastControlTick).toBeUndefined();
    expect(powerCreep.usePower).not.toHaveBeenCalled();
  });

  it("寿命低于 200 时 renew 抢占已就绪的 GENERATE_OPS", () => {
    const { room, powerSpawn } = createRoom();
    const powerCreep = createPowerCreep({
      room,
      ticksToLive: 199,
      powers: {
        [PWR_GENERATE_OPS]: { level: 5, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([powerSpawn]);

    runPowerCreepControl();

    expect(powerCreep.renew).toHaveBeenCalledWith(powerSpawn);
    expect(powerCreep.usePower).not.toHaveBeenCalled();
    expect(listPowerCreepTasks(powerCreep).map((task) => task.type)).toEqual(["generate_ops"]);
  });

  it("OPS 接近满仓时先卸载并精确保留容量的一半", () => {
    const storage = createStorage();
    const { room, powerSpawn } = createRoom({ storage });
    const powerCreep = createPowerCreep({
      room,
      ticksToLive: 1_000,
      ops: 95,
      capacity: 100,
      powers: {
        [PWR_GENERATE_OPS]: { level: 5, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([storage, powerSpawn]);

    runPowerCreepControl();

    expect(powerCreep.transfer).toHaveBeenCalledWith(storage, RESOURCE_OPS, 45);
    expect(powerCreep.usePower).not.toHaveBeenCalled();
  });

  it("高优先技能缺少 OPS 时不会阻塞可运行的 GENERATE_OPS", () => {
    const storage = createStorage();
    const { room, powerSpawn } = createRoom({ storage });
    const powerCreep = createPowerCreep({
      room,
      ticksToLive: 1_000,
      powers: {
        [PWR_OPERATE_STORAGE]: { level: 5, cooldown: 0 },
        [PWR_GENERATE_OPS]: { level: 5, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([storage, powerSpawn]);

    runPowerCreepControl();

    expect(powerCreep.usePower).toHaveBeenCalledWith(PWR_GENERATE_OPS);
    expect(listPowerCreepTasks(powerCreep).map((task) => task.type)).toEqual(["operate_storage"]);
  });

  it("Storage 旧效果消失后的第一个可执行 tick 立即续上", () => {
    const storage = createStorage("E4N58", {
      effects: [{
        effect: PWR_OPERATE_STORAGE,
        power: PWR_OPERATE_STORAGE,
        level: 5,
        ticksRemaining: 1,
      } as RoomObjectEffect],
    });
    const { room, powerSpawn } = createRoom({ storage });
    const powerCreep = createPowerCreep({
      room,
      ticksToLive: 1_000,
      ops: 100,
      capacity: 200,
      powers: {
        [PWR_OPERATE_STORAGE]: { level: 5, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([storage, powerSpawn]);

    runPowerCreepControl();
    expect(powerCreep.usePower).not.toHaveBeenCalled();
    (storage as StructureStorage & { effects: RoomObjectEffect[] }).effects = [];
    Game.time += 1;
    runPowerCreepControl();

    expect(powerCreep.usePower).toHaveBeenCalledWith(PWR_OPERATE_STORAGE, storage);
    expect(listPowerCreepTasks(powerCreep)).toHaveLength(0);
  });

  it("REGEN_SOURCE cooldown 完成后立即入队并向仍有旧效果的下一 Source 预定位", () => {
    const roomName = "E4N58";
    const sourceA = createSource(roomName, "source-a", 10);
    const sourceB = createSource(roomName, "source-b", 40);
    (sourceA as Source & { effects: RoomObjectEffect[] }).effects = [{
      effect: PWR_REGEN_SOURCE,
      power: PWR_REGEN_SOURCE,
      level: 4,
      ticksRemaining: 50,
    } as RoomObjectEffect];
    const { room, powerSpawn } = createRoom({ sources: [sourceB, sourceA] });
    const powerCreep = createPowerCreep({
      room,
      ticksToLive: 1_000,
      ops: 100,
      capacity: 200,
      rangeToTarget: 10,
      powers: {
        [PWR_REGEN_SOURCE]: { level: 4, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([sourceA, sourceB, powerSpawn]);

    runPowerCreepControl();

    const firstTask = listPowerCreepTasks(powerCreep)[0];
    expect(firstTask).toMatchObject({ type: "regen_source", targetId: sourceA.id });
    expect(powerCreep.usePower).not.toHaveBeenCalled();
    expect(powerCreep.moveTo).toHaveBeenCalledWith(sourceA, { reusePath: 5, range: 3 });
    expect(getCreepMovementState(powerCreep)?.workAnchor).toEqual({
      x: sourceA.pos.x,
      y: sourceA.pos.y,
      roomName,
      range: 3,
    });

    Game.time += 1;
    runPowerCreepControl();

    expect(listPowerCreepTasks(powerCreep)[0]?.createdAt).toBe(firstTask.createdAt);
    expect(powerCreep.usePower).not.toHaveBeenCalled();
  });

  it("REGEN_SOURCE 在已入队 Source 的旧效果消失后首 tick 施法并轮换", () => {
    const roomName = "E4N58";
    const sourceA = createSource(roomName, "source-a", 10);
    const sourceB = createSource(roomName, "source-b", 40);
    (sourceA as Source & { effects: RoomObjectEffect[] }).effects = [{
      effect: PWR_REGEN_SOURCE,
      power: PWR_REGEN_SOURCE,
      level: 4,
      ticksRemaining: 1,
    } as RoomObjectEffect];
    const { room, powerSpawn } = createRoom({ sources: [sourceB, sourceA] });
    const powerCreep = createPowerCreep({
      room,
      ticksToLive: 1_000,
      ops: 100,
      capacity: 200,
      powers: {
        [PWR_REGEN_SOURCE]: { level: 4, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([sourceA, sourceB, powerSpawn]);

    runPowerCreepControl();
    expect(listPowerCreepTasks(powerCreep)).toHaveLength(1);
    expect(powerCreep.usePower).not.toHaveBeenCalled();

    (sourceA as Source & { effects: RoomObjectEffect[] }).effects = [];
    Game.time += 1;
    runPowerCreepControl();

    expect(powerCreep.usePower).toHaveBeenCalledWith(PWR_REGEN_SOURCE, sourceA);
    expect(listPowerCreepTasks(powerCreep)).toHaveLength(0);
    expect(powerCreep.memory.nextRegenSourceIndex).toBe(1);
    expect(getCreepMovementState(powerCreep)?.workAnchor).toBeUndefined();
  });

  it("REGEN_SOURCE 只在成功后轮换两个 Source", () => {
    const roomName = "E4N58";
    const sourceA = createSource(roomName, "source-a", 10);
    const sourceB = createSource(roomName, "source-b", 40);
    const { room, powerSpawn } = createRoom({ sources: [sourceB, sourceA] });
    const powerCreep = createPowerCreep({
      room,
      ticksToLive: 1_000,
      ops: 100,
      capacity: 200,
      powers: {
        [PWR_REGEN_SOURCE]: { level: 4, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([sourceA, sourceB, powerSpawn]);

    runPowerCreepControl();
    Game.time += 1;
    runPowerCreepControl();

    expect(powerCreep.usePower).toHaveBeenNthCalledWith(1, PWR_REGEN_SOURCE, sourceA);
    expect(powerCreep.usePower).toHaveBeenNthCalledWith(2, PWR_REGEN_SOURCE, sourceB);
    expect(powerCreep.memory.nextRegenSourceIndex).toBe(0);
  });

  it("OPERATE_EXTENSION 在 Extension 缺能时使用有能量的 Storage", () => {
    const storage = createStorage("E4N58", { energy: 100_000 });
    const extension = createExtension();
    const { room, powerSpawn } = createRoom({ storage, extensions: [extension] });
    const powerCreep = createPowerCreep({
      room,
      ticksToLive: 1_000,
      ops: 100,
      capacity: 200,
      powers: {
        [PWR_OPERATE_EXTENSION]: { level: 4, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([storage, extension, powerSpawn]);

    runPowerCreepControl();

    expect(powerCreep.usePower).toHaveBeenCalledWith(PWR_OPERATE_EXTENSION, storage);
  });
});
