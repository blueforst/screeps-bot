import {
  clearCarrierTaskBoardForTest,
  listCarrierTasksByRoom,
} from "@/runtime/carrierTaskBoard";
import { resetPowerCreepControlCacheForTest } from "@/runtime/powerCreepControl";
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

function installCapability(roomName: string, level = 4): void {
  const powerCreep = {
    name: roomName,
    memory: { homeRoom: roomName },
    powers: {
      [PWR_OPERATE_EXTENSION]: { level, cooldown: 0 },
    },
  } as unknown as PowerCreep;
  (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {
    [powerCreep.name]: powerCreep,
  };
}

function createScenario(options: { roomName?: string; power?: number; energy?: number } = {}): {
  room: Room;
  powerSpawn: StructurePowerSpawn;
  powerSpawnStore: MutableStore;
  storage: StructureStorage;
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
  const room = {
    name: roomName,
    controller: { my: true, level: 8 },
    storage,
    terminal: null,
    find(type: FindConstant) {
      if (type === FIND_MY_STRUCTURES) {
        return [powerSpawn];
      }
      return [];
    },
  } as unknown as Room;
  Game.rooms[roomName] = room;
  return { room, powerSpawn, powerSpawnStore, storage };
}

describe("powerSpawnControl", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetPowerCreepControlCacheForTest();
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {};
  });

  it("仅在有 OPERATE_EXTENSION PC 的房间发布 PowerSpawn power/energy 补给任务", () => {
    const { room, powerSpawn, storage } = createScenario();
    installCapability(room.name);

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

  it("PowerSpawn 同时有至少 1 power 和 50 energy 时每 tick 自动运行", () => {
    const { room, powerSpawn } = createScenario({ power: 1, energy: 50 });
    installCapability(room.name);

    runPowerSpawnControl();

    expect(powerSpawn.processPower).toHaveBeenCalledTimes(1);
  });

  it("补给使用 20%/90% 滞回，避免任务在临界值反复出现", () => {
    const { room, powerSpawnStore } = createScenario();
    installCapability(room.name);

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

  it("没有相应技能 PC 时既不发任务也不自动运行 PowerSpawn", () => {
    const { room, powerSpawn } = createScenario({ power: 100, energy: 5_000 });

    runPowerSpawnControl();

    expect(listCarrierTasksByRoom(room.name)).toHaveLength(0);
    expect(powerSpawn.processPower).not.toHaveBeenCalled();
  });

  it("非 E4N58 房间即使具备 PC 能力和资源也不补给或运行 PowerSpawn", () => {
    const { room, powerSpawn } = createScenario({
      roomName: "E6N59",
      power: 100,
      energy: 5_000,
    });
    installCapability(room.name);

    runPowerSpawnControl();

    expect(listCarrierTasksByRoom(room.name)).toHaveLength(0);
    expect(powerSpawn.processPower).not.toHaveBeenCalled();
  });
});
