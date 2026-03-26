import { carrierRole } from "@/roles/carrier";
import { replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";
import { getCreepConfigService } from "@/runtime/runtimeServices";

jest.mock("@/roles/energyTargets", () => ({
  getEnergyStoreTarget: jest.fn(),
  isDroppedResourceTarget: jest.fn(() => false),
}));

jest.mock("@/runtime/energyPickupReservation", () => ({
  getPickupTargetEnergyAmount: jest.fn(() => 0),
  getReservedPickupTarget: jest.fn(() => null),
  releasePickupReservation: jest.fn(),
  reservePickupTarget: jest.fn(() => false),
}));

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
}));

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getPlannedStoragePos: jest.fn(() => null),
  getPlannedControllerLinkPos: jest.fn(() => null),
  getProtoStorageContainer: jest.fn(() => null),
  getProtoControllerLinkContainer: jest.fn(() => null),
}));

const { getEnergyStoreTarget } = jest.requireMock("@/roles/energyTargets") as {
  getEnergyStoreTarget: jest.Mock;
};

const {
  getReservedPickupTarget,
  reservePickupTarget,
} = jest.requireMock("@/runtime/energyPickupReservation") as {
  getReservedPickupTarget: jest.Mock;
  reservePickupTarget: jest.Mock;
};

const {
  getProtoStorageContainer,
  getProtoControllerLinkContainer,
} = jest.requireMock("@/runtime/roomPlannerConstruction") as {
  getProtoStorageContainer: jest.Mock;
  getProtoControllerLinkContainer: jest.Mock;
};

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createCreep(room: Room): Creep {
  return {
    name: "carrier-1",
    room,
    memory: {},
    pos: {
      getRangeTo: () => 1,
    } as unknown as RoomPosition,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return 0;
        }
        return 0;
      },
      getFreeCapacity: () => 800,
    },
    withdraw: jest.fn(() => OK),
    transfer: jest.fn(() => OK),
    suicide: jest.fn(),
  } as unknown as Creep;
}

function createRoom(name = "W1N1", options: { level?: number; storage?: StructureStorage | null; terminal?: StructureTerminal | null } = {}): Room {
  const room = {
    name,
    controller: { my: true, level: options.level ?? 6 } as StructureController,
    find: () => [],
    terminal: options.terminal === undefined ? {
      id: `${name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal : options.terminal,
    storage: options.storage === undefined ? {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureStorage : options.storage,
  } as unknown as Room;

  Game.rooms[name] = room;
  return room;
}

describe("carrierRole mineral hauling", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
    Memory.rooms = {};
    getEnergyStoreTarget.mockReset();
    getReservedPickupTarget.mockReset();
    getReservedPickupTarget.mockReturnValue(null);
    reservePickupTarget.mockReset();
    reservePickupTarget.mockReturnValue(false);
    getProtoStorageContainer.mockReset();
    getProtoStorageContainer.mockReturnValue(null);
    getProtoControllerLinkContainer.mockReset();
    getProtoControllerLinkContainer.mockReturnValue(null);
  });

  it("picks mineral board tasks when there is no energy demand target", () => {
    const room = createRoom();
    const container = {
      id: "container-1",
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 900 : 0),
      },
    } as unknown as StructureContainer;
    const terminal = room.terminal as StructureTerminal;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === container.id) {
        return container;
      }
      if (id === terminal.id) {
        return terminal;
      }
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("test", room.name, [
      {
        id: "mineral-task",
        type: "mineral_haul",
        priority: 25,
        steps: [
          {
            id: "step-1",
            resource: RESOURCE_KEANIUM,
            fromKind: "container",
            toKind: "terminal",
            fromId: container.id,
            toId: terminal.id,
            amount: 900,
          },
        ],
      },
    ]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_KEANIUM);
    expect(switched).toBe(false);
    expect(creep.memory.synthesisCarrierTaskId).toBe("mineral-task");
  });

  it("keeps mineral hauling behind active energy demand", () => {
    const room = createRoom("W1N0");
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue({
      id: "spawn-1",
      store: { getFreeCapacity: () => 300 },
      pos: { x: 5, y: 5, roomName: room.name },
    });

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalled();
    expect(creep.memory.synthesisCarrierTaskId).toBeUndefined();
    expect(switched).toBe(false);
  });

  it("fills proto storage container before proto controller container in storage-only mode", () => {
    const room = createRoom("W1N0A", { level: 3, storage: null, terminal: null });
    const protoStorage = {
      id: "proto-storage-1",
      structureType: STRUCTURE_CONTAINER,
      pos: { x: 10, y: 10, roomName: room.name },
      store: { getFreeCapacity: () => 500 },
    } as unknown as StructureContainer;
    const protoController = {
      id: "proto-controller-1",
      structureType: STRUCTURE_CONTAINER,
      pos: { x: 12, y: 12, roomName: room.name },
      store: { getFreeCapacity: () => 500 },
    } as unknown as StructureContainer;
    const creep = {
      ...createCreep(room),
      memory: { configName: "W1N0A:carrier:0", carrierStorageOnlyMode: true },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? 100 : 0),
        getFreeCapacity: () => 700,
      },
    } as unknown as Creep;
    getProtoStorageContainer.mockReturnValue(protoStorage);
    getProtoControllerLinkContainer.mockReturnValue(protoController);

    const done = carrierRole().target?.(creep);

    expect(creep.transfer).toHaveBeenCalledWith(protoStorage, RESOURCE_ENERGY);
    expect(creep.transfer).not.toHaveBeenCalledWith(protoController, RESOURCE_ENERGY);
    expect(done).toBe(false);
  });

  it("falls back to the proto controller container when proto storage is full in storage-only mode", () => {
    const room = createRoom("W1N0AA", { level: 3, storage: null, terminal: null });
    const protoStorage = {
      id: "proto-storage-full-1",
      structureType: STRUCTURE_CONTAINER,
      pos: { x: 10, y: 10, roomName: room.name },
      store: { getFreeCapacity: () => 0 },
    } as unknown as StructureContainer;
    const protoController = {
      id: "proto-controller-2",
      structureType: STRUCTURE_CONTAINER,
      pos: { x: 12, y: 12, roomName: room.name },
      store: { getFreeCapacity: () => 500 },
    } as unknown as StructureContainer;
    const creep = {
      ...createCreep(room),
      memory: { configName: "W1N0AA:carrier:0", carrierStorageOnlyMode: true },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? 100 : 0),
        getFreeCapacity: () => 700,
      },
    } as unknown as Creep;
    getProtoStorageContainer.mockReturnValue(protoStorage);
    getProtoControllerLinkContainer.mockReturnValue(protoController);

    const done = carrierRole().target?.(creep);

    expect(creep.transfer).toHaveBeenCalledWith(protoController, RESOURCE_ENERGY);
    expect(creep.transfer).not.toHaveBeenCalledWith(protoStorage, RESOURCE_ENERGY);
    expect(done).toBe(false);
  });

  it("can withdraw from proto storage container when spawn or extension demand exists", () => {
    const room = createRoom("W1N0B", { level: 3, storage: null, terminal: null });
    const protoStorage = {
      id: "proto-storage-2",
      structureType: STRUCTURE_CONTAINER,
      pos: { x: 10, y: 10, roomName: room.name },
      store: { getUsedCapacity: () => 300, getFreeCapacity: () => 1700 },
    } as unknown as StructureContainer;
    const creep = {
      ...createCreep(room),
      memory: { configName: "W1N0B:carrier:0" },
    } as unknown as Creep;
    getProtoStorageContainer.mockReturnValue(protoStorage);
    getEnergyStoreTarget.mockReturnValue({
      id: "spawn-1",
      structureType: STRUCTURE_SPAWN,
      store: { getFreeCapacity: () => 300 },
      pos: { x: 5, y: 5, roomName: room.name },
    });
    getReservedPickupTarget.mockReturnValue(protoStorage);
    reservePickupTarget.mockImplementation((_creep: Creep, target: { id: string }) => target.id === protoStorage.id);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(protoStorage, RESOURCE_ENERGY);
    expect(switched).toBe(false);
  });

  it("does not withdraw from proto storage container when only tower demand exists", () => {
    const room = createRoom("W1N0C", { level: 3, storage: null, terminal: null });
    const protoStorage = {
      id: "proto-storage-3",
      structureType: STRUCTURE_CONTAINER,
      pos: { x: 10, y: 10, roomName: room.name },
      store: { getUsedCapacity: () => 300, getFreeCapacity: () => 1700 },
    } as unknown as StructureContainer;
    const creep = {
      ...createCreep(room),
      memory: { configName: "W1N0C:carrier:0" },
    } as unknown as Creep;
    getProtoStorageContainer.mockReturnValue(protoStorage);
    getEnergyStoreTarget.mockReturnValue({
      id: "tower-1",
      structureType: STRUCTURE_TOWER,
      store: { getFreeCapacity: () => 300 },
      pos: { x: 5, y: 5, roomName: room.name },
    });
    getReservedPickupTarget.mockReturnValue(protoStorage);
    reservePickupTarget.mockImplementation((_creep: Creep, target: { id: string }) => target.id !== protoStorage.id);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(protoStorage, RESOURCE_ENERGY);
    expect(switched).toBe(false);
  });

  it("delivers hauled minerals to the terminal before storage", () => {
    const room = createRoom("W1N2");
    const terminal = room.terminal as StructureTerminal;
    let remaining = 200;
    const store = {
      [RESOURCE_KEANIUM]: 200,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return remaining;
        }
        return resource === RESOURCE_KEANIUM ? remaining : 0;
      },
      getFreeCapacity: () => 600,
    };
    const creep = {
      ...createCreep(room),
      memory: {
        synthesisCarrierTaskId: "mineral-task",
      },
      store,
      transfer: jest.fn(() => {
        remaining = 0;
        delete store[RESOURCE_KEANIUM];
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    replaceCarrierTasksForProducerRoom("test", room.name, [
      {
        id: "mineral-task",
        type: "mineral_haul",
        priority: 25,
        steps: [
          {
            id: "step-1",
            resource: RESOURCE_KEANIUM,
            fromKind: "container",
            toKind: "terminal",
            fromId: "container-2",
            toId: terminal.id,
            amount: 900,
          },
        ],
      },
    ]);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) {
        return terminal;
      }
      return null;
    }) as Game["getObjectById"];

    const done = carrierRole().target(creep);

    expect((creep.transfer as jest.Mock)).toHaveBeenCalledWith(terminal, RESOURCE_KEANIUM);
    expect(done).toBe(true);
  });

  it("picks terminal feed board tasks when cross-room preload is pending", () => {
    const room = createRoom("W1N3");
    const storage = {
      id: "storage-feed-1",
      pos: { x: 12, y: 12, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_UTRIUM ? 1500 : 0),
      },
    } as unknown as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) {
        return storage;
      }
      if (id === terminal.id) {
        return terminal;
      }
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [
      {
        id: "terminal-feed-task",
        type: "terminal_feed",
        priority: 80,
        steps: [
          {
            id: "step-feed-1",
            resource: RESOURCE_UTRIUM,
            fromKind: "storage",
            toKind: "terminal",
            fromId: storage.id,
            toId: terminal.id,
            amount: 1500,
          },
        ],
      },
    ]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_UTRIUM);
    expect(switched).toBe(false);
    expect(creep.memory.synthesisCarrierTaskId).toBe("terminal-feed-task");
  });

  it("prefers mineral hauling over terminal feed when both board tasks are available", () => {
    const room = createRoom("W1N3A");
    const storage = {
      id: "storage-feed-2",
      pos: { x: 12, y: 12, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1500 : 0),
      },
    } as unknown as StructureStorage;
    const container = {
      id: "container-mineral-1",
      pos: { x: 8, y: 8, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 900 : 0),
      },
    } as unknown as StructureContainer;
    const terminal = room.terminal as StructureTerminal;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) {
        return storage;
      }
      if (id === container.id) {
        return container;
      }
      if (id === terminal.id) {
        return terminal;
      }
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [
      {
        id: "terminal-feed-task",
        type: "terminal_feed",
        priority: 80,
        steps: [
          {
            id: "step-feed-2",
            resource: RESOURCE_ENERGY,
            fromKind: "storage",
            toKind: "terminal",
            fromId: storage.id,
            toId: terminal.id,
            amount: 1500,
          },
        ],
      },
    ]);
    replaceCarrierTasksForProducerRoom("mineralExtraction", room.name, [
      {
        id: "mineral-task",
        type: "mineral_haul",
        priority: 85,
        steps: [
          {
            id: "step-mineral-1",
            resource: RESOURCE_KEANIUM,
            fromKind: "container",
            toKind: "terminal",
            fromId: container.id,
            toId: terminal.id,
            amount: 900,
          },
        ],
      },
    ]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_KEANIUM);
    expect(switched).toBe(false);
    expect(creep.memory.synthesisCarrierTaskId).toBe("mineral-task");
  });

  it("picks terminal offload board tasks for energy only when no room energy demand exists", () => {
    const room = createRoom("W1N4");
    const terminal = {
      id: "terminal-energy-1",
      pos: { x: 15, y: 15, roomName: room.name },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 12000 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    const storage = room.storage as StructureStorage;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) {
        return terminal;
      }
      if (id === storage.id) {
        return storage;
      }
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [
      {
        id: "terminal-offload-task",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-offload-1",
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            fromId: terminal.id,
            toId: storage.id,
            amount: 12000,
          },
        ],
      },
    ]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
    expect(switched).toBe(false);
    expect(creep.memory.synthesisCarrierTaskId).toBe("terminal-offload-task");
  });

  it("delivers board-task energy to the assigned storage target", () => {
    const room = createRoom("W1N5");
    const storage = room.storage as StructureStorage;
    let remaining = 200;
    const store = {
      [RESOURCE_ENERGY]: 200,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return remaining;
        }
        return resource === RESOURCE_ENERGY ? remaining : 0;
      },
      getFreeCapacity: () => 600,
    };
    const creep = {
      ...createCreep(room),
      memory: {
        synthesisCarrierTaskId: "terminal-offload-task",
      },
      store,
      transfer: jest.fn(() => {
        remaining = 0;
        delete store[RESOURCE_ENERGY];
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [
      {
        id: "terminal-offload-task",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-offload-1",
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            fromId: "terminal-energy-2",
            toId: storage.id,
            amount: 12000,
          },
        ],
      },
    ]);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) {
        return storage;
      }
      return null;
    }) as Game["getObjectById"];

    const done = carrierRole().target(creep);

    expect((creep.transfer as jest.Mock)).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(done).toBe(true);
  });

  it("keeps synthesis task lookup bound to the assigned room", () => {
    const assignedRoom = createRoom("W2N1");
    const transitRoom = createRoom("W2N2");
    const terminal = {
      id: "terminal-energy-home",
      pos: { x: 15, y: 15, roomName: assignedRoom.name },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 12000 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    const storage = assignedRoom.storage as StructureStorage;
    const configName = `${assignedRoom.name}:manual:maxcarrier:test`;
    const creep = {
      ...createCreep(transitRoom),
      memory: {
        configName,
      },
    } as unknown as Creep;

    getCreepConfigService().upsert(configName, "carrier", [], assignedRoom.name);
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) {
        return terminal;
      }
      if (id === storage.id) {
        return storage;
      }
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("resourceControl:preload", assignedRoom.name, [
      {
        id: "terminal-offload-home",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-offload-home",
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            fromId: terminal.id,
            toId: storage.id,
            amount: 12000,
          },
        ],
      },
    ]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
    expect(creep.memory.synthesisCarrierTaskId).toBe("terminal-offload-home");
    expect(switched).toBe(false);
  });

  it("delivers assigned board-task energy to the assigned room target even when currently elsewhere", () => {
    const assignedRoom = createRoom("W2N3");
    const transitRoom = createRoom("W2N4");
    const storage = assignedRoom.storage as StructureStorage;
    const configName = `${assignedRoom.name}:manual:maxcarrier:test`;
    let remaining = 200;
    const store = {
      [RESOURCE_ENERGY]: 200,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return remaining;
        }
        return resource === RESOURCE_ENERGY ? remaining : 0;
      },
      getFreeCapacity: () => 600,
    };
    const creep = {
      ...createCreep(transitRoom),
      memory: {
        configName,
        synthesisCarrierTaskId: "terminal-offload-home",
      },
      store,
      transfer: jest.fn(() => {
        remaining = 0;
        delete store[RESOURCE_ENERGY];
        return OK;
      }),
    } as unknown as Creep;

    getCreepConfigService().upsert(configName, "carrier", [], assignedRoom.name);
    getEnergyStoreTarget.mockReturnValue(null);
    replaceCarrierTasksForProducerRoom("resourceControl:preload", assignedRoom.name, [
      {
        id: "terminal-offload-home",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-offload-home",
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            fromId: "terminal-energy-home-2",
            toId: storage.id,
            amount: 12000,
          },
        ],
      },
    ]);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) {
        return storage;
      }
      return null;
    }) as Game["getObjectById"];

    const done = carrierRole().target(creep);

    expect((creep.transfer as jest.Mock)).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(done).toBe(true);
  });

  it("uses the assigned room storage in storage-only mode", () => {
    const assignedRoom = createRoom("W2N5");
    const transitRoom = createRoom("W2N6");
    const storage = assignedRoom.storage as StructureStorage;
    const configName = `${assignedRoom.name}:carrier:0`;
    let remaining = 200;
    const store = {
      [RESOURCE_ENERGY]: 200,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return remaining;
        }
        return resource === RESOURCE_ENERGY ? remaining : 0;
      },
      getFreeCapacity: () => 600,
    };
    const creep = {
      ...createCreep(transitRoom),
      memory: {
        configName,
        carrierStorageOnlyMode: true,
      },
      store,
      transfer: jest.fn(() => {
        remaining = 0;
        delete store[RESOURCE_ENERGY];
        return OK;
      }),
    } as unknown as Creep;

    getCreepConfigService().upsert(configName, "carrier", [], assignedRoom.name);
    getEnergyStoreTarget.mockReturnValue(null);

    const done = carrierRole().target(creep);

    expect((creep.transfer as jest.Mock)).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(done).toBe(true);
  });

  it("queries generic delivery targets from the assigned room", () => {
    const assignedRoom = createRoom("W2N7");
    const transitRoom = createRoom("W2N8");
    const configName = `${assignedRoom.name}:carrier:1`;
    let remaining = 200;
    const store = {
      [RESOURCE_ENERGY]: 200,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return remaining;
        }
        return resource === RESOURCE_ENERGY ? remaining : 0;
      },
      getFreeCapacity: () => 600,
    };
    const target = assignedRoom.storage as StructureStorage;
    const creep = {
      ...createCreep(transitRoom),
      memory: {
        configName,
      },
      store,
      transfer: jest.fn(() => {
        remaining = 0;
        delete store[RESOURCE_ENERGY];
        return OK;
      }),
    } as unknown as Creep;

    getCreepConfigService().upsert(configName, "carrier", [], assignedRoom.name);
    getEnergyStoreTarget.mockReturnValue(target);

    const done = carrierRole().target(creep);

    expect(getEnergyStoreTarget).toHaveBeenCalledWith(creep, { roomName: assignedRoom.name });
    expect((creep.transfer as jest.Mock)).toHaveBeenCalledWith(target, RESOURCE_ENERGY);
    expect(done).toBe(true);
  });
});
