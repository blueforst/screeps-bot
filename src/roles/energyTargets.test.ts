import { getEnergyStoreTarget, pickupEnergyFromPreferredTarget } from "@/roles/energyTargets";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState, getCreepAssignmentState } from "@/runtime/creepAssignmentState";

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
} = {}): Room {
  const name = options.name ?? "W1N1";
  const memory = {} as RoomMemory;
  Memory.rooms[name] = memory;

  return {
    name,
    memory,
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
    resetRuntimeServices();
    Game.time += 1;
    getProtoStorageContainer.mockReset();
    getProtoStorageContainer.mockReturnValue(null);
    getProtoControllerLinkContainer.mockReset();
    getProtoControllerLinkContainer.mockReturnValue(null);
  });

  it("prefers spawns and extensions over lower-priority energy sinks", () => {
    const extension = {
      id: "extension-1",
      structureType: STRUCTURE_EXTENSION,
      pos: { x: 5, y: 25, roomName: "W1N1" },
      store: createStore(0, 50),
    } as unknown as StructureExtension;
    const tower = {
      id: "tower-1",
      structureType: STRUCTURE_TOWER,
      pos: { x: 1, y: 25, roomName: "W1N1" },
      store: createStore(100, 1000),
    } as unknown as StructureTower;
    const room = createRoom({
      myStructures: [tower as unknown as Structure<StructureConstant>, extension as unknown as Structure<StructureConstant>],
    });
    Game.rooms[room.name] = room;
    const creep = createCreep(room);

    expect(getEnergyStoreTarget(creep)?.id).toBe(extension.id);
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

  it("falls back to storage even when terminal is below reserve", () => {
    const terminal = {
      id: "terminal-1",
      pos: createPos(4),
      store: createStore(5000, 300000),
    } as unknown as StructureTerminal;
    const storage = {
      id: "storage-1",
      pos: createPos(6),
      store: createStore(100000, 1000000),
    } as unknown as StructureStorage;
    const room = createRoom({
      terminal,
      storage,
      myStructures: [],
    });
    Game.rooms[room.name] = room;
    const creep = createCreep(room);

    expect(getEnergyStoreTarget(creep)?.id).toBe(storage.id);
  });

  it("falls back to storage when terminal reserve is already satisfied", () => {
    const terminal = {
      id: "terminal-2",
      pos: createPos(4),
      store: createStore(25000, 300000),
    } as unknown as StructureTerminal;
    const storage = {
      id: "storage-2",
      pos: createPos(6),
      store: createStore(100000, 1000000),
    } as unknown as StructureStorage;
    const room = createRoom({
      terminal,
      storage,
      myStructures: [],
    });
    Game.rooms[room.name] = room;
    const creep = createCreep(room);

    expect(getEnergyStoreTarget(creep)?.id).toBe(storage.id);
  });

  it("falls back to the proto controller container when storage targets are unavailable", () => {
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
    getProtoControllerLinkContainer.mockReturnValue(protoController);
    const creep = createCreep(room);

    expect(getEnergyStoreTarget(creep)?.id).toBe(protoController.id);
  });

  it("clears stale reservation memory when renewing a reserved target fails", () => {
    const container = {
      id: "container-1",
      structureType: STRUCTURE_CONTAINER,
      pos: createPos(3),
      store: createStore(40, 2000),
    } as unknown as StructureContainer;
    const room = createRoom({
      structures: [container as unknown as Structure<StructureConstant>],
    });
    Game.rooms[room.name] = room;
    Memory.rooms[room.name].pickupReservations = {
      [container.id]: {
        kind: "structure",
        claims: {
          Worker1: { amount: 20, until: Game.time + 10 },
          Worker2: { amount: 40, until: Game.time + 10 },
        },
      },
    };
    Game.creeps.Worker1 = { name: "Worker1" } as Creep;
    Game.creeps.Worker2 = { name: "Worker2" } as Creep;

    const getObjectById = jest.fn((id: string) => (id === container.id ? container : null)) as unknown as Game["getObjectById"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = getObjectById;

    const creep = createCreep(room);
    const assignmentState = ensureCreepAssignmentState(creep.name);
    assignmentState.energyPickupTargetId = container.id;
    assignmentState.energyPickupTargetKind = "structure";
    assignmentState.energyPickupRoomName = room.name;

    expect(pickupEnergyFromPreferredTarget(creep)).toEqual({
      picked: false,
      outOfRange: false,
    });
    expect(getCreepAssignmentState(creep.name)?.energyPickupTargetId).toBeUndefined();
    expect(getCreepAssignmentState(creep.name)?.energyPickupTargetKind).toBeUndefined();
    expect(getCreepAssignmentState(creep.name)?.energyPickupRoomName).toBeUndefined();
    expect(Memory.rooms[room.name].pickupReservations?.[container.id]?.claims.Worker1).toBeUndefined();
  });

  it("skips proto storage containers when workers choose pickup targets", () => {
    const protoStorage = {
      id: "proto-storage-1",
      structureType: STRUCTURE_CONTAINER,
      pos: createPos(3),
      store: createStore(200, 2000),
    } as unknown as StructureContainer;
    const normalContainer = {
      id: "container-2",
      structureType: STRUCTURE_CONTAINER,
      pos: createPos(5),
      store: createStore(200, 2000),
    } as unknown as StructureContainer;
    const room = createRoom({
      structures: [protoStorage as unknown as Structure<StructureConstant>, normalContainer as unknown as Structure<StructureConstant>],
    });
    Game.rooms[room.name] = room;
    getProtoStorageContainer.mockReturnValue(protoStorage);
    const creep = createCreep(room);

    expect(pickupEnergyFromPreferredTarget(creep)).toEqual({
      picked: true,
      outOfRange: false,
    });
    expect(creep.withdraw).toHaveBeenCalledWith(normalContainer, RESOURCE_ENERGY);
    expect(creep.withdraw).not.toHaveBeenCalledWith(protoStorage, RESOURCE_ENERGY);
  });
});
