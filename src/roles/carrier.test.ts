import { carrierRole } from "@/roles/carrier";
import { clearCarrierTaskBoardForTest, replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState, getCreepAssignmentState } from "@/runtime/creepAssignmentState";
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

const { isDroppedResourceTarget } = jest.requireMock("@/roles/energyTargets") as {
  isDroppedResourceTarget: jest.Mock;
};

const {
  getPickupTargetEnergyAmount,
  getReservedPickupTarget,
  reservePickupTarget,
} = jest.requireMock("@/runtime/energyPickupReservation") as {
  getPickupTargetEnergyAmount: jest.Mock;
  getReservedPickupTarget: jest.Mock;
  reservePickupTarget: jest.Mock;
};

const {
  moveToTarget,
} = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
};

const {
  getPlannedStoragePos,
  getProtoStorageContainer,
  getProtoControllerLinkContainer,
} = jest.requireMock("@/runtime/roomPlannerConstruction") as {
  getPlannedStoragePos: jest.Mock;
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
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    resetRuntimeServices();
    Game.time += 1;
    Memory.rooms = {};
    getEnergyStoreTarget.mockReset();
    isDroppedResourceTarget.mockReset();
    isDroppedResourceTarget.mockReturnValue(false);
    getPickupTargetEnergyAmount.mockReset();
    getPickupTargetEnergyAmount.mockReturnValue(0);
    getReservedPickupTarget.mockReset();
    getReservedPickupTarget.mockReturnValue(null);
    reservePickupTarget.mockReset();
    reservePickupTarget.mockReturnValue(false);
    moveToTarget.mockReset();
    getPlannedStoragePos.mockReset();
    getPlannedStoragePos.mockReturnValue(null);
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
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("mineral-task");
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
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBeUndefined();
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
      memory: { configName: "W1N0A:carrier:0" },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? 100 : 0),
        getFreeCapacity: () => 700,
      },
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode = true;
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
      memory: { configName: "W1N0AA:carrier:0" },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? 100 : 0),
        getFreeCapacity: () => 700,
      },
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode = true;
    getProtoStorageContainer.mockReturnValue(protoStorage);
    getProtoControllerLinkContainer.mockReturnValue(protoController);

    const done = carrierRole().target?.(creep);

    expect(creep.transfer).toHaveBeenCalledWith(protoController, RESOURCE_ENERGY);
    expect(creep.transfer).not.toHaveBeenCalledWith(protoStorage, RESOURCE_ENERGY);
    expect(done).toBe(false);
  });

  it("moves to planned storage position to drop energy before the proto storage site exists", () => {
    const room = createRoom("W1N0AB", { level: 3, storage: null, terminal: null });
    const plannedPos = {
      x: 20,
      y: 20,
      roomName: room.name,
      lookFor: jest.fn(() => []),
    } as unknown as RoomPosition;
    let remaining = 100;
    const creep = {
      ...createCreep(room),
      memory: { configName: "W1N0AB:carrier:0" },
      pos: {
        isEqualTo: () => false,
        getRangeTo: () => 10,
      },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? remaining : 0),
        getFreeCapacity: () => 700,
      },
      drop: jest.fn(() => {
        remaining = 0;
        return OK;
      }),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode = true;
    getPlannedStoragePos.mockReturnValue(plannedPos);

    const done = carrierRole().target?.(creep);

    expect(moveToTarget).toHaveBeenCalledWith(creep, plannedPos, 0);
    expect(creep.drop).not.toHaveBeenCalled();
    expect(done).toBe(false);
  });

  it("drops energy at planned storage position before the proto storage site exists", () => {
    const room = createRoom("W1N0AD", { level: 3, storage: null, terminal: null });
    const plannedPos = {
      x: 20,
      y: 20,
      roomName: room.name,
      lookFor: jest.fn(() => []),
    } as unknown as RoomPosition;
    let remaining = 100;
    const creep = {
      ...createCreep(room),
      memory: { configName: "W1N0AD:carrier:0" },
      pos: {
        isEqualTo: () => true,
        getRangeTo: () => 0,
      },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? remaining : 0),
        getFreeCapacity: () => 700,
      },
      drop: jest.fn(() => {
        remaining = 0;
        return OK;
      }),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode = true;
    getPlannedStoragePos.mockReturnValue(plannedPos);

    const done = carrierRole().target?.(creep);

    expect(moveToTarget).not.toHaveBeenCalled();
    expect(creep.drop).toHaveBeenCalledWith(RESOURCE_ENERGY);
    expect(done).toBe(true);
  });

  it("does not drop at planned storage position after a construction site exists", () => {
    const room = createRoom("W1N0AE", { level: 3, storage: null, terminal: null });
    const plannedPos = {
      x: 20,
      y: 20,
      roomName: room.name,
      lookFor: jest.fn(() => [{ structureType: STRUCTURE_STORAGE }]),
    } as unknown as RoomPosition;
    let remaining = 100;
    const creep = {
      ...createCreep(room),
      memory: { configName: "W1N0AE:carrier:0" },
      pos: {
        isEqualTo: () => true,
        getRangeTo: () => 0,
      },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? remaining : 0),
        getFreeCapacity: () => 700,
      },
      drop: jest.fn(() => {
        remaining = 0;
        return OK;
      }),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode = true;
    getPlannedStoragePos.mockReturnValue(plannedPos);

    const done = carrierRole().target?.(creep);

    expect(moveToTarget).not.toHaveBeenCalled();
    expect(creep.drop).not.toHaveBeenCalled();
    expect(done).toBe(false);
  });

  it("does not pick up dropped energy from planned storage before storage exists at rcl3", () => {
    const room = createRoom("W1N0AF", { level: 3, storage: null, terminal: null });
    const plannedPos = {
      x: 20,
      y: 20,
      roomName: room.name,
      isEqualTo: () => true,
    } as unknown as RoomPosition;
    const dropped = {
      id: "dropped-storage-energy-1",
      amount: 100,
      resourceType: RESOURCE_ENERGY,
      room,
      pos: plannedPos,
    } as unknown as Resource;
    const creep = {
      ...createCreep(room),
      memory: { configName: "W1N0AF:carrier:0" },
      pickup: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue({
      id: "spawn-1",
      structureType: STRUCTURE_SPAWN,
      store: { getFreeCapacity: () => 300 },
      pos: { x: 5, y: 5, roomName: room.name },
    });
    getReservedPickupTarget.mockReturnValue(dropped);
    getPlannedStoragePos.mockReturnValue(plannedPos);
    isDroppedResourceTarget.mockReturnValue(true);

    const switched = carrierRole().source?.(creep);

    expect(creep.pickup).not.toHaveBeenCalled();
    expect(switched).toBe(false);
  });

  it("delivers to generic demand targets during the pre-storage gap", () => {
    const room = createRoom("W1N0AC", { level: 3, storage: null, terminal: null });
    const target = {
      id: "spawn-gap-1",
      structureType: STRUCTURE_SPAWN,
      pos: { x: 5, y: 5, roomName: room.name },
      store: { getFreeCapacity: () => 300 },
    } as unknown as StructureSpawn;
    let remaining = 100;
    const creep = {
      ...createCreep(room),
      memory: { configName: "W1N0AC:carrier:0" },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? remaining : 0),
        getFreeCapacity: () => 700,
      },
      transfer: jest.fn(() => {
        remaining = 0;
        return OK;
      }),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode = true;
    getEnergyStoreTarget.mockReturnValue(target);

    const done = carrierRole().target?.(creep);

    expect(getEnergyStoreTarget).toHaveBeenCalledWith(creep, { roomName: room.name });
    expect(creep.transfer).toHaveBeenCalledWith(target, RESOURCE_ENERGY);
    expect(getCreepAssignmentState(creep.name)?.carrierStorageOnlyMode).toBeUndefined();
    expect(done).toBe(true);
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

  it("can withdraw from controller-adjacent links when storage and controller share the link cluster", () => {
    const controllerPos = {} as RoomPosition;
    const storagePos = {
      getRangeTo: (target: RoomPosition) => (target === controllerPos ? 5 : Number.POSITIVE_INFINITY),
    } as RoomPosition;
    const room = createRoom("W1N0Link");
    room.controller.pos = controllerPos;
    (room.storage as StructureStorage).pos = storagePos;
    const link = {
      id: "shared-link-1",
      room,
      structureType: STRUCTURE_LINK,
      pos: {
        getRangeTo: (target: { structureType?: StructureConstant }) =>
          target.structureType === STRUCTURE_STORAGE ? 4 : 2,
      } as RoomPosition,
      store: { getUsedCapacity: () => 600, getFreeCapacity: () => 200, getCapacity: () => 800 },
    } as unknown as StructureLink;
    room.find = ((type: FindConstant) => (type === FIND_STRUCTURES ? [link] : [])) as Room["find"];
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue({
      id: "spawn-1",
      structureType: STRUCTURE_SPAWN,
      store: { getFreeCapacity: () => 300 },
      pos: { x: 5, y: 5, roomName: room.name },
    });
    getPickupTargetEnergyAmount.mockImplementation((target: { id: string }) => (target.id === link.id ? 600 : 0));
    reservePickupTarget.mockImplementation((_creep: Creep, target: { id: string }) => target.id === link.id);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(link, RESOURCE_ENERGY);
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
      memory: {},
      store,
      transfer: jest.fn(() => {
        remaining = 0;
        delete store[RESOURCE_KEANIUM];
        return OK;
      }),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "mineral-task";
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
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("terminal-feed-task");
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
        priority: 91,
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
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("mineral-task");
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
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("terminal-offload-task");
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
      memory: {},
      store,
      transfer: jest.fn(() => {
        remaining = 0;
        delete store[RESOURCE_ENERGY];
        return OK;
      }),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "terminal-offload-task";
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
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("terminal-offload-home");
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
      },
      store,
      transfer: jest.fn(() => {
        remaining = 0;
        delete store[RESOURCE_ENERGY];
        return OK;
      }),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "terminal-offload-home";

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
      },
      store,
      transfer: jest.fn(() => {
        remaining = 0;
        delete store[RESOURCE_ENERGY];
        return OK;
      }),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode = true;

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

  it("uses existing owned-room carriers to collect non-energy ruin resources", () => {
    const room = createRoom("W3N7");
    const ruin = {
      id: "owned-ruin-1",
      pos: {
        getRangeTo: () => 1,
      },
      store: {
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 200,
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) {
            return 200;
          }
          return resource === RESOURCE_CATALYZED_UTRIUM_ACID ? 200 : 0;
        },
      },
    } as unknown as Ruin;
    room.find = jest.fn((type: FindConstant) => (type === FIND_RUINS ? [ruin] : [])) as Room["find"];
    let carried = 0;
    const creep = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) {
            return carried;
          }
          return resource === RESOURCE_CATALYZED_UTRIUM_ACID ? carried : 0;
        },
        getFreeCapacity: () => 800 - carried,
      },
      withdraw: jest.fn(() => {
        carried = 200;
        return OK;
      }),
    } as unknown as Creep;

    getEnergyStoreTarget.mockReturnValue(null);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(ruin, RESOURCE_CATALYZED_UTRIUM_ACID);
    expect(switched).toBe(true);
  });

  it("clears synthesis task when cleanup carrier holds non-energy cargo and storage/terminal are full", () => {
    const room = createRoom("W5N1", {
      storage: {
        id: "W5N1-storage",
        structureType: STRUCTURE_STORAGE,
        store: {
          getUsedCapacity: () => 1000000,
          getFreeCapacity: () => 0,
        },
      } as unknown as StructureStorage,
      terminal: {
        id: "W5N1-terminal",
        structureType: STRUCTURE_TERMINAL,
        store: {
          getUsedCapacity: () => 300000,
          getFreeCapacity: () => 0,
        },
      } as unknown as StructureTerminal,
    });
    const lab = {
      id: "lab-cleanup-1",
      structureType: STRUCTURE_LAB,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3000,
      },
    } as unknown as StructureLab;
    let carried = 200;
    const store = {
      [RESOURCE_KEANIUM]: 200,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return carried;
        }
        return resource === RESOURCE_KEANIUM ? carried : 0;
      },
      getFreeCapacity: () => 600,
    };
    const creep = {
      ...createCreep(room),
      memory: {},
      store,
      transfer: jest.fn(() => OK),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "lab-cleanup-task";
    getEnergyStoreTarget.mockReturnValue(null);
    replaceCarrierTasksForProducerRoom("labSynthesis", room.name, [
      {
        id: "lab-cleanup-task",
        type: "lab_cleanup",
        priority: 70,
        steps: [
          {
            id: "step-cleanup-1",
            resource: RESOURCE_KEANIUM,
            fromKind: "lab",
            toKind: "storage",
            fromId: lab.id,
            toId: (room.storage as StructureStorage).id,
            amount: 200,
          },
        ],
      },
    ]);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === lab.id) {
        return lab;
      }
      if (id === (room.storage as StructureStorage).id) {
        return room.storage;
      }
      if (id === (room.terminal as StructureTerminal).id) {
        return room.terminal;
      }
      return null;
    }) as Game["getObjectById"];

    const done = carrierRole().target(creep);

    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBeUndefined();
    expect(done).toBe(false);
  });

  it("delivers cleanup resource to storage when storage has capacity", () => {
    const room = createRoom("W5N2");
    const storage = room.storage as StructureStorage;
    const lab = {
      id: "lab-cleanup-2",
      structureType: STRUCTURE_LAB,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3000,
      },
    } as unknown as StructureLab;
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
      memory: {},
      store,
      transfer: jest.fn(() => {
        remaining = 0;
        delete store[RESOURCE_KEANIUM];
        return OK;
      }),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "lab-cleanup-task-2";
    getEnergyStoreTarget.mockReturnValue(null);
    replaceCarrierTasksForProducerRoom("labSynthesis", room.name, [
      {
        id: "lab-cleanup-task-2",
        type: "lab_cleanup",
        priority: 70,
        steps: [
          {
            id: "step-cleanup-2",
            resource: RESOURCE_KEANIUM,
            fromKind: "lab",
            toKind: "storage",
            fromId: lab.id,
            toId: storage.id,
            amount: 200,
          },
        ],
      },
    ]);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === lab.id) {
        return lab;
      }
      if (id === storage.id) {
        return storage;
      }
      return null;
    }) as Game["getObjectById"];

    const done = carrierRole().target(creep);

    expect((creep.transfer as jest.Mock)).toHaveBeenCalledWith(storage, RESOURCE_KEANIUM);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBeUndefined();
    expect(done).toBe(true);
  });

  it("does not let emergency carriers withdraw storage energy when no delivery target needs energy", () => {
    const storage = {
      id: "idle-storage",
      pos: {
        getRangeTo: () => 1,
      },
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1000 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureStorage;
    const room = createRoom("W4N1", { storage });
    const configName = `${room.name}:manual:maxcarrier:test`;
    let carried = 0;
    const creep = {
      ...createCreep(room),
      memory: { configName },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) {
            return carried;
          }
          return resource === RESOURCE_ENERGY ? carried : 0;
        },
        getFreeCapacity: () => 800 - carried,
      },
      withdraw: jest.fn(() => {
        carried = 800;
        return OK;
      }),
    } as unknown as Creep;

    getCreepConfigService().upsert(configName, "carrier", [], room.name);
    getEnergyStoreTarget.mockReturnValue(null);
    getPickupTargetEnergyAmount.mockReturnValue(1000);
    reservePickupTarget.mockReturnValue(true);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalled();
    expect(switched).toBe(false);
  });

  it("prefers mineral_haul (priority 91) over terminal_offload (priority 90) when both are runnable", () => {
    const room = createRoom("W4N2");
    const container = {
      id: "container-mineral-vs-offload",
      pos: { x: 8, y: 8, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 900 : 0),
      },
    } as unknown as StructureContainer;
    const terminal = {
      id: "terminal-offload-vs-mineral",
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
      if (id === container.id) return container;
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("resourceControl:offload", room.name, [
      {
        id: "terminal-offload-task",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-offload-energy",
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
    replaceCarrierTasksForProducerRoom("mineralExtraction", room.name, [
      {
        id: "mineral-haul-task",
        type: "mineral_haul",
        priority: 91,
        steps: [
          {
            id: "step-mineral-keanium",
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
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("mineral-haul-task");
  });

  it("prefers terminal_offload (priority 90) over terminal_feed (priority 80) when no mineral_haul exists", () => {
    const room = createRoom("W4N3");
    const terminal = {
      id: "terminal-offload-vs-feed",
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
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [
      {
        id: "terminal-feed-task",
        type: "terminal_feed",
        priority: 80,
        steps: [
          {
            id: "step-feed-energy",
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
    replaceCarrierTasksForProducerRoom("resourceControl:offload", room.name, [
      {
        id: "terminal-offload-task",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-offload-energy",
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
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("terminal-offload-task");
  });

  it("preserves assigned terminal_offload task across board refresh when still runnable", () => {
    const room = createRoom("W4N4");
    const terminal = {
      id: "terminal-preserve-1",
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
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      return null;
    }) as Game["getObjectById"];

    // First tick: assign terminal_offload task
    replaceCarrierTasksForProducerRoom("resourceControl:offload", room.name, [
      {
        id: "terminal-offload-assigned",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-offload-preserve",
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
    const switched1 = carrierRole().source?.(creep);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("terminal-offload-assigned");

    // Board refresh: replace tasks (simulates next tick refresh with same task id/producer)
    replaceCarrierTasksForProducerRoom("resourceControl:offload", room.name, [
      {
        id: "terminal-offload-assigned",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-offload-preserve",
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

    // Second source call: should still be on the same assigned task
    const switched2 = carrierRole().source?.(creep);
    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
    expect(switched2).toBe(false);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("terminal-offload-assigned");
  });

  it("preserves assigned mineral_haul task even when a new terminal_offload appears on the board", () => {
    const room = createRoom("W4N5");
    const container = {
      id: "container-preserve-mineral",
      pos: { x: 8, y: 8, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 900 : 0),
      },
    } as unknown as StructureContainer;
    const terminal = {
      id: "terminal-preserve-mineral",
      pos: { x: 15, y: 15, roomName: room.name },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 12000 : resource === RESOURCE_KEANIUM ? 0 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    const storage = room.storage as StructureStorage;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === container.id) return container;
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      return null;
    }) as Game["getObjectById"];

    // First tick: assign mineral_haul task
    replaceCarrierTasksForProducerRoom("mineralExtraction", room.name, [
      {
        id: "mineral-haul-assigned",
        type: "mineral_haul",
        priority: 91,
        steps: [
          {
            id: "step-mineral-preserve",
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
    carrierRole().source?.(creep);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("mineral-haul-assigned");

    // Board refresh: add a terminal_offload task alongside the mineral_haul
    replaceCarrierTasksForProducerRoom("resourceControl:offload", room.name, [
      {
        id: "terminal-offload-intruder",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-offload-intruder",
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
    replaceCarrierTasksForProducerRoom("mineralExtraction", room.name, [
      {
        id: "mineral-haul-assigned",
        type: "mineral_haul",
        priority: 91,
        steps: [
          {
            id: "step-mineral-preserve",
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

    // Second source call: should still be on mineral_haul, not flip to terminal_offload
    const switched = carrierRole().source?.(creep);
    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_KEANIUM);
    expect(switched).toBe(false);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("mineral-haul-assigned");
  });
});

describe("carrierRole lab logistics", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    resetRuntimeServices();
    Game.time += 1;
    Memory.rooms = {};
    getEnergyStoreTarget.mockReset();
    isDroppedResourceTarget.mockReset();
    isDroppedResourceTarget.mockReturnValue(false);
    getPickupTargetEnergyAmount.mockReset();
    getPickupTargetEnergyAmount.mockReturnValue(0);
    getReservedPickupTarget.mockReset();
    getReservedPickupTarget.mockReturnValue(null);
    reservePickupTarget.mockReset();
    reservePickupTarget.mockReturnValue(false);
    moveToTarget.mockReset();
    getPlannedStoragePos.mockReset();
    getPlannedStoragePos.mockReturnValue(null);
    getProtoStorageContainer.mockReset();
    getProtoStorageContainer.mockReturnValue(null);
    getProtoControllerLinkContainer.mockReset();
    getProtoControllerLinkContainer.mockReturnValue(null);
  });

  it("supplies reagent lab from terminal (lab_supply)", () => {
    const room = createRoom("W7N1");
    const terminal = room.terminal as StructureTerminal;
    (terminal as { store: StoreDefinition }).store = {
      getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_UTRIUM ? 500 : 0),
      getFreeCapacity: () => 10000,
    } as StoreDefinition;
    const lab = {
      id: "lab-supply-1",
      structureType: STRUCTURE_LAB,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3000,
      },
    } as unknown as StructureLab;
    let carried = 0;
    const store = {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return carried;
        return resource === RESOURCE_UTRIUM ? carried : 0;
      },
      getFreeCapacity: () => 800 - carried,
    };
    const creep = {
      ...createCreep(room),
      store,
      withdraw: jest.fn(() => {
        carried = 500;
        return OK;
      }),
      transfer: jest.fn(() => {
        carried = 0;
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === lab.id) return lab;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [{
      id: "synth:lab_supply:W7N1:OH",
      type: "lab_supply",
      priority: 100,
      steps: [{
        id: "U:term->lab",
        resource: RESOURCE_UTRIUM,
        fromKind: "terminal",
        toKind: "lab",
        fromId: terminal.id,
        toId: lab.id,
        amount: 500,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_UTRIUM);
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("synth:lab_supply:W7N1:OH");

    const done = carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(lab, RESOURCE_UTRIUM);
    expect(done).toBe(true);
  });

  it("supplies reagent lab from storage when terminal is empty (lab_supply fallback)", () => {
    const room = createRoom("W7N2");
    const terminal = room.terminal as StructureTerminal;
    (terminal as { store: StoreDefinition }).store = {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 10000,
    } as StoreDefinition;
    const storage = room.storage as StructureStorage;
    (storage as { store: StoreDefinition }).store = {
      getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_UTRIUM ? 800 : 0),
      getFreeCapacity: () => 9200,
    } as StoreDefinition;
    const lab = {
      id: "lab-supply-2",
      structureType: STRUCTURE_LAB,
      pos: { x: 12, y: 12, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3000,
      },
    } as unknown as StructureLab;
    let carried = 0;
    const store = {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return carried;
        return resource === RESOURCE_UTRIUM ? carried : 0;
      },
      getFreeCapacity: () => 800 - carried,
    };
    const creep = {
      ...createCreep(room),
      store,
      withdraw: jest.fn(() => {
        carried = 500;
        return OK;
      }),
      transfer: jest.fn(() => {
        carried = 0;
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      if (id === lab.id) return lab;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [{
      id: "synth:lab_supply:W7N2:OH",
      type: "lab_supply",
      priority: 100,
      steps: [{
        id: "U:storage->lab",
        resource: RESOURCE_UTRIUM,
        fromKind: "storage",
        toKind: "lab",
        fromId: storage.id,
        toId: lab.id,
        amount: 500,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_UTRIUM);
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("synth:lab_supply:W7N2:OH");
  });

  it("cleans contaminated lab and deposits to terminal (lab_cleanup)", () => {
    const room = createRoom("W7N3");
    const terminal = room.terminal as StructureTerminal;
    const lab = {
      id: "lab-cleanup-3",
      structureType: STRUCTURE_LAB,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 300 : 0),
        getFreeCapacity: () => 2700,
      },
    } as unknown as StructureLab;
    let carried = 0;
    const store = {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return carried;
        return resource === RESOURCE_KEANIUM ? carried : 0;
      },
      getFreeCapacity: () => 800 - carried,
    };
    const creep = {
      ...createCreep(room),
      store,
      withdraw: jest.fn(() => {
        carried = 300;
        return OK;
      }),
      transfer: jest.fn(() => {
        carried = 0;
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === lab.id) return lab;
      if (id === terminal.id) return terminal;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("labSynthesis", room.name, [{
      id: "synth:lab_cleanup:W7N3",
      type: "lab_cleanup",
      priority: 70,
      steps: [{
        id: "K:lab->term",
        resource: RESOURCE_KEANIUM,
        fromKind: "lab",
        toKind: "terminal",
        fromId: lab.id,
        toId: terminal.id,
        amount: 300,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(lab, RESOURCE_KEANIUM);
    expect(switched).toBe(true);

    const done = carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(terminal, RESOURCE_KEANIUM);
    expect(done).toBe(true);
  });

  it("clears task when cleanup target terminal is full and no fallback (lab_cleanup)", () => {
    const room = createRoom("W7N4", {
      terminal: {
        id: "W7N4-terminal",
        structureType: STRUCTURE_TERMINAL,
        store: {
          getUsedCapacity: () => 300000,
          getFreeCapacity: (resource?: ResourceConstant) => 0,
        },
      } as unknown as StructureTerminal,
      storage: {
        id: "W7N4-storage",
        structureType: STRUCTURE_STORAGE,
        store: {
          getUsedCapacity: () => 900000,
          getFreeCapacity: (resource?: ResourceConstant) => 0,
        },
      } as unknown as StructureStorage,
    });
    let carried = 200;
    const store = {
      [RESOURCE_KEANIUM]: 200,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return carried;
        return resource === RESOURCE_KEANIUM ? carried : 0;
      },
      getFreeCapacity: () => 600,
    };
    const creep = {
      ...createCreep(room),
      memory: {},
      store,
      transfer: jest.fn(() => OK),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "synth:lab_cleanup:W7N4";
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === (room.terminal as StructureTerminal).id) return room.terminal;
      if (id === (room.storage as StructureStorage).id) return room.storage;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("labSynthesis", room.name, [{
      id: "synth:lab_cleanup:W7N4",
      type: "lab_cleanup",
      priority: 70,
      steps: [{
        id: "K:lab->term-full",
        resource: RESOURCE_KEANIUM,
        fromKind: "lab",
        toKind: "terminal",
        fromId: "lab-cleanup-4",
        toId: (room.terminal as StructureTerminal).id,
        amount: 200,
      }],
    }]);

    const done = carrierRole().target(creep);

    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBeUndefined();
    expect(done).toBe(false);
  });

  it("handles target lab already full gracefully during lab_supply delivery", () => {
    const room = createRoom("W7N5");
    const terminal = room.terminal as StructureTerminal;
    (terminal as { store: StoreDefinition }).store = {
      getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_UTRIUM ? 500 : 0),
      getFreeCapacity: () => 10000,
    } as StoreDefinition;
    const lab = {
      id: "lab-supply-full",
      structureType: STRUCTURE_LAB,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 3000,
        getFreeCapacity: () => 0,
      },
    } as unknown as StructureLab;
    let carried = 500;
    const store: Record<string, unknown> & { getUsedCapacity: (r?: ResourceConstant) => number; getFreeCapacity: () => number } = {
      [RESOURCE_UTRIUM]: 500,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return carried;
        return resource === RESOURCE_UTRIUM ? carried : 0;
      },
      getFreeCapacity: () => 300,
    };
    const creep = {
      ...createCreep(room),
      memory: {},
      store,
      transfer: jest.fn(() => {
        carried = 0;
        delete store[RESOURCE_UTRIUM];
        return OK;
      }),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "synth:lab_supply:W7N5:OH";
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === lab.id) return lab;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [{
      id: "synth:lab_supply:W7N5:OH",
      type: "lab_supply",
      priority: 100,
      steps: [{
        id: "U:term->lab-full",
        resource: RESOURCE_UTRIUM,
        fromKind: "terminal",
        toKind: "lab",
        fromId: terminal.id,
        toId: lab.id,
        amount: 500,
      }],
    }]);

    const done = carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(terminal, RESOURCE_UTRIUM);
    expect(done).toBe(true);
  });
});
