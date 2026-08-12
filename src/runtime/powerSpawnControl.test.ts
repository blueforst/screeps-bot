import {
  clearCarrierTaskBoardForTest,
  listCarrierTasksByRoom,
} from "@/runtime/carrierTaskBoard";
import {
  POWER_SPAWN_HIGH_WATER_RATIO,
  runPowerSpawnControl,
} from "@/runtime/powerSpawnControl";

type MutableStore = StoreDefinition & {
  set(resource: ResourceConstant, amount: number): void;
};

function createMutableStore(
  initial: Partial<Record<ResourceConstant, number>>,
  capacities: Partial<Record<ResourceConstant, number>>,
  totalCapacity: number,
): MutableStore {
  const amounts = { ...initial };
  return {
    set(resource: ResourceConstant, amount: number) {
      amounts[resource] = amount;
    },
    getUsedCapacity(resource?: ResourceConstant) {
      if (resource !== undefined) return amounts[resource] || 0;
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
  } as MutableStore;
}

function createScenario(options: {
  roomName?: string;
  power?: number;
  energy?: number;
  controllerMy?: boolean;
  includePowerSpawn?: boolean;
} = {}): {
  room: Room;
  powerSpawn: StructurePowerSpawn;
  powerSpawnStore: MutableStore;
  storage: StructureStorage;
  myStructures: Structure<StructureConstant>[];
} {
  const roomName = options.roomName || "E4N58";
  const powerSpawnStore = createMutableStore({
    [RESOURCE_POWER]: options.power || 0,
    [RESOURCE_ENERGY]: options.energy || 0,
  }, {
    [RESOURCE_POWER]: 100,
    [RESOURCE_ENERGY]: 5_000,
  }, 5_100);
  const powerSpawn = {
    id: `${roomName}-power-spawn`,
    structureType: STRUCTURE_POWER_SPAWN,
    store: powerSpawnStore,
    processPower: jest.fn(() => OK),
  } as unknown as StructurePowerSpawn;
  const storage = {
    id: `${roomName}-storage`,
    structureType: STRUCTURE_STORAGE,
    store: createMutableStore({
      [RESOURCE_POWER]: 1_000,
      [RESOURCE_ENERGY]: 500_000,
    }, {}, 1_000_000),
  } as unknown as StructureStorage;
  const myStructures = options.includePowerSpawn === false
    ? []
    : [powerSpawn as unknown as Structure<StructureConstant>];
  const room = {
    name: roomName,
    controller: { my: options.controllerMy ?? true, level: 8 },
    storage,
    terminal: null,
    find(type: FindConstant) {
      if (type === FIND_MY_STRUCTURES) {
        return myStructures;
      }
      return [];
    },
  } as unknown as Room;
  Game.rooms[roomName] = room;
  return { room, powerSpawn, powerSpawnStore, storage, myStructures };
}

describe("powerSpawnControl", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    Game.rooms = {};
    Game.flags = {};
    Memory.cfg = {};
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {};
  });

  it("没有 OPERATE_EXTENSION PC 的非 Hub 房间也发布 PowerSpawn power/energy 补给任务", () => {
    const { room, powerSpawn, storage } = createScenario({ roomName: "E6N59" });

    runPowerSpawnControl();

    const tasks = listCarrierTasksByRoom(room.name);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe("power_spawn_supply");
    expect(tasks[0].steps).toEqual([
      expect.objectContaining({
        resource: RESOURCE_POWER,
        fromKind: "storage",
        toKind: "power_spawn",
        fromId: storage.id,
        toId: powerSpawn.id,
      }),
      expect.objectContaining({
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "power_spawn",
        fromId: storage.id,
        toId: powerSpawn.id,
      }),
    ]);
  });

  it("非 Hub 无 PC 房间的 PowerSpawn 资源充足时每 tick 自动运行", () => {
    const { powerSpawn } = createScenario({ roomName: "E6N59", power: 1, energy: 50 });

    runPowerSpawnControl();

    expect(powerSpawn.processPower).toHaveBeenCalledTimes(1);
  });

  it("进入储备状态后停止处理 power 并清理已有补给任务", () => {
    const { room, powerSpawn } = createScenario({ roomName: "E6N59", power: 1, energy: 50 });

    runPowerSpawnControl();
    expect(powerSpawn.processPower).toHaveBeenCalledTimes(1);
    expect(listCarrierTasksByRoom(room.name)).toHaveLength(1);

    Game.flags[`RESERVE_${room.name}`] = {
      name: `RESERVE_${room.name}`,
      pos: { roomName: room.name },
    } as unknown as Flag;
    Game.time += 1;

    runPowerSpawnControl();

    expect(powerSpawn.processPower).toHaveBeenCalledTimes(1);
    expect(listCarrierTasksByRoom(room.name)).toHaveLength(0);
  });

  it("非储备状态忽略遗留 enabled=false 并自动处理 power", () => {
    const { room, powerSpawn } = createScenario({ roomName: "E5N59", power: 1, energy: 50 });
    (Memory as unknown as { cfg: Record<string, unknown> }).cfg = {
      powerSpawnControl: {
        rooms: {
          [room.name]: { enabled: false },
        },
      },
    };

    runPowerSpawnControl();

    expect(powerSpawn.processPower).toHaveBeenCalledTimes(1);
    expect(listCarrierTasksByRoom(room.name)).toHaveLength(1);
  });

  it("补给使用 20%/90% 滞回，避免任务在临界值反复出现", () => {
    const { room, powerSpawnStore } = createScenario({ roomName: "E5N59" });

    runPowerSpawnControl();
    expect(listCarrierTasksByRoom(room.name)[0].steps).toHaveLength(2);

    Game.time += 1;
    powerSpawnStore.set(RESOURCE_POWER, 50);
    powerSpawnStore.set(RESOURCE_ENERGY, 2_500);
    runPowerSpawnControl();
    expect(listCarrierTasksByRoom(room.name)[0].steps).toHaveLength(2);

    Game.time += 1;
    powerSpawnStore.set(RESOURCE_POWER, Math.ceil(100 * POWER_SPAWN_HIGH_WATER_RATIO));
    powerSpawnStore.set(RESOURCE_ENERGY, Math.ceil(5_000 * POWER_SPAWN_HIGH_WATER_RATIO));
    runPowerSpawnControl();
    expect(listCarrierTasksByRoom(room.name)).toHaveLength(0);
  });

  it("同一 tick 处理多个非储备己方 PowerSpawn 房间", () => {
    const hub = createScenario({ roomName: "E4N58", power: 1, energy: 50 });
    const nonHub = createScenario({ roomName: "E6N59", power: 1, energy: 50 });

    runPowerSpawnControl();

    expect(hub.powerSpawn.processPower).toHaveBeenCalledTimes(1);
    expect(nonHub.powerSpawn.processPower).toHaveBeenCalledTimes(1);
    expect(listCarrierTasksByRoom(hub.room.name)).toHaveLength(1);
    expect(listCarrierTasksByRoom(nonHub.room.name)).toHaveLength(1);
  });

  it("PowerSpawn 消失后清理已有补给任务", () => {
    const { room, myStructures } = createScenario({ roomName: "E6N59" });

    runPowerSpawnControl();
    expect(listCarrierTasksByRoom(room.name)).toHaveLength(1);

    myStructures.length = 0;
    Game.time += 1;

    runPowerSpawnControl();

    expect(listCarrierTasksByRoom(room.name)).toHaveLength(0);
  });

  it("非己方房间即使存在 PowerSpawn 和资源也不加工或补给", () => {
    const { room, powerSpawn } = createScenario({
      roomName: "W2N2",
      power: 100,
      energy: 5_000,
      controllerMy: false,
    });

    runPowerSpawnControl();

    expect(listCarrierTasksByRoom(room.name)).toHaveLength(0);
    expect(powerSpawn.processPower).not.toHaveBeenCalled();
  });
});
