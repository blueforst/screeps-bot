jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
  isOffensiveWarCreep: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set()),
}));

import { getEnergyStoreTarget, pickupEnergyFromPreferredTarget } from "@/roles/energyTargets";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState, getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { clearPickupReservationStoreForTest, getPickupReservationsByRoom } from "@/runtime/energyPickupReservation";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { resetPowerCreepControlCacheForTest } from "@/runtime/powerCreepControl";
import { clearSpawnActiveCacheForTest } from "@/runtime/tickContext";

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getProtoStorageContainer: jest.fn(() => null),
  getProtoControllerLinkContainer: jest.fn(() => null),
}));

const { getProtoStorageContainer, getProtoControllerLinkContainer } = jest.requireMock("@/runtime/roomPlannerConstruction") as {
  getProtoStorageContainer: jest.Mock;
  getProtoControllerLinkContainer: jest.Mock;
};

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createStore(used: number, capacity: number) {
  return {
    getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? used : 0),
    getFreeCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? capacity - used : 0),
    getCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? capacity : 0),
  };
}

function createPos(x: number, roomName = "W1N1"): RoomPosition {
  return {
    x,
    y: 25,
    roomName,
    getRangeTo: (target: RoomPosition) => Math.abs(x - target.x),
  } as unknown as RoomPosition;
}

function createRoom(options: {
  name?: string;
  myStructures?: Structure<StructureConstant>[];
  structures?: Structure<StructureConstant>[];
  dropped?: Resource[];
  tombstones?: Tombstone[];
  ruins?: Ruin[];
  storage?: StructureStorage | null;
  terminal?: StructureTerminal | null;
  controller?: StructureController | null;
} = {}): Room {
  const name = options.name ?? "W1N1";
  const memory = {} as RoomMemory;
  Memory.rooms[name] = memory;

  return {
    name,
    memory,
    controller: options.controller ?? null,
    storage: options.storage ?? null,
    terminal: options.terminal ?? null,
    find(type: FindConstant) {
      if (type === FIND_MY_STRUCTURES) {
        return options.myStructures ?? [];
      }

      if (type === FIND_STRUCTURES) {
        return options.structures ?? [];
      }

      if (type === FIND_DROPPED_RESOURCES) {
        return options.dropped ?? [];
      }

      if (type === FIND_TOMBSTONES) {
        return options.tombstones ?? [];
      }

      if (type === FIND_RUINS) {
        return options.ruins ?? [];
      }

      return [];
    },
  } as Room;
}

function createCreep(room: Room): Creep {
  return {
    name: "Worker1",
    room,
    memory: {},
    pos: createPos(25, room.name),
    store: {
      getCapacity: () => 50,
      getFreeCapacity: () => 50,
      getUsedCapacity: () => 0,
    } as StoreDefinition,
    pickup: jest.fn(() => OK),
    withdraw: jest.fn(() => OK),
  } as unknown as Creep;
}

describe("energyTargets", () => {
  beforeEach(() => {
    clearCreepAssignmentStateForTest();
    clearPickupReservationStoreForTest();
    resetRuntimeServices();
    Game.time += 1;
    (isDefenseMode as jest.Mock).mockReturnValue(false);
    (getSafeZone as jest.Mock).mockReturnValue(new Set());
    getProtoStorageContainer.mockReset();
    getProtoStorageContainer.mockReturnValue(null);
    getProtoControllerLinkContainer.mockReset();
    getProtoControllerLinkContainer.mockReturnValue(null);
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {};
    resetPowerCreepControlCacheForTest();
    clearSpawnActiveCacheForTest();
  });

  it("按技能动态跳过 Spawn，但 PC 未接管时保留 Extension 回退", () => {
    const roomName = "W2N2";
    const spawn = {
      id: "dynamic-spawn",
      structureType: STRUCTURE_SPAWN,
      pos: createPos(3, roomName),
      store: createStore(0, 300),
    } as unknown as StructureSpawn;
    const extension = {
      id: "dynamic-extension",
      structureType: STRUCTURE_EXTENSION,
      pos: createPos(4, roomName),
      store: createStore(0, 50),
    } as unknown as StructureExtension;
    const powerSpawn = {
      id: "dynamic-power-spawn",
      structureType: STRUCTURE_POWER_SPAWN,
      pos: createPos(2, roomName),
      store: createStore(0, 5_000),
    } as unknown as StructurePowerSpawn;
    const controller = {
      my: true,
      level: 8,
      isPowerEnabled: false,
    } as StructureController;
    const room = createRoom({
      name: roomName,
      controller,
      myStructures: [
        spawn as unknown as Structure<StructureConstant>,
        extension as unknown as Structure<StructureConstant>,
        powerSpawn as unknown as Structure<StructureConstant>,
      ],
    });
    Game.rooms[room.name] = room;
    const powerCreep = {
      name: "not-hardcoded",
      memory: { homeRoom: room.name },
      powers: {
        [PWR_OPERATE_EXTENSION]: { level: 1, cooldown: 0 },
      },
    } as unknown as PowerCreep;
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {
      [powerCreep.name]: powerCreep,
    };

    expect(getEnergyStoreTarget(createCreep(room))?.id).toBe(extension.id);
  });

  it("PC 已接管后同时跳过 Spawn、Extension 和普通 PowerSpawn 供能", () => {
    const roomName = "W3N3";
    const spawn = {
      id: "controlled-spawn",
      structureType: STRUCTURE_SPAWN,
      pos: createPos(3, roomName),
      store: createStore(0, 300),
    } as unknown as StructureSpawn;
    const extension = {
      id: "controlled-extension",
      structureType: STRUCTURE_EXTENSION,
      pos: createPos(4, roomName),
      store: createStore(0, 50),
    } as unknown as StructureExtension;
    const powerSpawn = {
      id: "controlled-power-spawn",
      structureType: STRUCTURE_POWER_SPAWN,
      pos: createPos(2, roomName),
      store: createStore(0, 5_000),
    } as unknown as StructurePowerSpawn;
    const storage = {
      id: "controlled-storage",
      structureType: STRUCTURE_STORAGE,
      pos: createPos(10, roomName),
      store: createStore(100_000, 1_000_000),
    } as unknown as StructureStorage;
    const controller = {
      my: true,
      level: 8,
      isPowerEnabled: true,
    } as StructureController;
    const room = createRoom({
      name: roomName,
      controller,
      storage,
      myStructures: [
        spawn as unknown as Structure<StructureConstant>,
        extension as unknown as Structure<StructureConstant>,
        powerSpawn as unknown as Structure<StructureConstant>,
      ],
    });
    Game.rooms[room.name] = room;
    const powerCreep = {
      name: "healthy-controller",
      memory: { homeRoom: room.name, lastControlTick: Game.time },
      room,
      ticksToLive: 1_000,
      powers: {
        [PWR_OPERATE_EXTENSION]: { level: 1, cooldown: 0 },
      },
    } as unknown as PowerCreep;
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {
      [powerCreep.name]: powerCreep,
    };

    expect(getEnergyStoreTarget(createCreep(room))?.id).toBe(storage.id);
  });

  it("所有 active Spawn 都在生产时，优先补给低于 60% 的 Tower 而不是预填 Extension", () => {
    const roomName = "W4N4";
    const myStructures: Structure<StructureConstant>[] = [];
    const room = createRoom({ name: roomName, myStructures });
    const busySpawn = {
      id: "busy-spawn-for-tower",
      name: "BusySpawnForTower",
      structureType: STRUCTURE_SPAWN,
      room,
      pos: createPos(3, roomName),
      store: createStore(300, 300),
      spawning: { name: "next-creep" },
      isActive: jest.fn(() => true),
    } as unknown as StructureSpawn;
    const extension = {
      id: "empty-extension-before-tower",
      structureType: STRUCTURE_EXTENSION,
      pos: createPos(4, roomName),
      store: createStore(0, 50),
    } as unknown as StructureExtension;
    const tower = {
      id: "critical-tower-behind-extension",
      structureType: STRUCTURE_TOWER,
      pos: createPos(8, roomName),
      store: createStore(600, 1_000),
    } as unknown as StructureTower;
    myStructures.push(
      busySpawn as unknown as Structure<StructureConstant>,
      extension as unknown as Structure<StructureConstant>,
      tower as unknown as Structure<StructureConstant>,
    );
    Game.rooms[room.name] = room;
    Game.spawns = { [busySpawn.name]: busySpawn };

    expect(getEnergyStoreTarget(createCreep(room))?.id).toBe(tower.id);
  });

  it("所有 active Spawn 都在生产且无 Tower 时，优先直接补给未接管的 PowerSpawn", () => {
    const roomName = "W5N5";
    const myStructures: Structure<StructureConstant>[] = [];
    const room = createRoom({ name: roomName, myStructures });
    const busySpawn = {
      id: "busy-spawn-for-power-spawn",
      name: "BusySpawnForPowerSpawn",
      structureType: STRUCTURE_SPAWN,
      room,
      pos: createPos(3, roomName),
      store: createStore(300, 300),
      spawning: { name: "next-creep" },
      isActive: jest.fn(() => true),
    } as unknown as StructureSpawn;
    const extension = {
      id: "empty-extension-before-power-spawn",
      structureType: STRUCTURE_EXTENSION,
      pos: createPos(4, roomName),
      store: createStore(0, 50),
    } as unknown as StructureExtension;
    const powerSpawn = {
      id: "direct-power-spawn",
      structureType: STRUCTURE_POWER_SPAWN,
      pos: createPos(8, roomName),
      store: createStore(0, 5_000),
    } as unknown as StructurePowerSpawn;
    myStructures.push(
      busySpawn as unknown as Structure<StructureConstant>,
      extension as unknown as Structure<StructureConstant>,
      powerSpawn as unknown as Structure<StructureConstant>,
    );
    Game.rooms[room.name] = room;
    Game.spawns = { [busySpawn.name]: busySpawn };

    expect(getEnergyStoreTarget(createCreep(room))?.id).toBe(powerSpawn.id);
  });

  it("至少一个 active Spawn 空闲时，仍优先预填 Spawn 或 Extension", () => {
    const roomName = "W6N6";
    const myStructures: Structure<StructureConstant>[] = [];
    const room = createRoom({ name: roomName, myStructures });
    const busySpawn = {
      id: "partly-busy-spawn",
      name: "PartlyBusySpawn",
      structureType: STRUCTURE_SPAWN,
      room,
      pos: createPos(3, roomName),
      store: createStore(300, 300),
      spawning: { name: "next-creep" },
      isActive: jest.fn(() => true),
    } as unknown as StructureSpawn;
    const idleSpawn = {
      id: "idle-active-spawn",
      name: "IdleActiveSpawn",
      structureType: STRUCTURE_SPAWN,
      room,
      pos: createPos(5, roomName),
      store: createStore(300, 300),
      spawning: null,
      isActive: jest.fn(() => true),
    } as unknown as StructureSpawn;
    const extension = {
      id: "extension-for-idle-window",
      structureType: STRUCTURE_EXTENSION,
      pos: createPos(4, roomName),
      store: createStore(0, 50),
    } as unknown as StructureExtension;
    const tower = {
      id: "tower-after-idle-window",
      structureType: STRUCTURE_TOWER,
      pos: createPos(8, roomName),
      store: createStore(600, 1_000),
    } as unknown as StructureTower;
    myStructures.push(
      busySpawn as unknown as Structure<StructureConstant>,
      idleSpawn as unknown as Structure<StructureConstant>,
      extension as unknown as Structure<StructureConstant>,
      tower as unknown as Structure<StructureConstant>,
    );
    Game.rooms[room.name] = room;
    Game.spawns = {
      [busySpawn.name]: busySpawn,
      [idleSpawn.name]: idleSpawn,
    };

    expect(getEnergyStoreTarget(createCreep(room))?.id).toBe(extension.id);
  });

  it("inactive Spawn 不会被当成空闲生产能力，active Spawn 全忙时仍优先 Tower", () => {
    const roomName = "W7N7";
    const myStructures: Structure<StructureConstant>[] = [];
    const room = createRoom({ name: roomName, myStructures });
    const busySpawn = {
      id: "only-active-busy-spawn",
      name: "OnlyActiveBusySpawn",
      structureType: STRUCTURE_SPAWN,
      room,
      pos: createPos(3, roomName),
      store: createStore(300, 300),
      spawning: { name: "next-creep" },
      isActive: jest.fn(() => true),
    } as unknown as StructureSpawn;
    const inactiveIdleSpawn = {
      id: "inactive-idle-spawn",
      name: "InactiveIdleSpawn",
      structureType: STRUCTURE_SPAWN,
      room,
      pos: createPos(5, roomName),
      store: createStore(300, 300),
      spawning: null,
      isActive: jest.fn(() => false),
    } as unknown as StructureSpawn;
    const extension = {
      id: "extension-behind-inactive-spawn",
      structureType: STRUCTURE_EXTENSION,
      pos: createPos(4, roomName),
      store: createStore(0, 50),
    } as unknown as StructureExtension;
    const tower = {
      id: "tower-with-inactive-idle-spawn",
      structureType: STRUCTURE_TOWER,
      pos: createPos(8, roomName),
      store: createStore(600, 1_000),
    } as unknown as StructureTower;
    myStructures.push(
      busySpawn as unknown as Structure<StructureConstant>,
      inactiveIdleSpawn as unknown as Structure<StructureConstant>,
      extension as unknown as Structure<StructureConstant>,
      tower as unknown as Structure<StructureConstant>,
    );
    Game.rooms[room.name] = room;
    Game.spawns = {
      [busySpawn.name]: busySpawn,
      [inactiveIdleSpawn.name]: inactiveIdleSpawn,
    };

    expect(getEnergyStoreTarget(createCreep(room))?.id).toBe(tower.id);
  });

  it("picks up dropped energy from the preferred candidate list", () => {
    const dropped = {
      id: "drop-1",
      amount: 100,
      resourceType: RESOURCE_ENERGY,
      pos: { x: 3, y: 25, roomName: "W1N1" },
    } as Resource;
    const room = createRoom({
      dropped: [dropped],
      structures: [],
      tombstones: [],
      ruins: [],
    });
    Game.rooms[room.name] = room;
    const creep = createCreep(room);

    expect(pickupEnergyFromPreferredTarget(creep)).toEqual({
      picked: true,
      outOfRange: false,
    });
    expect(creep.pickup).toHaveBeenCalledWith(dropped);
  });

  it("prefers the proto storage container before the proto controller container", () => {
    const protoStorage = {
      id: "proto-storage-1",
      structureType: STRUCTURE_CONTAINER,
      pos: createPos(7),
      store: createStore(200, 2000),
    } as unknown as StructureContainer;
    const protoController = {
      id: "proto-controller-1",
      structureType: STRUCTURE_CONTAINER,
      pos: createPos(8),
      store: createStore(200, 2000),
    } as unknown as StructureContainer;
    const room = createRoom({
      storage: null,
      terminal: null,
      myStructures: [],
    });
    Game.rooms[room.name] = room;
    getProtoStorageContainer.mockReturnValue(protoStorage);
    getProtoControllerLinkContainer.mockReturnValue(protoController);
    const creep = createCreep(room);

    expect(getEnergyStoreTarget(creep)?.id).toBe(protoStorage.id);
  });
});
