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
  releasePickupReservation,
  reservePickupTarget,
} = jest.requireMock("@/runtime/energyPickupReservation") as {
  getPickupTargetEnergyAmount: jest.Mock;
  getReservedPickupTarget: jest.Mock;
  releasePickupReservation: jest.Mock;
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
    releasePickupReservation.mockReset();
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

  it("picks PowerSpawn supply before non-critical generic energy demand", () => {
    const room = createRoom("W1N2");
    const storage = room.storage as StructureStorage;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => resource === RESOURCE_POWER ? 80 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const powerSpawn = {
      id: "power-spawn-supply-target",
      structureType: STRUCTURE_POWER_SPAWN,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) => resource === RESOURCE_POWER ? 100 : 0,
      },
    } as unknown as StructurePowerSpawn;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue({
      id: "non-critical-lab-energy-demand",
      structureType: STRUCTURE_LAB,
    } as unknown as StructureLab);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === powerSpawn.id) return powerSpawn;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("powerSpawnControl", room.name, [{
      id: "power-spawn-supply-task",
      type: "power_spawn_supply",
      priority: 150,
      steps: [{
        id: "power:storage->power-spawn",
        resource: RESOURCE_POWER,
        fromKind: "storage",
        toKind: "power_spawn",
        fromId: storage.id,
        toId: powerSpawn.id,
        amount: 80,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_POWER, 80);
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("power-spawn-supply-task");
  });

  it("picks Nuker Ghodium before non-critical generic energy demand", () => {
    const room = createRoom("W1N2A");
    const storage = room.storage as StructureStorage;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_GHODIUM ? 500 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const nuker = {
      id: "nuker-ghodium-target",
      structureType: STRUCTURE_NUKER,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_GHODIUM ? 5_000 : 0,
      },
    } as unknown as StructureNuker;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue({
      id: "non-critical-lab-energy-demand-with-nuker",
      structureType: STRUCTURE_LAB,
    } as unknown as StructureLab);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === nuker.id) return nuker;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
      id: "nuker-ghodium-supply-task",
      type: "nuker_supply",
      priority: 140,
      steps: [{
        id: "G:storage->nuker",
        resource: RESOURCE_GHODIUM,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: nuker.id,
        amount: 500,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_GHODIUM,
      500,
    );
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBe("nuker-ghodium-supply-task");
  });

  it("keeps critical Spawn energy ahead of Nuker Ghodium", () => {
    const room = createRoom("W1N2B");
    const storage = room.storage as StructureStorage;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_GHODIUM ? 500 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const nuker = {
      id: "nuker-behind-critical-energy",
      structureType: STRUCTURE_NUKER,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 5_000,
      },
    } as unknown as StructureNuker;
    const spawn = {
      id: "critical-spawn-energy-demand",
      structureType: STRUCTURE_SPAWN,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 300,
      },
    } as unknown as StructureSpawn;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(spawn);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === nuker.id) return nuker;
      if (id === spawn.id) return spawn;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
      id: "nuker-behind-critical-task",
      type: "nuker_supply",
      priority: 140,
      steps: [{
        id: "G:storage->nuker-critical",
        resource: RESOURCE_GHODIUM,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: nuker.id,
        amount: 500,
      }],
    }]);

    carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_GHODIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
  });

  it("keeps PowerSpawn supply ahead of Nuker Ghodium", () => {
    const room = createRoom("W1N2C");
    const storage = room.storage as StructureStorage;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === RESOURCE_POWER) return 80;
          if (resource === RESOURCE_GHODIUM) return 500;
          return 0;
        },
        getFreeCapacity: () => 100_000,
      },
    });
    const powerSpawn = {
      id: "power-spawn-before-nuker",
      structureType: STRUCTURE_POWER_SPAWN,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_POWER ? 100 : 0,
      },
    } as unknown as StructurePowerSpawn;
    const nuker = {
      id: "nuker-behind-power-spawn",
      structureType: STRUCTURE_NUKER,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_GHODIUM ? 5_000 : 0,
      },
    } as unknown as StructureNuker;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === powerSpawn.id) return powerSpawn;
      if (id === nuker.id) return nuker;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("powerSpawnControl", room.name, [{
      id: "power-spawn-before-nuker-task",
      type: "power_spawn_supply",
      priority: 150,
      steps: [{
        id: "power:storage->power-spawn-before-nuker",
        resource: RESOURCE_POWER,
        fromKind: "storage",
        toKind: "power_spawn",
        fromId: storage.id,
        toId: powerSpawn.id,
        amount: 80,
      }],
    }]);
    replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
      id: "nuker-behind-power-spawn-task",
      type: "nuker_supply",
      priority: 140,
      steps: [{
        id: "G:storage->nuker-behind-power-spawn",
        resource: RESOURCE_GHODIUM,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: nuker.id,
        amount: 500,
      }],
    }]);

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_POWER,
      80,
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBe("power-spawn-before-nuker-task");
  });

  it("delivers accepted Nuker cargo from the pickup snapshot after task refresh", () => {
    const room = createRoom("W1N2D");
    const storage = room.storage as StructureStorage;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_GHODIUM ? 500 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const nuker = {
      id: "nuker-snapshot-target",
      structureType: STRUCTURE_NUKER,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_GHODIUM ? 5_000 : 0,
      },
    } as unknown as StructureNuker;
    let carried = 0;
    const creep = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined || resource === RESOURCE_GHODIUM) {
            return carried;
          }
          return 0;
        },
        getFreeCapacity: () => 800 - carried,
      },
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
      if (id === storage.id) return storage;
      if (id === nuker.id) return nuker;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
      id: "nuker-snapshot-task",
      type: "nuker_supply",
      priority: 140,
      steps: [{
        id: "G:storage->nuker-snapshot",
        resource: RESOURCE_GHODIUM,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: nuker.id,
        amount: 500,
      }],
    }]);
    const role = carrierRole();

    role.source?.(creep);
    replaceCarrierTasksForProducerRoom("nukerControl", room.name, []);
    Game.time += 1;
    role.target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(
      nuker,
      RESOURCE_GHODIUM,
    );
  });

  it("routes stranded carried Energy to a live Nuker task when no normal target or storage space exists", () => {
    const room = createRoom("W1N2E");
    const storage = room.storage as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 250_000 : 0,
        getFreeCapacity: () => 0,
      },
    });
    Object.assign(terminal, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 20_000 : 0,
        getFreeCapacity: () => 0,
      },
    });
    const nuker = {
      id: "nuker-stranded-energy-target",
      structureType: STRUCTURE_NUKER,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 300_000 : 0,
      },
    } as unknown as StructureNuker;
    const creep = createCreep(room);
    (creep.store as unknown as { getUsedCapacity: jest.Mock })
      .getUsedCapacity = jest.fn((resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY ? 600 : 0,
      );
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === terminal.id) return terminal;
      if (id === nuker.id) return nuker;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
      id: "nuker-stranded-energy-task",
      type: "nuker_supply",
      priority: 40,
      steps: [{
        id: "energy:storage->nuker-stranded",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: nuker.id,
        amount: 18_000,
      }],
    }]);
    ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode = true;

    carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(
      nuker,
      RESOURCE_ENERGY,
      600,
    );
    expect(getCreepAssignmentState(creep.name)?.carrierStorageOnlyMode)
      .toBeUndefined();
  });

  it("keeps an ordinary Energy target ahead of carried-energy Nuker fallback", () => {
    const room = createRoom("W1N2F");
    const storage = room.storage as StructureStorage;
    const nuker = {
      id: "nuker-behind-normal-energy-target",
      structureType: STRUCTURE_NUKER,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 300_000,
      },
    } as unknown as StructureNuker;
    const tower = {
      id: "ordinary-energy-target-before-nuker",
      structureType: STRUCTURE_TOWER,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 1_000,
      },
    } as unknown as StructureTower;
    const creep = createCreep(room);
    (creep.store as unknown as { getUsedCapacity: jest.Mock })
      .getUsedCapacity = jest.fn((resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY ? 600 : 0,
      );
    getEnergyStoreTarget.mockReturnValue(tower);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === nuker.id) return nuker;
      if (id === tower.id) return tower;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
      id: "nuker-behind-normal-energy-task",
      type: "nuker_supply",
      priority: 40,
      steps: [{
        id: "energy:storage->nuker-behind-normal",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: nuker.id,
        amount: 18_000,
      }],
    }]);

    carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(tower, RESOURCE_ENERGY);
    expect(creep.transfer).not.toHaveBeenCalledWith(
      nuker,
      RESOURCE_ENERGY,
      expect.any(Number),
    );
  });

  it("does not travel to pick up a dropped resource below 50", () => {
    const room = createRoom("W1N0AG");
    const dropped = {
      id: "small-dropped-energy",
      amount: 49,
      resourceType: RESOURCE_ENERGY,
      room,
      pos: { x: 20, y: 20, roomName: room.name },
    } as unknown as Resource;
    room.find = jest.fn((type: FindConstant) =>
      type === FIND_DROPPED_RESOURCES ? [dropped] : [],
    ) as unknown as Room["find"];
    const creep = {
      ...createCreep(room),
      pos: { getRangeTo: () => 5 } as unknown as RoomPosition,
      pickup: jest.fn(() => ERR_NOT_IN_RANGE),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    isDroppedResourceTarget.mockImplementation((target: Resource) => target.amount !== undefined);
    getPickupTargetEnergyAmount.mockImplementation((target: Resource) => target.amount ?? 0);
    reservePickupTarget.mockReturnValue(true);

    carrierRole().source?.(creep);

    expect(reservePickupTarget).not.toHaveBeenCalled();
    expect(creep.pickup).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("travels to pick up a dropped resource at the exact threshold of 50", () => {
    const room = createRoom("W1N0AH");
    const dropped = {
      id: "threshold-dropped-energy",
      amount: 50,
      resourceType: RESOURCE_ENERGY,
      room,
      pos: { x: 20, y: 20, roomName: room.name },
    } as unknown as Resource;
    room.find = jest.fn((type: FindConstant) =>
      type === FIND_DROPPED_RESOURCES ? [dropped] : [],
    ) as unknown as Room["find"];
    const creep = {
      ...createCreep(room),
      pos: { getRangeTo: () => 5 } as unknown as RoomPosition,
      pickup: jest.fn(() => ERR_NOT_IN_RANGE),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    isDroppedResourceTarget.mockImplementation((target: Resource) => target.amount !== undefined);
    getPickupTargetEnergyAmount.mockImplementation((target: Resource) => target.amount ?? 0);
    reservePickupTarget.mockReturnValue(true);

    carrierRole().source?.(creep);

    expect(reservePickupTarget).toHaveBeenCalledWith(creep, dropped, 50);
    expect(creep.pickup).toHaveBeenCalledWith(dropped);
    expect(moveToTarget).toHaveBeenCalledWith(creep, dropped);
  });

  it("can pick up a dropped resource below 50 when it is already in range", () => {
    const room = createRoom("W1N0AJ");
    const dropped = {
      id: "adjacent-small-dropped-energy",
      amount: 49,
      resourceType: RESOURCE_ENERGY,
      room,
      pos: { x: 20, y: 20, roomName: room.name },
    } as unknown as Resource;
    room.find = jest.fn((type: FindConstant) =>
      type === FIND_DROPPED_RESOURCES ? [dropped] : [],
    ) as unknown as Room["find"];
    const creep = {
      ...createCreep(room),
      pos: { getRangeTo: () => 1 } as unknown as RoomPosition,
      pickup: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    isDroppedResourceTarget.mockImplementation((target: Resource) => target.amount !== undefined);
    getPickupTargetEnergyAmount.mockImplementation((target: Resource) => target.amount ?? 0);
    reservePickupTarget.mockReturnValue(true);

    carrierRole().source?.(creep);

    expect(creep.pickup).toHaveBeenCalledWith(dropped);
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("releases a distant reserved drop after it falls below 50", () => {
    const room = createRoom("W1N0AI");
    const dropped = {
      id: "shrunk-dropped-energy",
      amount: 49,
      resourceType: RESOURCE_ENERGY,
      room,
      pos: { x: 20, y: 20, roomName: room.name },
    } as unknown as Resource;
    room.find = jest.fn((type: FindConstant) =>
      type === FIND_DROPPED_RESOURCES ? [dropped] : [],
    ) as unknown as Room["find"];
    const creep = {
      ...createCreep(room),
      pos: { getRangeTo: () => 5 } as unknown as RoomPosition,
      pickup: jest.fn(() => ERR_NOT_IN_RANGE),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    getReservedPickupTarget.mockReturnValue(dropped);
    isDroppedResourceTarget.mockImplementation((target: Resource) => target.amount !== undefined);
    getPickupTargetEnergyAmount.mockImplementation((target: Resource) => target.amount ?? 0);
    reservePickupTarget.mockReturnValue(true);

    carrierRole().source?.(creep);

    expect(releasePickupReservation).toHaveBeenCalledWith(creep, dropped.id);
    expect(creep.pickup).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
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
});
