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
});
