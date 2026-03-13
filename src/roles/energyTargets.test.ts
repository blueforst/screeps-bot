jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
}));

import { getEnergyStoreTarget, pickupEnergyFromPreferredTarget } from "@/roles/energyTargets";
import { moveToTarget } from "@/roles/shared";

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
  const memory = (Memory.rooms[name] = {} as RoomMemory);

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
    resetRuntimeServices();
    Game.time += 1;
    (moveToTarget as jest.Mock).mockReset();
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

  it("keeps moving toward a reserved target when renewal fails but energy still exists", () => {
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
    creep.memory.energyPickupTargetId = container.id;
    creep.memory.energyPickupTargetKind = "structure";
    creep.memory.energyPickupRoomName = room.name;
    creep.withdraw = jest.fn(() => ERR_NOT_IN_RANGE);

    expect(pickupEnergyFromPreferredTarget(creep)).toEqual({
      picked: false,
      outOfRange: true,
    });
    expect(moveToTarget).toHaveBeenCalledWith(creep, container, 1, {});
    expect(creep.memory.energyPickupTargetId).toBe(container.id);
    expect(creep.memory.energyPickupTargetKind).toBe("structure");
    expect(creep.memory.energyPickupRoomName).toBe(room.name);
  });

  it("releases the reserved target when renewal fails and the target is empty", () => {
    const container = {
      id: "container-2",
      structureType: STRUCTURE_CONTAINER,
      pos: createPos(3),
      store: createStore(0, 2000),
    } as unknown as StructureContainer;
    const room = createRoom({
      structures: [container as unknown as Structure<StructureConstant>],
    });
    Game.rooms[room.name] = room;

    const getObjectById = jest.fn((id: string) => (id === container.id ? container : null)) as unknown as Game["getObjectById"];
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = getObjectById;

    const creep = createCreep(room);
    creep.memory.energyPickupTargetId = container.id;
    creep.memory.energyPickupTargetKind = "structure";
    creep.memory.energyPickupRoomName = room.name;

    expect(pickupEnergyFromPreferredTarget(creep)).toEqual({
      picked: false,
      outOfRange: false,
    });
    expect(creep.memory.energyPickupTargetId).toBeUndefined();
    expect(creep.memory.energyPickupTargetKind).toBeUndefined();
    expect(creep.memory.energyPickupRoomName).toBeUndefined();
  });
});
