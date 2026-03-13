import { carrierRole } from "@/roles/carrier";
import { replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";

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

const { getEnergyStoreTarget } = jest.requireMock("@/roles/energyTargets") as {
  getEnergyStoreTarget: jest.Mock;
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

function createRoom(name = "W1N1"): Room {
  return {
    name,
    controller: { my: true, level: 6 } as StructureController,
    find: () => [],
    terminal: {
      id: `${name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal,
    storage: {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureStorage,
  } as unknown as Room;
}

describe("carrierRole mineral hauling", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
    Memory.rooms = {};
    getEnergyStoreTarget.mockReset();
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
});
