import { carrierRole } from "@/roles/carrier";
import { clearCarrierTaskBoardForTest, getCarrierTasksByRoom, replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState, getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { runSynthesisControl } from "@/runtime/synthesisControl";
import {
  clearMarketActionArbiterForTest,
  executeMarketDeal,
  executeTerminalSend,
} from "@/runtime/marketActionArbiter";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";

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

function installTerminalKeaniumPickupScenario(
  roomName: string,
  storedAmount: number,
  taskAmount = 800,
): {
  room: Room;
  terminal: StructureTerminal;
  target: StructureLab;
} {
  const room = createRoom(roomName);
  const terminal = room.terminal as StructureTerminal;
  Object.assign(terminal, {
    room,
    pos: { x: 10, y: 10, roomName },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_KEANIUM
          ? storedAmount
          : resource === RESOURCE_ENERGY
            ? 10_000
            : 0,
      getFreeCapacity: () => 10_000,
    },
  });
  const target = {
    id: `${roomName}-market-exposure-target`,
    structureType: STRUCTURE_LAB,
    pos: { x: 11, y: 10, roomName },
    store: {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 3_000,
    },
  } as unknown as StructureLab;
  (
    Game as Game & { getObjectById: Game["getObjectById"] }
  ).getObjectById = jest.fn((id: string) => {
    if (id === terminal.id) return terminal;
    if (id === target.id) return target;
    return null;
  }) as Game["getObjectById"];
  replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [{
    id: `${roomName}-market-exposure-haul`,
    type: "lab_supply",
    priority: 100,
    steps: [{
      id: `${roomName}-K:term->lab`,
      resource: RESOURCE_KEANIUM,
      fromKind: "terminal",
      toKind: "lab",
      fromId: terminal.id,
      toId: target.id,
      amount: taskAmount,
    }],
  }]);
  return { room, terminal, target };
}

function protectTerminalKeanium(roomName: string, amount: number): void {
  Memory.data = {
    marketSaleAutomation: {
      managedOrders: {
        managed: {
          roomName,
          resourceType: RESOURCE_KEANIUM,
          remainingExposure: amount,
        },
      },
    },
  } as unknown as Memory["data"];
}

describe("carrierRole mineral hauling", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    resetRuntimeServices();
    Game.time += 1;
    Memory.rooms = {};
    Memory.data = undefined;
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

  it("does not suicide an emergency carrier when a newer managed carrier has a different config", () => {
    const room = createRoom("W1N1", { level: 6 });
    const emergencyConfig = `${room.name}:manual:maxcarrier:test`;
    const managedConfig = `${room.name}:carrier:0`;
    const emergencyCarrier = {
      ...createCreep(room),
      name: "emergencyCarrier",
      ticksToLive: 100,
      memory: { configName: emergencyConfig },
    } as Creep;
    const managedCarrier = {
      ...createCreep(room),
      name: "managedCarrier",
      ticksToLive: 1400,
      memory: { configName: managedConfig },
    } as Creep;
    Game.creeps = {
      emergencyCarrier,
      managedCarrier,
    };
    getCreepConfigService().upsert(emergencyConfig, "carrier", [], room.name);
    getCreepConfigService().upsert(managedConfig, "carrier", [], room.name);
    getEnergyStoreTarget.mockReturnValue({ structureType: STRUCTURE_SPAWN } as StructureSpawn);

    carrierRole().source?.(emergencyCarrier);

    expect(emergencyCarrier.suicide).not.toHaveBeenCalled();
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

    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_KEANIUM, 800);
    expect(switched).toBe(true);
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
    getPickupTargetEnergyAmount.mockImplementation((target: { id: string }) =>
      target.id === protoStorage.id ? 300 : 0
    );
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

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_UTRIUM, 800);
    expect(switched).toBe(true);
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

    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_KEANIUM, 800);
    expect(switched).toBe(true);
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

    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, 800);
    expect(switched).toBe(true);
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

    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, 800);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("terminal-offload-home");
    expect(switched).toBe(true);
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

  it("uses existing owned-room carriers to collect non-energy tombstone resources", () => {
    const room = createRoom("W3N8");
    const tombstone = {
      id: "owned-tombstone-1",
      deathTime: Game.time,
      pos: {
        getRangeTo: () => 1,
      },
      store: {
        [RESOURCE_CATALYZED_GHODIUM_ACID]: 800,
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) {
            return 800;
          }
          return resource === RESOURCE_CATALYZED_GHODIUM_ACID ? 800 : 0;
        },
      },
    } as unknown as Tombstone;
    room.find = jest.fn((type: FindConstant) => (type === FIND_TOMBSTONES ? [tombstone] : [])) as Room["find"];
    let carried = 0;
    const creep = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) {
            return carried;
          }
          return resource === RESOURCE_CATALYZED_GHODIUM_ACID ? carried : 0;
        },
        getFreeCapacity: () => 800 - carried,
      },
      withdraw: jest.fn(() => {
        carried = 800;
        return OK;
      }),
    } as unknown as Creep;

    getEnergyStoreTarget.mockReturnValue(null);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(tombstone, RESOURCE_CATALYZED_GHODIUM_ACID);
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
    const room = createRoom("W4N1", { storage, terminal: null });
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

    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_KEANIUM, 800);
    expect(switched).toBe(true);
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

    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, 800);
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("terminal-offload-task");
  });

  it("prioritizes powerBankBoost carrier tasks over generic room energy demand", () => {
    const room = createRoom("W4N9");
    const spawn = {
      id: "spawn-energy-demand",
      structureType: STRUCTURE_SPAWN,
      pos: { x: 20, y: 20, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 300,
      },
    } as unknown as StructureSpawn;
    const terminal = room.terminal as StructureTerminal;
    const lab = {
      id: "powerbank-boost-lab-cleanup",
      pos: { x: 10, y: 10, roomName: room.name },
      structureType: STRUCTURE_LAB,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_LEMERGIUM ? 220 : 0),
        getFreeCapacity: () => 2780,
      },
    } as unknown as StructureLab;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(spawn);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === lab.id) return lab;
      if (id === terminal.id) return terminal;
      if (id === spawn.id) return spawn;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("powerBankBoost:task-1", room.name, [
      {
        id: "powerbank-boost-cleanup-task",
        type: "lab_cleanup",
        priority: 141,
        steps: [
          {
            id: "L:lab->terminal",
            resource: RESOURCE_LEMERGIUM,
            fromKind: "lab",
            toKind: "terminal",
            fromId: lab.id,
            toId: terminal.id,
            amount: 220,
          },
        ],
      },
    ]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(lab, RESOURCE_LEMERGIUM, 220);
    expect(getEnergyStoreTarget).not.toHaveBeenCalled();
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("powerbank-boost-cleanup-task");
  });

  it("prioritizes synthesis lab cleanup over generic room energy demand", () => {
    const room = createRoom("W4N8");
    const spawn = {
      id: "spawn-energy-demand-normal-cleanup",
      structureType: STRUCTURE_SPAWN,
      pos: { x: 20, y: 20, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 300,
      },
    } as unknown as StructureSpawn;
    const terminal = room.terminal as StructureTerminal;
    const lab = {
      id: "synthesis-lab-cleanup",
      pos: { x: 10, y: 10, roomName: room.name },
      structureType: STRUCTURE_LAB,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_CATALYZED_GHODIUM_ALKALIDE ? 120 : 0),
        getFreeCapacity: () => 2880,
      },
    } as unknown as StructureLab;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(spawn);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === lab.id) return lab;
      if (id === terminal.id) return terminal;
      if (id === spawn.id) return spawn;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [
      {
        id: "synthesis-cleanup-task",
        type: "lab_cleanup",
        priority: 200,
        steps: [
          {
            id: "XGHO2:lab->terminal",
            resource: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
            fromKind: "lab",
            toKind: "terminal",
            fromId: lab.id,
            toId: terminal.id,
            amount: 120,
          },
        ],
      },
    ]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(lab, RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 120);
    expect(getEnergyStoreTarget).not.toHaveBeenCalled();
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("synthesis-cleanup-task");
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
    carrierRole().source?.(creep);
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
    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, 800);
    expect(switched2).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("terminal-offload-assigned");
  });

  // Regression tests: terminal_offload cargo must NOT fall through to getEnergyStoreTarget()
  // when the assigned storage target is temporarily blocked (full or out of range).
  // Bug: deliverSynthesisCarrierResource returns false when storage is full,
  // then target() falls through to getEnergyStoreTarget() at line ~720.

  it("terminal_offload with energy moves toward storage when storage has free capacity", () => {
    const room = createRoom("W4N6");
    const terminal = {
      id: "terminal-target-ok",
      pos: { x: 15, y: 15, roomName: room.name },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 12000 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    const storage = room.storage as StructureStorage;
    const creep = createCreep(room);
    (creep.store as unknown as { getUsedCapacity: jest.Mock }).getUsedCapacity = jest.fn((resource?: ResourceConstant) => {
      if (resource === RESOURCE_ENERGY) return 500;
      if (resource === undefined) return 500;
      return 0;
    });
    creep.transfer = jest.fn(() => ERR_NOT_IN_RANGE);
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      return null;
    }) as Game["getObjectById"];

    replaceCarrierTasksForProducerRoom("test-offload-ok", room.name, [
      {
        id: "terminal-offload-ok-test",
        type: "terminal_offload",
        priority: 90,
        steps: [{
          id: "step-offload-ok",
          resource: RESOURCE_ENERGY,
          fromKind: "terminal",
          toKind: "storage",
          fromId: terminal.id,
          toId: storage.id,
          amount: 12000,
        }],
      },
    ]);
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "terminal-offload-ok-test";

    getEnergyStoreTarget.mockClear();
    moveToTarget.mockClear();
    getEnergyStoreTarget.mockReturnValue({ id: "fake-spawn" } as unknown as AnyStoreStructure);

    carrierRole().target(creep);

    expect(moveToTarget).toHaveBeenCalledWith(creep, storage);
    expect(getEnergyStoreTarget).not.toHaveBeenCalled();
  });

  it("terminal_offload with energy does NOT call getEnergyStoreTarget when storage is full", () => {
    const room = createRoom("W4N7");
    const terminal = {
      id: "terminal-full-storage",
      pos: { x: 15, y: 15, roomName: room.name },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 12000 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    // Storage reports full for energy
    const storage = {
      id: "W4N7-storage",
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 900000,
        getFreeCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0),
      },
    } as unknown as StructureStorage;
    const creep = createCreep(room);
    (creep.store as unknown as { getUsedCapacity: jest.Mock }).getUsedCapacity = jest.fn((resource?: ResourceConstant) => {
      if (resource === RESOURCE_ENERGY) return 500;
      if (resource === undefined) return 500;
      return 0;
    });
    creep.transfer = jest.fn(() => ERR_NOT_IN_RANGE);
    const fakeSpawnTarget = { id: "fake-spawn-full-test" } as unknown as AnyStoreStructure;
    getEnergyStoreTarget.mockReturnValue(fakeSpawnTarget);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === (storage as { id: string }).id) return storage;
      return null;
    }) as Game["getObjectById"];

    replaceCarrierTasksForProducerRoom("test-offload-full", room.name, [
      {
        id: "terminal-offload-full-test",
        type: "terminal_offload",
        priority: 90,
        steps: [{
          id: "step-offload-full",
          resource: RESOURCE_ENERGY,
          fromKind: "terminal",
          toKind: "storage",
          fromId: terminal.id,
          toId: (storage as { id: string }).id,
          amount: 12000,
        }],
      },
    ]);
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "terminal-offload-full-test";

    getEnergyStoreTarget.mockClear();
    moveToTarget.mockClear();

    carrierRole().target(creep);

    // BUG: current code falls through to getEnergyStoreTarget when storage is full
    expect(getEnergyStoreTarget).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalledWith(creep, fakeSpawnTarget);
  });

  it("carrier without synthesis task still uses generic getEnergyStoreTarget", () => {
    const room = createRoom("W4N8");
    const storage = room.storage as StructureStorage;
    const creep = createCreep(room);
    (creep.store as unknown as { getUsedCapacity: jest.Mock }).getUsedCapacity = jest.fn((resource?: ResourceConstant) => {
      if (resource === RESOURCE_ENERGY) return 500;
      if (resource === undefined) return 500;
      return 0;
    });
    creep.transfer = jest.fn(() => ERR_NOT_IN_RANGE);
    const fakeSpawn = { id: "fake-spawn-generic" } as unknown as AnyStoreStructure;
    getEnergyStoreTarget.mockReturnValue(fakeSpawn);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      return null;
    }) as Game["getObjectById"];

    getEnergyStoreTarget.mockClear();
    moveToTarget.mockClear();

    carrierRole().target(creep);

    expect(getEnergyStoreTarget).toHaveBeenCalled();
    expect(moveToTarget).toHaveBeenCalledWith(creep, fakeSpawn);
  });

  it("terminal_offload with non-energy resource does not move toward generic energy target", () => {
    const room = createRoom("W4N9");
    const terminal = {
      id: "terminal-mineral-offload",
      pos: { x: 15, y: 15, roomName: room.name },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 5000 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    const storage = {
      id: "W4N9-storage",
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 900000,
        getFreeCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 0 : 0),
      },
    } as unknown as StructureStorage;
    const creep = createCreep(room);
    (creep.store as unknown as { getUsedCapacity: jest.Mock }).getUsedCapacity = jest.fn((resource?: ResourceConstant) => {
      if (resource === RESOURCE_KEANIUM) return 500;
      if (resource === RESOURCE_ENERGY) return 200;
      if (resource === undefined) return 700;
      return 0;
    });
    creep.transfer = jest.fn(() => ERR_NOT_IN_RANGE);
    const fakeExtension = { id: "fake-extension-mineral-test" } as unknown as AnyStoreStructure;
    getEnergyStoreTarget.mockReturnValue(fakeExtension);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === (storage as { id: string }).id) return storage;
      return null;
    }) as Game["getObjectById"];

    replaceCarrierTasksForProducerRoom("test-offload-mineral", room.name, [
      {
        id: "terminal-offload-mineral-test",
        type: "terminal_offload",
        priority: 90,
        steps: [{
          id: "step-offload-mineral",
          resource: RESOURCE_KEANIUM,
          fromKind: "terminal",
          toKind: "storage",
          fromId: terminal.id,
          toId: (storage as { id: string }).id,
          amount: 5000,
        }],
      },
    ]);
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "terminal-offload-mineral-test";

    getEnergyStoreTarget.mockClear();
    moveToTarget.mockClear();

    carrierRole().target(creep);

    // BUG: non-energy cargo should NOT fall through to getEnergyStoreTarget
    expect(moveToTarget).not.toHaveBeenCalledWith(creep, fakeExtension);
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
    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_KEANIUM, 800);
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("mineral-haul-assigned");
  });

  // ── Phase-jitter regression tests ────────────────────────────────────────
  // In live Screeps, withdraw(OK) and transfer(OK) do NOT immediately mutate
  // creep.store. The store update arrives next tick. This causes:
  //  1. source() returning false after withdraw(OK) because store is still 0.
  //  2. target() clearing the task when selectDeliveryStep sees store=0.
  // These tests MUST FAIL against the current implementation to confirm the bug.


  // ── Terminal energy pickup config ──────────────────────────────────

  it("picks only terminal energy above the 50k reserve by default", () => {
    Memory.cfg = {};
    const room = createRoom("E7N58");
    const terminal = {
      id: "E7N58-terminal-surplus",
      pos: { x: 15, y: 15, roomName: "E7N58" },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50_600 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    (room as { terminal: StructureTerminal }).terminal = terminal;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue({
      id: "E7N58-spawn-demand",
      structureType: STRUCTURE_SPAWN,
    } as unknown as StructureSpawn);
    getPickupTargetEnergyAmount.mockImplementation((target: { id: string }) =>
      target.id === terminal.id ? 600 : 0
    );
    reservePickupTarget.mockImplementation((_creep: Creep, target: { id: string }) => target.id === terminal.id);

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, 600);
  });

  it("does not use terminal surplus when the current demand is not a spawn or extension", () => {
    const room = createRoom("E7N58");
    const terminal = {
      id: "E7N58-terminal-non-spawn",
      pos: { x: 15, y: 15, roomName: "E7N58" },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 55_000 : 0),
        getFreeCapacity: () => 10_000,
      },
    } as unknown as StructureTerminal;
    const tower = {
      id: "E7N58-tower",
      structureType: STRUCTURE_TOWER,
      store: { getFreeCapacity: () => 500 },
    } as unknown as StructureTower;
    (room as { terminal: StructureTerminal }).terminal = terminal;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(tower);
    getPickupTargetEnergyAmount.mockImplementation((target: { id: string }) =>
      target.id === terminal.id ? 5_000 : 0
    );
    reservePickupTarget.mockImplementation((_creep: Creep, target: { id: string }) => target.id === terminal.id);

    carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, expect.any(Number));
  });

  it("does not pick up terminal energy at or below the 50k reserve", () => {
    const room = createRoom("E7N58");
    const terminal = {
      id: "E7N58-terminal",
      pos: { x: 15, y: 15, roomName: "E7N58" },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 5000 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    (room as any).terminal = terminal;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue({
      id: "E7N58-spawn-reserve-demand",
      structureType: STRUCTURE_SPAWN,
    } as unknown as StructureSpawn);
    getPickupTargetEnergyAmount.mockReturnValue(0);
    reservePickupTarget.mockImplementation((_creep: Creep, target: { id: string }) => target.id === terminal.id);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
    expect(switched).toBe(false);
  });

  it("keeps explicit terminal pickup enablement compatible with the reserve", () => {
    const room = createRoom("E7N58");
    const terminal = {
      id: "E7N58-terminal-enabled",
      pos: { x: 15, y: 15, roomName: "E7N58" },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 55_000 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    (room as any).terminal = terminal;
    let carried = 0;
    const creep = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? carried : resource === undefined ? carried : 0),
        getFreeCapacity: () => 800 - carried,
      },
      withdraw: jest.fn(() => { carried = 800; return OK; }),
    } as unknown as Creep;
    Memory.cfg = { energyPickup: { terminalPickupRooms: { "E7N58": true } } };
    getEnergyStoreTarget.mockReturnValue({
      id: "E7N58-spawn-enabled-demand",
      structureType: STRUCTURE_SPAWN,
    } as unknown as StructureSpawn);
    getPickupTargetEnergyAmount.mockImplementation((target: { id: string }) => (target.id === terminal.id ? 5000 : 0));
    reservePickupTarget.mockImplementation((_creep: Creep, target: { id: string }) => target.id === terminal.id);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, 800);
    expect(switched).toBe(true);
  });

  it("allows an explicit room config to disable terminal surplus pickup", () => {
    const room = createRoom("W1N1");
    const terminal = {
      id: "W1N1-terminal",
      pos: { x: 15, y: 15, roomName: "W1N1" },
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 55_000 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    (room as any).terminal = terminal;
    const creep = createCreep(room);
    Memory.cfg = { energyPickup: { terminalPickupRooms: { W1N1: false } } };
    getEnergyStoreTarget.mockReturnValue({
      id: "W1N1-spawn-disabled-demand",
      structureType: STRUCTURE_SPAWN,
    } as unknown as StructureSpawn);
    getPickupTargetEnergyAmount.mockImplementation((target: { id: string }) => (target.id === terminal.id ? 5000 : 0));
    reservePickupTarget.mockImplementation((_creep: Creep, target: { id: string }) => target.id === terminal.id);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
    expect(switched).toBe(false);
  });


});

describe("carrierRole lab logistics", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    resetRuntimeServices();
    Game.time += 1;
    Memory.rooms = {};
    Memory.data = undefined;
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

    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_UTRIUM, 500);
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("synth:lab_supply:W7N1:OH");

    const done = carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(lab, RESOURCE_UTRIUM);
    expect(done).toBe(true);
  });

  it("托管卖单撤销确认前不搬走 Terminal exposure，确认删除后恢复", () => {
    const room = createRoom("W71N1");
    const terminal = room.terminal as StructureTerminal;
    (terminal as { store: StoreDefinition }).store = {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_KEANIUM ? 800 : 0,
      getFreeCapacity: () => 10_000,
    } as StoreDefinition;
    const lab = {
      id: "market-exposure-target",
      structureType: STRUCTURE_LAB,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3_000,
      },
    } as unknown as StructureLab;
    const creep = {
      ...createCreep(room),
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    (
      Game as Game & { getObjectById: Game["getObjectById"] }
    ).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === lab.id) return lab;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [{
      id: "market-exposure-haul",
      type: "lab_supply",
      priority: 100,
      steps: [{
        id: "K:term->lab",
        resource: RESOURCE_KEANIUM,
        fromKind: "terminal",
        toKind: "lab",
        fromId: terminal.id,
        toId: lab.id,
        amount: 500,
      }],
    }]);
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {
          managed: {
            roomName: room.name,
            resourceType: RESOURCE_KEANIUM,
            remainingExposure: 800,
          },
        },
        pendingMutations: {
          managed: {
            kind: "cancel",
            orderId: "managed",
            requestedAt: Game.time,
          },
        },
      },
    } as unknown as Memory["data"];

    carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalled();

    delete Memory.data!.marketSaleAutomation!.managedOrders.managed;
    delete Memory.data!.marketSaleAutomation!.pendingMutations.managed;
    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_KEANIUM,
      500,
    );
  });

  it("两个 carrier 同 tick 原子领取 Terminal 非 exposure 数量并缩量第二次取货", () => {
    clearMarketSaleExposureReservationsForTest();
    const { room, terminal } = installTerminalKeaniumPickupScenario(
      "W72N1",
      1_800,
    );
    protectTerminalKeanium(room.name, 800);
    const first = {
      ...createCreep(room),
      name: "carrier-exposure-first",
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    const second = {
      ...createCreep(room),
      name: "carrier-exposure-second",
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);

    carrierRole().source?.(first);
    carrierRole().source?.(second);

    expect(first.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_KEANIUM,
      800,
    );
    expect(second.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_KEANIUM,
      200,
    );
  });

  it("carrier withdraw 非 OK 与异常都会释放 Terminal exposure claim", () => {
    clearMarketSaleExposureReservationsForTest();
    const { room, terminal } = installTerminalKeaniumPickupScenario(
      "W73N1",
      1_800,
    );
    protectTerminalKeanium(room.name, 800);
    const failed = {
      ...createCreep(room),
      name: "carrier-exposure-failed",
      withdraw: jest.fn(() => ERR_NOT_IN_RANGE),
    } as unknown as Creep;
    const threw = {
      ...createCreep(room),
      name: "carrier-exposure-threw",
      withdraw: jest.fn(() => {
        throw new Error("withdraw failed");
      }),
    } as unknown as Creep;
    const succeeded = {
      ...createCreep(room),
      name: "carrier-exposure-succeeded",
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);

    carrierRole().source?.(failed);
    expect(failed.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_KEANIUM,
      800,
    );
    expect(() => carrierRole().source?.(threw)).toThrow("withdraw failed");
    expect(threw.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_KEANIUM,
      800,
    );
    carrierRole().source?.(succeeded);
    expect(succeeded.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_KEANIUM,
      800,
    );
  });

  it("成功 send 后同 tick carrier 不读取旧 store，下一 tick 才重新计算", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const { room, terminal } = installTerminalKeaniumPickupScenario(
      "W74N1",
      1_000,
    );
    protectTerminalKeanium(room.name, 800);
    (terminal as unknown as { send: jest.Mock }).send = jest.fn(() => OK);
    const carrier = {
      ...createCreep(room),
      name: "carrier-after-send",
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);

    expect(executeTerminalSend({
      terminal,
      resourceType: RESOURCE_KEANIUM,
      amount: 200,
      transactionCost: 100,
      destinationRoomName: "W75N1",
      actor: "resourceControl:test",
    })).toBe(OK);
    carrierRole().source?.(carrier);
    expect(carrier.withdraw).not.toHaveBeenCalled();

    Game.time += 1;
    carrierRole().source?.(carrier);
    expect(carrier.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_KEANIUM,
      200,
    );
  });

  it("成功 market deal 后同 tick carrier 等待，购买动作本身仍正常执行", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const { room } = installTerminalKeaniumPickupScenario(
      "W76N1",
      1_800,
    );
    protectTerminalKeanium(room.name, 800);
    const market = {
      deal: jest.fn(() => OK),
      calcTransactionCost: jest.fn(() => 0),
    };
    (Game as unknown as { market: typeof market }).market = market;
    const carrier = {
      ...createCreep(room),
      name: "carrier-after-market-deal",
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);

    expect(
      executeMarketDeal(
        "buy-order",
        500,
        room.name,
        "boostControl:buy",
        {
          orderType: ORDER_SELL,
          resourceType: RESOURCE_CATALYZED_UTRIUM_ACID,
          orderRoomName: "W75N1",
        },
      ),
    ).toBe(OK);
    carrierRole().source?.(carrier);

    expect(market.deal).toHaveBeenCalledWith(
      "buy-order",
      500,
      room.name,
    );
    expect(carrier.withdraw).not.toHaveBeenCalled();
  });

  it("generic carrier 从 Terminal 取 energy 时只使用 Direct transaction-energy reservation 外余量", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const room = createRoom("W77N1");
    const terminal = room.terminal as StructureTerminal;
    Object.assign(terminal, {
      room,
      pos: {
        getRangeTo: () => 1,
      },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 2_000 : 0,
        getFreeCapacity: () => 10_000,
      },
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-terminal-energy",
            status: "submitted",
            canaryRoomName: room.name,
            resource: RESOURCE_KEANIUM,
            dealAmount: 1_000,
            transactionEnergy: 1_500,
          },
        },
      },
    } as unknown as Memory["data"];
    const spawnTarget = {
      structureType: STRUCTURE_SPAWN,
    } as AnyStoreStructure;
    const carrier = {
      ...createCreep(room),
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(spawnTarget);
    getPickupTargetEnergyAmount.mockImplementation(
      (target: unknown) => target === terminal ? 2_000 : 0,
    );
    reservePickupTarget.mockReturnValue(true);

    carrierRole().source?.(carrier);

    expect(carrier.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_ENERGY,
      500,
    );
  });

  it("task-bound Synthesis carrier 只搬 Direct 待售资源 reservation 外余量", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const { room, terminal } = installTerminalKeaniumPickupScenario(
      "W78N1",
      1_800,
    );
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-synthesis",
            status: "reconcile_gap",
            canaryRoomName: room.name,
            resource: RESOURCE_KEANIUM,
            dealAmount: 1_000,
            transactionEnergy: 500,
          },
        },
      },
    } as unknown as Memory["data"];
    const carrier = {
      ...createCreep(room),
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);

    carrierRole().source?.(carrier);

    expect(carrier.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_KEANIUM,
      800,
    );
  });

  it("完全预留的高优先级 Terminal task 不得连续饿死 reservation 外生产 task", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const room = createRoom("W79N1");
    const terminal = room.terminal as StructureTerminal;
    const storage = room.storage as StructureStorage;
    Object.assign(terminal, {
      room,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_KEANIUM ? 1_000 : 0,
        getFreeCapacity: () => 10_000,
      },
    });
    Object.assign(storage, {
      room,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_UTRIUM ? 800 : 0,
        getFreeCapacity: () => 10_000,
      },
    });
    const keaniumLab = {
      id: "W79N1-k-lab",
      structureType: STRUCTURE_LAB,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3_000,
      },
    } as unknown as StructureLab;
    const utriumLab = {
      id: "W79N1-u-lab",
      structureType: STRUCTURE_LAB,
      pos: { x: 13, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3_000,
      },
    } as unknown as StructureLab;
    (
      Game as Game & { getObjectById: Game["getObjectById"] }
    ).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      if (id === keaniumLab.id) return keaniumLab;
      if (id === utriumLab.id) return utriumLab;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom(
      "synthesisControl:reserved",
      room.name,
      [{
        id: "reserved-k-task",
        type: "lab_supply",
        priority: 200,
        steps: [{
          id: "K:terminal->lab",
          resource: RESOURCE_KEANIUM,
          fromKind: "terminal",
          toKind: "lab",
          fromId: terminal.id,
          toId: keaniumLab.id,
          amount: 1_000,
        }],
      }],
    );
    replaceCarrierTasksForProducerRoom(
      "synthesisControl:available",
      room.name,
      [{
        id: "available-u-task",
        type: "lab_supply",
        priority: 100,
        steps: [{
          id: "U:storage->lab",
          resource: RESOURCE_UTRIUM,
          fromKind: "storage",
          toKind: "lab",
          fromId: storage.id,
          toId: utriumLab.id,
          amount: 800,
        }],
      }],
    );
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-full-k-reservation",
            status: "reconcile_gap",
            canaryRoomName: room.name,
            resource: RESOURCE_KEANIUM,
            dealAmount: 1_000,
            transactionEnergy: 0,
          },
        },
      },
    } as unknown as Memory["data"];
    const carrier = {
      ...createCreep(room),
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);

    carrierRole().source?.(carrier);
    Game.time += 1;
    carrierRole().source?.(carrier);

    expect(carrier.withdraw).not.toHaveBeenCalledWith(
      terminal,
      RESOURCE_KEANIUM,
      expect.anything(),
    );
    expect(carrier.withdraw).toHaveBeenNthCalledWith(
      1,
      storage,
      RESOURCE_UTRIUM,
      800,
    );
    expect(carrier.withdraw).toHaveBeenNthCalledWith(
      2,
      storage,
      RESOURCE_UTRIUM,
      800,
    );
    expect(
      getCreepAssignmentState(carrier.name)
        ?.synthesisCarrierTaskId,
    ).toBe("available-u-task");
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

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_UTRIUM, 500);
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("synth:lab_supply:W7N2:OH");
  });

  it("drops blocked energy so an urgent power-bank boost supply can start", () => {
    const terminal = {
      id: "war-boost-terminal",
      structureType: STRUCTURE_TERMINAL,
      pos: { x: 10, y: 10, roomName: "W7N2" },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => resource === RESOURCE_CATALYZED_UTRIUM_ACID ? 300 : 0,
        getFreeCapacity: () => 0,
      },
    } as unknown as StructureTerminal;
    const storage = {
      id: "war-boost-storage",
      structureType: STRUCTURE_STORAGE,
      pos: { x: 11, y: 10, roomName: "W7N2" },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 0,
      },
    } as unknown as StructureStorage;
    const room = createRoom("W7N2", { terminal, storage });
    const lab = {
      id: "war-boost-lab",
      structureType: STRUCTURE_LAB,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3000,
      },
    } as unknown as StructureLab;
    let carried = 800;
    const creep = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => resource === undefined || resource === RESOURCE_ENERGY ? carried : 0,
        getFreeCapacity: () => 800 - carried,
      },
      drop: jest.fn(() => {
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
    replaceCarrierTasksForProducerRoom("powerBankBoost:war:W7N2:W8N2", room.name, [{
      id: "powerBankBoost:lab_supply:war:W7N2:W8N2:XUH2O",
      type: "lab_supply",
      priority: 140,
      steps: [{
        id: "XUH2O:terminal->lab",
        resource: RESOURCE_CATALYZED_UTRIUM_ACID,
        fromKind: "terminal",
        toKind: "lab",
        fromId: terminal.id,
        toId: lab.id,
        amount: 300,
      }],
    }]);

    const done = carrierRole().target?.(creep);

    expect(creep.drop).toHaveBeenCalledWith(RESOURCE_ENERGY);
    expect(done).toBe(true);
  });

  it("delivers reagent to lab via snapshot when board is cleared after pickup (lab_supply)", () => {
    const room = createRoom("W8N1");
    const terminal = room.terminal as StructureTerminal;
    (terminal as { store: StoreDefinition }).store = {
      getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_OXYGEN ? 500 : 0),
      getFreeCapacity: () => 10000,
    } as StoreDefinition;
    const lab = {
      id: "lab-snapshot-1",
      structureType: STRUCTURE_LAB,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3000,
      },
    } as unknown as StructureLab;
    let carried = 100;
    const store = {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return carried;
        return resource === RESOURCE_OXYGEN ? carried : 0;
      },
      getFreeCapacity: () => 800 - carried,
    };
    const creep = {
      ...createCreep(room),
      store,
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

    const state = ensureCreepAssignmentState(creep.name);
    state.synthesisCarrierTaskId = "synth:lab_supply:W8N1:H2O2";
    state.synthesisCarrierPendingPickupTick = Game.time - 1;
    state.synthesisCarrierPendingStepId = "O:term->lab";
    state.synthesisCarrierPendingFromId = terminal.id;
    state.synthesisCarrierPendingToId = lab.id;
    state.synthesisCarrierPendingResource = RESOURCE_OXYGEN;

    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, []);

    const done = carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(lab, RESOURCE_OXYGEN);
    expect(done).toBe(true);
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

    expect(creep.withdraw).toHaveBeenCalledWith(lab, RESOURCE_KEANIUM, 300);
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
          getFreeCapacity: () => 0,
        },
      } as unknown as StructureTerminal,
      storage: {
        id: "W7N4-storage",
        structureType: STRUCTURE_STORAGE,
        store: {
          getUsedCapacity: () => 900000,
          getFreeCapacity: () => 0,
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

  it("withdraws product from lab and transfers to storage via lab_product_unload task", () => {
    const room = createRoom("W8N1");
    const storage = room.storage as StructureStorage;
    const lab = {
      id: "lab-product-unload-1",
      structureType: STRUCTURE_LAB,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === RESOURCE_UTRIUM_OXIDE as ResourceConstant) return 110;
          return resource === undefined ? 110 : 0;
        },
        getFreeCapacity: () => 2890,
      },
    } as unknown as StructureLab;
    let carried = 0;
    const store: Record<string, unknown> & { getUsedCapacity: (r?: ResourceConstant) => number; getFreeCapacity: () => number } = {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return carried;
        return resource === (RESOURCE_UTRIUM_OXIDE as ResourceConstant) ? carried : 0;
      },
      getFreeCapacity: () => 600,
    };
    const creep = {
      ...createCreep(room),
      memory: {},
      store,
      withdraw: jest.fn(() => {
        carried = 110;
        (store as any)[RESOURCE_UTRIUM_OXIDE] = 110;
        return OK;
      }),
      transfer: jest.fn(() => {
        carried = 0;
        delete (store as any)[RESOURCE_UTRIUM_OXIDE];
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [{
      id: "synthesis:lab_product_unload:W8N1:UO",
      type: "lab_product_unload",
      priority: 180,
      steps: [{
        id: "UO:lab-product-unload-1->storage",
        resource: RESOURCE_UTRIUM_OXIDE as ResourceConstant,
        fromKind: "lab",
        toKind: "storage",
        fromId: lab.id,
        toId: storage.id,
        amount: 110,
      }],
    }]);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === lab.id) return lab;
      if (id === storage.id) return storage;
      if (id === (room.terminal as StructureTerminal).id) return room.terminal;
      return null;
    }) as Game["getObjectById"];

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(lab, RESOURCE_UTRIUM_OXIDE as ResourceConstant, 110);
    expect(switched).toBe(true);

    const done = carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(storage, RESOURCE_UTRIUM_OXIDE as ResourceConstant);
    expect(done).toBe(true);
  });

  it("multi-tick synthesis jitter: carrier pickup → board refresh → delivery stays stable", () => {
    // ---- Setup room W8N1 with terminal, storage, 3 labs (2 reagent + 1 product) ----
    const room = createRoom("W8N1", { level: 7 });
    const terminal = room.terminal as StructureTerminal;
    const storage = room.storage as StructureStorage;

    // Mutable resource maps for terminal and storage
    const terminalMap: Record<string, number> = { [RESOURCE_OXYGEN]: 1000, [RESOURCE_HYDROGEN]: 1000 };
    const storageMap: Record<string, number> = { [RESOURCE_ENERGY]: 500000 };
    (terminal as { store: StoreDefinition }).store = {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return Object.values(terminalMap).reduce((s, v) => s + v, 0);
        return terminalMap[resource] ?? 0;
      },
      getFreeCapacity: () => 300000 - Object.values(terminalMap).reduce((s, v) => s + v, 0),
    } as StoreDefinition;
    (storage as { store: StoreDefinition }).store = {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return Object.values(storageMap).reduce((s, v) => s + v, 0);
        return storageMap[resource] ?? 0;
      },
      getFreeCapacity: () => 1000000 - Object.values(storageMap).reduce((s, v) => s + v, 0),
    } as StoreDefinition;

    // Create 3 labs: oxygen reagent, hydrogen reagent, product
    const oxygenLab = {
      id: "W8N1-lab-O",
      structureType: STRUCTURE_LAB,
      room,
      pos: { x: 10, y: 10, roomName: room.name, inRangeTo: () => true } as unknown as RoomPosition,
      store: createStore({} as Record<string, number>),
      runReaction: jest.fn(() => OK),
      cooldown: 0,
      mineralType: undefined,
    } as unknown as StructureLab;
    const hydrogenLab = {
      id: "W8N1-lab-H",
      structureType: STRUCTURE_LAB,
      room,
      pos: { x: 11, y: 10, roomName: room.name, inRangeTo: () => true } as unknown as RoomPosition,
      store: createStore({} as Record<string, number>),
      runReaction: jest.fn(() => OK),
      cooldown: 0,
      mineralType: undefined,
    } as unknown as StructureLab;
    const productLab = {
      id: "W8N1-lab-product",
      structureType: STRUCTURE_LAB,
      room,
      pos: { x: 10, y: 11, roomName: room.name, inRangeTo: () => true } as unknown as RoomPosition,
      store: createStore({} as Record<string, number>),
      runReaction: jest.fn(() => OK),
      cooldown: 0,
      mineralType: undefined,
    } as unknown as StructureLab;
    const allLabs = [oxygenLab, hydrogenLab, productLab];

    // Mock room.find to return labs
    (room as any).find = ((type: FindConstant, opts?: { filter?: (structure: Structure) => boolean }) => {
      if (type === FIND_MY_STRUCTURES) {
        const filtered = opts?.filter
          ? allLabs.filter((s: any) => opts.filter!(s as Structure))
          : allLabs;
        return filtered;
      }
      if (type === FIND_MINERALS) return [];
      return [];
    }) as Room["find"];

    // Mock Game.getObjectById to resolve all structures
    const objectMap: Record<string, any> = {
      [terminal.id]: terminal,
      [storage.id]: storage,
      [oxygenLab.id]: oxygenLab,
      [hydrogenLab.id]: hydrogenLab,
      [productLab.id]: productLab,
    };
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      return objectMap[id] ?? null;
    }) as Game["getObjectById"];

    // Set synthesis config for OH (hydroxide = oxygen + hydrogen)
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        sampleInterval: 100,
        defaultBatchSize: 500,
        defaultMaxRunsPerTick: 6,
        rooms: {
          W8N1: {
            enabled: true,
            batchSize: 500,
            maxRunsPerTick: 6,
            donorRoomNames: [],
            reagentLabIds: [oxygenLab.id, hydrogenLab.id],
            reactions: [
              { product: RESOURCE_HYDROXIDE as ResourceConstant, targetAmount: 5000 },
            ],
          },
        },
      },
    };
    Game.rooms["W8N1"] = room;
    Game.creeps = {};

    // Create mutable carrier store
    let carriedOxygen = 0;
    let carriedHydrogen = 0;
    const carrierStore = {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return carriedOxygen + carriedHydrogen;
        if (resource === RESOURCE_OXYGEN) return carriedOxygen;
        if (resource === RESOURCE_HYDROGEN) return carriedHydrogen;
        return 0;
      },
      getFreeCapacity: () => 800 - carriedOxygen - carriedHydrogen,
    };

    // Create carrier creep
    const creep = {
      ...createCreep(room),
      name: "carrier-W8N1-1",
      store: carrierStore,
      withdraw: jest.fn((_target: any, resource: ResourceConstant) => {
        if (resource === RESOURCE_OXYGEN) { carriedOxygen = 500; terminalMap[RESOURCE_OXYGEN] -= 500; }
        if (resource === RESOURCE_HYDROGEN) { carriedHydrogen = 500; terminalMap[RESOURCE_HYDROGEN] -= 500; }
        return OK;
      }),
      transfer: jest.fn((_target: any, resource: ResourceConstant) => {
        if (resource === RESOURCE_OXYGEN) { carriedOxygen = 0; }
        if (resource === RESOURCE_HYDROGEN) { carriedHydrogen = 0; }
        return OK;
      }),
    } as unknown as Creep;

    getEnergyStoreTarget.mockReturnValue(null);

    // Helper: make lab store mutable via a resource map
    function createStore(resourceMap: Record<string, number>) {
      return {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) return Object.values(resourceMap).reduce((s, v) => s + v, 0);
          return resourceMap[resource] ?? 0;
        },
        getFreeCapacity: () => 3000 - Object.values(resourceMap).reduce((s, v) => s + v, 0),
      };
    }

    // Mutable lab resource maps for simulating deliveries
    const oxygenLabResources: Record<string, number> = {};
    const hydrogenLabResources: Record<string, number> = {};
    (oxygenLab as any).store = createStore(oxygenLabResources);
    (hydrogenLab as any).store = createStore(hydrogenLabResources);

    // =============================================
    // TICK N (Game.time = 100)
    // =============================================
    const baseTime = 100;
    Game.time = baseTime;
    // Clear runtime so tick context rebuilds
    resetRuntimeServices();

    // Run synthesis control — should detect OH needed → enter loading → create lab_supply task
    runSynthesisControl();

    // Verify board has lab_supply task
    const tasksN = getCarrierTasksByRoom("W8N1");
    const supplyTaskN = Object.values(tasksN).find(t => t.type === "lab_supply");
    expect(supplyTaskN).toBeDefined();
    // Should have oxygen step targeting the oxygen lab
    const oxygenStepN = supplyTaskN!.steps.find(s => s.resource === RESOURCE_OXYGEN);
    expect(oxygenStepN).toBeDefined();
    expect(oxygenStepN!.toId).toBe(oxygenLab.id);

    // Register carrier in Game.creeps for in-flight detection
    (Game as any).creeps = { "carrier-W8N1-1": creep };

    // Carrier picks up oxygen from terminal
    const switched = carrierRole().source?.(creep);
    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_OXYGEN, 500);
    expect(switched).toBe(true);
    expect(carriedOxygen).toBe(500);

    // Verify carrier state has snapshot fields set
    const stateN = getCreepAssignmentState(creep.name);
    expect(stateN?.synthesisCarrierTaskId).toBe(supplyTaskN!.id);
    expect(stateN?.synthesisCarrierPendingToId).toBe(oxygenLab.id);
    expect(stateN?.synthesisCarrierPendingResource).toBe(RESOURCE_OXYGEN);

    // =============================================
    // TICK N+1 (Game.time = 101)
    // This is the CRITICAL jitter tick: synthesisControl refreshes the board
    // while carrier has in-flight cargo. The oxygen step must NOT be duplicated.
    // =============================================
    Game.time = baseTime + 1;
    resetRuntimeServices();

    runSynthesisControl();

    // Assert: oxygen lab_supply step is NOT duplicated for the oxygen lab
    // (because carrier has in-flight cargo via snapshot → countInFlightSynthesisCargo returns 500)
    const tasksN1 = getCarrierTasksByRoom("W8N1");
    const supplyTaskN1 = Object.values(tasksN1).find(t => t.type === "lab_supply");
    if (supplyTaskN1) {
      const oxygenStepN1 = supplyTaskN1.steps.find(s => s.resource === RESOURCE_OXYGEN && s.toId === oxygenLab.id);
      // The oxygen step should NOT appear — in-flight 500 covers the deficit
      expect(oxygenStepN1).toBeUndefined();
    }
    // If no supply task at all, oxygen was suppressed — also fine.

    // Carrier delivers oxygen to the lab
    (creep.transfer as jest.Mock).mockClear();
    const done = carrierRole().target(creep);
    expect(creep.transfer).toHaveBeenCalledWith(oxygenLab, RESOURCE_OXYGEN);
    expect(done).toBe(true);
    expect(carriedOxygen).toBe(0);

    // Simulate the lab receiving the resource
    oxygenLabResources[RESOURCE_OXYGEN] = 500;
    (oxygenLab as any).mineralType = RESOURCE_OXYGEN;

    // =============================================
    // TICK N+2 (Game.time = 102)
    // Synthesis control refreshes again. Lab now has 500 oxygen.
    // No duplicate oxygen supply should be created.
    // =============================================
    Game.time = baseTime + 2;
    resetRuntimeServices();

    runSynthesisControl();

    // Assert: room state is stable — no duplicate supply for oxygen
    const tasksN2 = getCarrierTasksByRoom("W8N1");
    const supplyTaskN2 = Object.values(tasksN2).find(t => t.type === "lab_supply");
    if (supplyTaskN2) {
      const oxygenStepN2 = supplyTaskN2.steps.find(s => s.resource === RESOURCE_OXYGEN && s.toId === oxygenLab.id);
      // Lab already has 500 oxygen — no new demand
      expect(oxygenStepN2).toBeUndefined();
    }

    // Verify room stage is loading or synthesizing (not idle/blocked)
    const roomState = Memory.runtime?.synthesisControl?.rooms?.["W8N1"];
    expect(roomState).toBeDefined();
    expect(roomState!.stage).not.toBe("blocked");
  });

  // ========================================================
  // RED regression tests for lab_supply jitter defects
  // These tests MUST fail against the current implementation.
  // ========================================================

  it("withdraws only the lab_supply step amount (not the full terminal stock)", () => {
    const room = createRoom("W9N1");
    const terminal = room.terminal as StructureTerminal;
    (terminal as { store: StoreDefinition }).store = {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_HYDROXIDE ? 800 : 0,
      getFreeCapacity: () => 10000,
    } as StoreDefinition;
    const lab = {
      id: "lab-over-withdraw-1",
      structureType: STRUCTURE_LAB,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3000,
      },
    } as unknown as StructureLab;

    const creep = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (_resource?: ResourceConstant) => 0,
        getFreeCapacity: () => 800,
      },
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;

    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === lab.id) return lab;
      return null;
    }) as Game["getObjectById"];

    // lab_supply task with amount=45 (less than terminal stock and creep capacity)
    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [{
      id: "synth:lab_supply:W9N1:OH",
      type: "lab_supply",
      priority: 100,
      steps: [{
        id: "OH:term->lab",
        resource: RESOURCE_HYDROXIDE,
        fromKind: "terminal",
        toKind: "lab",
        fromId: terminal.id,
        toId: lab.id,
        amount: 45,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    // BUG: current code calls withdraw(terminal, RESOURCE_HYDROXIDE) without amount.
    // FIX should call withdraw(terminal, RESOURCE_HYDROXIDE, 45).
    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_HYDROXIDE, 45);
    expect(switched).toBe(true);
  });

  it("delivers stale committed lab_supply cargo to lab (not terminal/storage)", () => {
    const room = createRoom("W9N2");
    const terminal = room.terminal as StructureTerminal;
    (terminal as { store: StoreDefinition }).store = {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 10000,
    } as StoreDefinition;
    const storage = room.storage as StructureStorage;
    (storage as { store: StoreDefinition }).store = {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 100000,
    } as StoreDefinition;
    const lab = {
      id: "lab-stale-1",
      structureType: STRUCTURE_LAB,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3000,
      },
    } as unknown as StructureLab;

    // Creep is carrying OH
    let staleCarried = 100;
    const creep = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) return staleCarried;
          return resource === RESOURCE_HYDROXIDE ? staleCarried : 0;
        },
        getFreeCapacity: () => 800 - staleCarried,
      },
      transfer: jest.fn(() => { staleCarried = 0; return OK; }),
    } as unknown as Creep;

    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      if (id === lab.id) return lab;
      return null;
    }) as Game["getObjectById"];

    // Set up assignment state with stale snapshot
    const state = ensureCreepAssignmentState(creep.name);
    state.synthesisCarrierTaskId = "synth:lab_supply:W9N2:OH";
    state.synthesisCarrierPendingPickupTick = Game.time - 5; // stale: older than Game.time - 1
    state.synthesisCarrierPendingStepId = "OH:term->lab";
    state.synthesisCarrierPendingFromId = terminal.id;
    state.synthesisCarrierPendingToId = lab.id;
    state.synthesisCarrierPendingResource = RESOURCE_HYDROXIDE;

    // Board has been cleared — no tasks remain
    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, []);

    const done = carrierRole().target(creep);

    // BUG: current code falls through to generic cleanup because pickupTick is stale,
    // routing OH to terminal via getSynthesisCleanupDeliveryTarget instead of the lab.
    // FIX should deliver to lab using snapshot fields regardless of pickup tick staleness.
    expect(creep.transfer).toHaveBeenCalledWith(lab, RESOURCE_HYDROXIDE);
    expect(done).toBe(true);
  });

  it("multi-tick stale pickup still delivers to committed lab (not generic cleanup)", () => {
    const room = createRoom("W9N3");
    const terminal = room.terminal as StructureTerminal;
    (terminal as { store: StoreDefinition }).store = {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_HYDROXIDE ? 800 : 0,
      getFreeCapacity: () => 10000,
    } as StoreDefinition;
    const storage = room.storage as StructureStorage;
    (storage as { store: StoreDefinition }).store = {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 100000,
    } as StoreDefinition;
    const lab = {
      id: "lab-multi-tick-1",
      structureType: STRUCTURE_LAB,
      pos: { x: 10, y: 10, roomName: room.name, inRangeTo: () => false } as unknown as RoomPosition,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 3000,
      },
    } as unknown as StructureLab;

    let carriedOH = 0;
    let transferRangeOK = false;
    const creep = {
      ...createCreep(room),
      name: "carrier-W9N3-1",
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) return carriedOH;
          return resource === RESOURCE_HYDROXIDE ? carriedOH : 0;
        },
        getFreeCapacity: () => 800 - carriedOH,
      },
      withdraw: jest.fn(() => {
        carriedOH = 100;
        return OK;
      }),
      transfer: jest.fn(() => {
        if (!transferRangeOK) return ERR_NOT_IN_RANGE;
        carriedOH = 0;
        return OK;
      }),
    } as unknown as Creep;

    getEnergyStoreTarget.mockReturnValue(null);
    const terminalMap: Record<string, number> = { [RESOURCE_HYDROXIDE]: 800 };
    (terminal as { store: StoreDefinition }).store = {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return Object.values(terminalMap).reduce((s, v) => s + v, 0);
        return terminalMap[resource] ?? 0;
      },
      getFreeCapacity: () => 10000 - Object.values(terminalMap).reduce((s, v) => s + v, 0),
    } as StoreDefinition;

    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      if (id === lab.id) return lab;
      return null;
    }) as Game["getObjectById"];

    // ---- TICK N: Pickup ----
    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [{
      id: "synth:lab_supply:W9N3:OH",
      type: "lab_supply",
      priority: 100,
      steps: [{
        id: "OH:term->lab",
        resource: RESOURCE_HYDROXIDE,
        fromKind: "terminal",
        toKind: "lab",
        fromId: terminal.id,
        toId: lab.id,
        amount: 100,
      }],
    }]);

    const switched = carrierRole().source?.(creep);
    expect(switched).toBe(true);
    expect(carriedOH).toBe(100);

    // Verify snapshot was set
    const stateN = getCreepAssignmentState(creep.name);
    expect(stateN?.synthesisCarrierPendingToId).toBe(lab.id);
    expect(stateN?.synthesisCarrierPendingResource).toBe(RESOURCE_HYDROXIDE);
    const pickupTickN = stateN?.synthesisCarrierPendingPickupTick;
    expect(pickupTickN).toBe(Game.time);

    // ---- TICK N+1: Move toward lab (out of range) ----
    Game.time += 1;
    // Lab is still out of range — simulate movement
    moveToTarget.mockClear();
    (creep.transfer as jest.Mock).mockClear();

    // Keep the task on the board
    const tick1Done = carrierRole().target(creep);
    // Carrier is carrying OH but out of range — should move toward lab and stay in target
    expect(tick1Done).toBe(false);

    // ---- TICK N+2: Pickup tick is now stale (N < N+2-1 = N+1) ----
    Game.time += 1;
    transferRangeOK = true;
    // Clear board to simulate synthesis control refresh removing completed task
    replaceCarrierTasksForProducerRoom("synthesisControl", room.name, []);

    moveToTarget.mockClear();
    (creep.transfer as jest.Mock).mockClear();

    // Now pickupTick = N, Game.time = N+2 → stale.
    // Carrier still carries OH with snapshot pointing at lab.
    // BUG: current code ignores snapshot when pickupTick is stale and
    // routes to terminal/storage via generic cleanup instead.
    const tick2Done = carrierRole().target(creep);

    // FIX should use snapshot to deliver to lab even with stale pickupTick.
    // At minimum, must target the lab (move or transfer).
    const moveOrTransferToLab =
      (creep.transfer as jest.Mock).mock.calls.some(
        (call: [any, ResourceConstant]) => call[0] === lab && call[1] === RESOURCE_HYDROXIDE,
      ) ||
      moveToTarget.mock.calls.some(
        (call: [Creep, any]) => call[1] === lab,
      );
    expect(moveOrTransferToLab).toBe(true);
    expect(tick2Done).toBe(true);
  });
});

describe("storage withdrawal gate for spawn/extension supply", () => {
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

  it("allows storage withdrawal when delivery target is spawn", () => {
    const storage = {
      id: "gate-storage-spawn",
      pos: { getRangeTo: () => 1 },
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 5000 : 0),
        getFreeCapacity: () => 500000,
      },
    } as unknown as StructureStorage;
    const room = createRoom("G1N1", { storage });
    const spawnTarget = {
      id: "spawn-gate-1",
      structureType: STRUCTURE_SPAWN,
      store: { getFreeCapacity: () => 300 },
      pos: { x: 5, y: 5, roomName: room.name },
    } as unknown as StructureSpawn;
    let carried = 0;
    const creep = {
      ...createCreep(room),
      memory: { configName: "G1N1:carrier:0" },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) return carried;
          return resource === RESOURCE_ENERGY ? carried : 0;
        },
        getFreeCapacity: () => 800 - carried,
      },
      withdraw: jest.fn(() => {
        carried = 800;
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(spawnTarget);
    getPickupTargetEnergyAmount.mockReturnValue(5000);
    reservePickupTarget.mockReturnValue(true);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(switched).toBe(true);
  });

  it("allows storage withdrawal when delivery target is extension", () => {
    const storage = {
      id: "gate-storage-ext",
      pos: { getRangeTo: () => 1 },
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 5000 : 0),
        getFreeCapacity: () => 500000,
      },
    } as unknown as StructureStorage;
    const room = createRoom("G1N2", { storage });
    const extensionTarget = {
      id: "ext-gate-1",
      structureType: STRUCTURE_EXTENSION,
      store: { getFreeCapacity: () => 50 },
      pos: { x: 6, y: 6, roomName: room.name },
    } as unknown as StructureExtension;
    let carried = 0;
    const creep = {
      ...createCreep(room),
      memory: { configName: "G1N2:carrier:0" },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) return carried;
          return resource === RESOURCE_ENERGY ? carried : 0;
        },
        getFreeCapacity: () => 800 - carried,
      },
      withdraw: jest.fn(() => {
        carried = 800;
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(extensionTarget);
    getPickupTargetEnergyAmount.mockReturnValue(5000);
    reservePickupTarget.mockReturnValue(true);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(switched).toBe(true);
  });

  it("denies storage withdrawal when delivery target is tower", () => {
    const storage = {
      id: "gate-storage-tower",
      pos: { getRangeTo: () => 1 },
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 5000 : 0),
        getFreeCapacity: () => 500000,
      },
    } as unknown as StructureStorage;
    const room = createRoom("G1N3", { storage });
    const towerTarget = {
      id: "tower-gate-1",
      structureType: STRUCTURE_TOWER,
      store: { getFreeCapacity: () => 500 },
      pos: { x: 7, y: 7, roomName: room.name },
    } as unknown as StructureTower;
    const creep = {
      ...createCreep(room),
      memory: { configName: "G1N3:carrier:0" },
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(towerTarget);
    getPickupTargetEnergyAmount.mockReturnValue(5000);
    reservePickupTarget.mockReturnValue(true);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(switched).toBe(false);
  });

  it("denies storage withdrawal when delivery target is factory", () => {
    const storage = {
      id: "gate-storage-factory",
      pos: { getRangeTo: () => 1 },
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 5000 : 0),
        getFreeCapacity: () => 500000,
      },
    } as unknown as StructureStorage;
    const room = createRoom("G1N4", { storage });
    const factoryTarget = {
      id: "factory-gate-1",
      structureType: STRUCTURE_FACTORY,
      store: { getFreeCapacity: () => 50000 },
      pos: { x: 8, y: 8, roomName: room.name },
    } as unknown as StructureFactory;
    const creep = {
      ...createCreep(room),
      memory: { configName: "G1N4:carrier:0" },
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(factoryTarget);
    getPickupTargetEnergyAmount.mockReturnValue(5000);
    reservePickupTarget.mockReturnValue(true);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(switched).toBe(false);
  });

  it("emergency carrier allows storage withdrawal when target is spawn", () => {
    const storage = {
      id: "gate-storage-emergency-spawn",
      pos: { getRangeTo: () => 1 },
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 5000 : 0),
        getFreeCapacity: () => 500000,
      },
    } as unknown as StructureStorage;
    const room = createRoom("G1N5", { storage });
    const spawnTarget = {
      id: "spawn-emergency-1",
      structureType: STRUCTURE_SPAWN,
      store: { getFreeCapacity: () => 300 },
      pos: { x: 5, y: 5, roomName: room.name },
    } as unknown as StructureSpawn;
    const configName = `${room.name}:manual:maxcarrier:test`;
    let carried = 0;
    const creep = {
      ...createCreep(room),
      memory: { configName },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) return carried;
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
    getEnergyStoreTarget.mockReturnValue(spawnTarget);
    getPickupTargetEnergyAmount.mockReturnValue(5000);
    reservePickupTarget.mockReturnValue(true);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(switched).toBe(true);
  });

  it("emergency carrier denies storage withdrawal when target is tower", () => {
    const storage = {
      id: "gate-storage-emergency-tower",
      pos: { getRangeTo: () => 1 },
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 5000 : 0),
        getFreeCapacity: () => 500000,
      },
    } as unknown as StructureStorage;
    const room = createRoom("G1N6", { storage });
    const towerTarget = {
      id: "tower-emergency-1",
      structureType: STRUCTURE_TOWER,
      store: { getFreeCapacity: () => 500 },
      pos: { x: 7, y: 7, roomName: room.name },
    } as unknown as StructureTower;
    const configName = `${room.name}:emergency:carrier:0`;
    const creep = {
      ...createCreep(room),
      memory: { configName },
    } as unknown as Creep;
    getCreepConfigService().upsert(configName, "carrier", [], room.name);
    getEnergyStoreTarget.mockReturnValue(towerTarget);
    getPickupTargetEnergyAmount.mockReturnValue(5000);
    reservePickupTarget.mockReturnValue(true);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(switched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E4N58 phase jitter: pending synthesis intent timing tests
//
// In live Screeps, withdraw(OK) and transfer(OK) are *intents* — store
// mutations are applied at END of tick, not immediately after the call.
// These tests model that behavior and expose the phase mismatch bugs at
// carrier.ts:487 (picked check) and carrier.ts:581/624 (delivery clear).
// ---------------------------------------------------------------------------
describe("pending synthesis intent – phase jitter (E4N58)", () => {
  // E4N58 geometry: terminal (17,14), storage (18,15), creep (17,15)
  const TERMINAL_POS = { x: 17, y: 14, roomName: "E4N58" };
  const STORAGE_POS = { x: 18, y: 15, roomName: "E4N58" };
  const CREEP_POS = { x: 17, y: 15, roomName: "E4N58" };

  /**
   * Test 1: withdraw(OK) does not mutate creep.store this tick.
   * Bug path: carrier.ts:487 — picked = creep.store.getUsedCapacity() > 0
   * is false because store hasn't mutated yet, so source() returns false
   * and the creep never switches to target phase despite a committed intent.
   */
  it("pending synthesis intent: withdraw(OK) with store still empty should still record pickup", () => {
    const room = createRoom("E4N58");
    const terminal = {
      id: "e4n58-terminal",
      pos: TERMINAL_POS,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5000 : 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    const storage = {
      id: "e4n58-storage",
      pos: STORAGE_POS,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 500000,
      },
    } as unknown as StructureStorage;

    // Creep store stays empty even after withdraw(OK) — live intent timing
    const creep = {
      ...createCreep(room),
      pos: CREEP_POS as unknown as RoomPosition,
      store: {
        // Store remains empty this tick (intent not yet applied)
        getUsedCapacity: (_resource?: ResourceConstant) => 0,
        getFreeCapacity: () => 1000,
      },
      // withdraw returns OK but does NOT mutate store
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;

    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById =
      jest.fn((id: string) => {
        if (id === terminal.id) return terminal;
        if (id === storage.id) return storage;
        return null;
      }) as Game["getObjectById"];

    replaceCarrierTasksForProducerRoom("e4n58-offload", room.name, [
      {
        id: "e4n58-terminal-offload",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-energy",
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            fromId: terminal.id,
            toId: storage.id,
            amount: 5000,
          },
        ],
      },
    ]);
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId =
      "e4n58-terminal-offload";

    moveToTarget.mockClear();

    // source() should recognize the committed withdraw intent and return true
    // (switch to target phase) even though store is still empty this tick.
    // BUG: currently returns false because picked check at L487 reads store.
    const switched = carrierRole().source?.(creep);

    // The creep committed a withdraw intent — it should switch to delivery
    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, 1000);
    // This assertion FAILS before fix: source returns false because store is empty
    expect(switched).toBe(true);
  });

  /**
   * Test 2: Same-tick target re-entry after pending withdraw(OK).
   * After source() commits withdraw(OK), mount re-enters target() (mountCreep.ts:93-103).
   * With store still empty, deliverSynthesisCarrierResource sees no matching
   * step resource and may clear the task. The carrier should NOT clear the task
   * and should move toward the committed toId (storage), not back to terminal.
   */
  it("pending synthesis intent: same-tick target re-entry moves toward committed toId storage", () => {
    const room = createRoom("E4N58");
    const terminal = {
      id: "e4n58-terminal-reentry",
      pos: TERMINAL_POS,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5000 : 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    const storage = {
      id: "e4n58-storage-reentry",
      pos: STORAGE_POS,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 500000,
      },
    } as unknown as StructureStorage;

    // Creep at (17,15) — adjacent to terminal (17,14) and storage (18,15)
    const creep = {
      ...createCreep(room),
      name: "carrier-reentry",
      pos: CREEP_POS as unknown as RoomPosition,
      store: {
        // Store stays empty (pending intent)
        getUsedCapacity: (_resource?: ResourceConstant) => 0,
        getFreeCapacity: () => 1000,
      },
      withdraw: jest.fn(() => OK),
      transfer: jest.fn(() => OK),
    } as unknown as Creep;

    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById =
      jest.fn((id: string) => {
        if (id === terminal.id) return terminal;
        if (id === storage.id) return storage;
        return null;
      }) as Game["getObjectById"];

    replaceCarrierTasksForProducerRoom("e4n58-reentry", room.name, [
      {
        id: "e4n58-reentry-task",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-reentry",
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            fromId: terminal.id,
            toId: storage.id,
            amount: 5000,
          },
        ],
      },
    ]);
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId =
      "e4n58-reentry-task";

    moveToTarget.mockClear();

    // Simulate mount re-entry: target() called immediately after source()
    // with store still empty (withdraw intent pending)
    const done = carrierRole().target?.(creep);

    // Task should NOT be cleared — the withdraw intent is committed
    const state = getCreepAssignmentState(creep.name);
    expect(state?.synthesisCarrierTaskId).toBe("e4n58-reentry-task");
    // Carrier should plan movement toward storage (toId), not terminal
    expect(moveToTarget).toHaveBeenCalledWith(creep, storage);
    // NOT done — creep has a pending intent and should stay in target phase
    expect(done).toBe(false);
  });

  /**
   * Test 3: transfer(OK) with store still populated this tick.
   * Bug path: carrier.ts:581 — !getFirstCarriedResource(creep) is false
   * because store still has resource, so task is NOT cleared.
   * The carrier stays in target phase and returns false (not done),
   * which is actually correct for intent timing — it should keep the task
   * and wait for the next tick when store will be empty.
   * However, carrier.ts:707 `target()` returns `store.getUsedCapacity() === 0`
   * which is false, so mount sees `shouldSwitch=false` and the creep stays
   * in target. Next tick store IS empty, task gets cleared. This works.
   *
   * The REAL bug: if re-entry happens (mountCreep.ts:93), source() is called
   * again and `creep.store.getUsedCapacity() > 0` at L634 returns true,
   * switching back to target. This creates an oscillation. Test verifies that
   * after transfer(OK), task persists until next-tick empty-store confirmation.
   */
  it("pending synthesis intent: transfer(OK) with store still populated does not clear task prematurely", () => {
    const room = createRoom("E4N58");
    const terminal = {
      id: "e4n58-terminal-xfer",
      pos: TERMINAL_POS,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5000 : 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    const storage = {
      id: "e4n58-storage-xfer",
      pos: STORAGE_POS,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 500000,
      },
    } as unknown as StructureStorage;

    // Creep carries energy — store stays populated after transfer(OK)
    let storeRemaining = 500;
    const store = {
      [RESOURCE_ENERGY]: 500,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return storeRemaining;
        return resource === RESOURCE_ENERGY ? storeRemaining : 0;
      },
      getFreeCapacity: () => 500,
    };

    const creep = {
      ...createCreep(room),
      name: "carrier-xfer",
      pos: CREEP_POS as unknown as RoomPosition,
      store,
      // transfer returns OK but does NOT clear store (live intent timing)
      transfer: jest.fn(() => OK),
    } as unknown as Creep;

    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById =
      jest.fn((id: string) => {
        if (id === terminal.id) return terminal;
        if (id === storage.id) return storage;
        return null;
      }) as Game["getObjectById"];

    replaceCarrierTasksForProducerRoom("e4n58-xfer", room.name, [
      {
        id: "e4n58-xfer-task",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-xfer",
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            fromId: terminal.id,
            toId: storage.id,
            amount: 5000,
          },
        ],
      },
    ]);
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId =
      "e4n58-xfer-task";

    moveToTarget.mockClear();

    // target() with store still populated after transfer(OK)
    const done = carrierRole().target?.(creep);

    // transfer was attempted
    expect(creep.transfer).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    // Task should NOT be cleared — store mutation hasn't happened yet
    const state = getCreepAssignmentState(creep.name);
    expect(state?.synthesisCarrierTaskId).toBe("e4n58-xfer-task");
    // NOT done — store still appears populated, creep stays in target phase
    expect(done).toBe(false);
  });

  /**
   * Test 4: source() re-entry oscillation after pending transfer(OK).
   * Mount sees shouldSwitch=false from target() (store still full), so
   * no re-entry. But if source() is called externally, it should NOT
   * re-withdraw from terminal while a pending transfer exists.
   * Tests that source() at L634 sees store > 0 and immediately returns true,
   * but the task should persist for the delivery completion.
   */
  it("pending synthesis intent: source() re-entry with pending transfer does not re-withdraw", () => {
    const room = createRoom("E4N58");
    const terminal = {
      id: "e4n58-terminal-osc",
      pos: TERMINAL_POS,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5000 : 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal;
    const storage = {
      id: "e4n58-storage-osc",
      pos: STORAGE_POS,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 500000,
      },
    } as unknown as StructureStorage;

    // Creep appears to still carry energy (pending transfer intent)
    const creep = {
      ...createCreep(room),
      name: "carrier-osc",
      pos: CREEP_POS as unknown as RoomPosition,
      store: {
        [RESOURCE_ENERGY]: 500,
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
        getFreeCapacity: () => 500,
      },
      withdraw: jest.fn(() => OK),
      transfer: jest.fn(() => OK),
    } as unknown as Creep;

    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById =
      jest.fn((id: string) => {
        if (id === terminal.id) return terminal;
        if (id === storage.id) return storage;
        return null;
      }) as Game["getObjectById"];

    replaceCarrierTasksForProducerRoom("e4n58-osc", room.name, [
      {
        id: "e4n58-osc-task",
        type: "terminal_offload",
        priority: 90,
        steps: [
          {
            id: "step-osc",
            resource: RESOURCE_ENERGY,
            fromKind: "terminal",
            toKind: "storage",
            fromId: terminal.id,
            toId: storage.id,
            amount: 5000,
          },
        ],
      },
    ]);
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId =
      "e4n58-osc-task";

    getEnergyStoreTarget.mockClear();
    moveToTarget.mockClear();

    // source() sees store > 0 and returns true (wants to switch to target)
    const switched = carrierRole().source?.(creep);

    // Should NOT withdraw again — already has pending cargo
    expect(creep.withdraw).not.toHaveBeenCalled();
    // Source returns true to switch back to target for delivery completion
    expect(switched).toBe(true);
  });
});

describe("carrierRole factory logistics", () => {
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

  it("factory_unload: withdraws product from factory and transfers to storage", () => {
    const room = createRoom("F1N1");
    const storage = room.storage as StructureStorage;
    const factory = {
      id: "factory-unload-1",
      structureType: STRUCTURE_FACTORY,
      pos: { x: 20, y: 20, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_BATTERY ? 800 : 0,
        getFreeCapacity: () => 40000,
      },
    } as unknown as StructureFactory;
    let carried = 0;
    const store = {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) return carried;
        return resource === RESOURCE_BATTERY ? carried : 0;
      },
      getFreeCapacity: () => 800 - carried,
    };
    const creep = {
      ...createCreep(room),
      store,
      withdraw: jest.fn(() => {
        carried = 800;
        return OK;
      }),
      transfer: jest.fn(() => {
        carried = 0;
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === factory.id) return factory;
      if (id === storage.id) return storage;
      if (id === (room.terminal as StructureTerminal).id) return room.terminal;
      return null;
    }) as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("factoryControl", room.name, [{
      id: "factoryControl:factory_unload:F1N1:battery",
      type: "factory_unload",
      priority: 110,
      steps: [{
        id: "battery:factory-unload-1->F1N1-storage",
        resource: RESOURCE_BATTERY as ResourceConstant,
        fromKind: "factory",
        toKind: "storage",
        fromId: factory.id,
        toId: storage.id,
        amount: 800,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(factory, RESOURCE_BATTERY, 800);
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("factoryControl:factory_unload:F1N1:battery");

    const done = carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(storage, RESOURCE_BATTERY);
    expect(done).toBe(true);
  });
});

describe("carrierRole resolveTaskStructure per-tick memoization", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    resetRuntimeServices();
    Game.time += 1;
    Memory.rooms = {};
    getEnergyStoreTarget.mockReset();
    getEnergyStoreTarget.mockReturnValue(null);
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

  function installGetObjectById(handler: (id: string) => unknown): jest.Mock {
    const mock = jest.fn(handler);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = mock as unknown as Game["getObjectById"];
    return mock as unknown as jest.Mock;
  }

  function countCallsFor(mock: jest.Mock, id: string): number {
    return mock.mock.calls.filter(([arg]) => arg === id).length;
  }

  it("deduplicates Game.getObjectById calls for the same structure id within one tick", () => {
    const room = createRoom("M1N1");
    const container = {
      id: "memo-container-1",
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 900 : 0),
      },
    } as unknown as StructureContainer;
    const terminal = room.terminal as StructureTerminal;
    const creep = createCreep(room);
    const getObjectById = installGetObjectById((id: string) => {
      if (id === container.id) return container;
      if (id === terminal.id) return terminal;
      return null;
    });
    replaceCarrierTasksForProducerRoom("test", room.name, [
      {
        id: "memo-mineral-task",
        type: "mineral_haul",
        priority: 25,
        steps: [
          {
            id: "memo-step-1",
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

    expect(switched).toBe(true);
    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_KEANIUM, 800);
    expect(countCallsFor(getObjectById, container.id)).toBe(1);
    expect(countCallsFor(getObjectById, terminal.id)).toBe(1);
  });

  it("resolves structures again after Game.time advances (cache resets per tick)", () => {
    const room = createRoom("M1N2");
    const container = {
      id: "memo-container-2",
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 900 : 0),
      },
    } as unknown as StructureContainer;
    const terminal = room.terminal as StructureTerminal;
    const creep = createCreep(room);
    const getObjectById = installGetObjectById((id: string) => {
      if (id === container.id) return container;
      if (id === terminal.id) return terminal;
      return null;
    });
    replaceCarrierTasksForProducerRoom("test", room.name, [
      {
        id: "memo-mineral-task-2",
        type: "mineral_haul",
        priority: 25,
        steps: [
          {
            id: "memo-step-2",
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
    const firstTickContainerCalls = countCallsFor(getObjectById, container.id);
    expect(firstTickContainerCalls).toBe(1);

    Game.time += 1;
    (creep.withdraw as jest.Mock).mockClear();

    carrierRole().source?.(creep);

    const totalContainerCalls = countCallsFor(getObjectById, container.id);
    expect(totalContainerCalls).toBeGreaterThan(firstTickContainerCalls);
    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_KEANIUM, 800);
  });

  it("caches null results within a tick but refreshes them next tick", () => {
    const room = createRoom("M1N3");
    const container = {
      id: "memo-container-missing",
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 900 : 0),
      },
    } as unknown as StructureContainer;
    const terminal = room.terminal as StructureTerminal;
    const creep = createCreep(room);
    let containerExists = false;
    const getObjectById = installGetObjectById((id: string) => {
      if (id === container.id) return containerExists ? container : null;
      if (id === terminal.id) return terminal;
      return null;
    });
    replaceCarrierTasksForProducerRoom("test", room.name, [
      {
        id: "memo-mineral-task-missing",
        type: "mineral_haul",
        priority: 25,
        steps: [
          {
            id: "memo-step-missing",
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

    const switchedMissing = carrierRole().source?.(creep);

    expect(switchedMissing).toBe(false);
    expect(creep.withdraw).not.toHaveBeenCalled();
    const firstTickContainerCalls = countCallsFor(getObjectById, container.id);
    expect(firstTickContainerCalls).toBeGreaterThanOrEqual(1);

    Game.time += 1;
    containerExists = true;
    (creep.withdraw as jest.Mock).mockClear();

    const switchedPresent = carrierRole().source?.(creep);

    expect(switchedPresent).toBe(true);
    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_KEANIUM, 800);
  });
});
