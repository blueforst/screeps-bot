import { carrierRole } from "@/roles/carrier";
import {
  clearCarrierTaskBoardForTest,
  getCarrierTasksByRoom,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState, getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { runSynthesisControl } from "@/runtime/synthesisControl";
import {
  clearMarketActionArbiterForTest,
  executeMarketDeal,
  executeTerminalSend,
} from "@/runtime/marketActionArbiter";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";
import { clearLocalCarrierDestinationCapacityForTest } from "@/runtime/localCarrierDestinationCapacity";

jest.mock("@/roles/energyTargets", () => ({
  getEnergyStoreTarget: jest.fn(),
  isDroppedResourceTarget: jest.fn(() => false),
}));

jest.mock("@/runtime/energyPickupReservation", () => ({
  getPickupReservationClaimAmount: jest.fn(() => 800),
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
  getPickupReservationClaimAmount,
  getPickupTargetEnergyAmount,
  getReservedPickupTarget,
  releasePickupReservation,
  reservePickupTarget,
} = jest.requireMock("@/runtime/energyPickupReservation") as {
  getPickupReservationClaimAmount: jest.Mock;
  getPickupTargetEnergyAmount: jest.Mock;
  getReservedPickupTarget: jest.Mock;
  releasePickupReservation: jest.Mock;
  reservePickupTarget: jest.Mock;
};

const actualEnergyPickupReservation = jest.requireActual(
  "@/runtime/energyPickupReservation",
) as typeof import("@/runtime/energyPickupReservation");

function useActualEnergyPickupReservationsForTest(): void {
  actualEnergyPickupReservation.clearPickupReservationStoreForTest();
  getPickupTargetEnergyAmount.mockImplementation(
    actualEnergyPickupReservation.getPickupTargetEnergyAmount,
  );
  getReservedPickupTarget.mockImplementation(
    actualEnergyPickupReservation.getReservedPickupTarget,
  );
  reservePickupTarget.mockImplementation(
    actualEnergyPickupReservation.reservePickupTarget,
  );
  releasePickupReservation.mockImplementation(
    actualEnergyPickupReservation.releasePickupReservation,
  );
  getPickupReservationClaimAmount.mockImplementation(
    actualEnergyPickupReservation.getPickupReservationClaimAmount,
  );
}

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

function createCarrierTaskTestContainer(
  room: Room,
  id: string,
  x: number,
  contents: Partial<Record<ResourceConstant, number>> = {},
  freeCapacity = 10_000,
): StructureContainer {
  return {
    id,
    structureType: STRUCTURE_CONTAINER,
    room,
    pos: { x, y: 10, roomName: room.name },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource !== undefined) {
          return contents[resource] ?? 0;
        }
        return Object.values(contents).reduce(
          (total, amount) => total + (amount ?? 0),
          0,
        );
      },
      getFreeCapacity: () => freeCapacity,
    },
  } as unknown as StructureContainer;
}

function createMineralHaulTaskDraft(
  id: string,
  priority: number,
  resource: ResourceConstant,
  from: StructureContainer,
  to: StructureContainer,
  amount = 800,
): CarrierTaskDraft {
  return {
    id,
    type: "mineral_haul",
    priority,
    steps: [{
      id: `${id}:step`,
      resource,
      fromKind: "container",
      toKind: "container",
      fromId: from.id,
      toId: to.id,
      amount,
    }],
  };
}

function installCarrierTaskTestObjects(
  objects: AnyStoreStructure[],
): void {
  const byId = new Map<string, AnyStoreStructure>(
    objects.map((object) => [object.id as string, object]),
  );
  (
    Game as Game & { getObjectById: Game["getObjectById"] }
  ).getObjectById = jest.fn((id: string) => byId.get(id) ?? null) as unknown as Game["getObjectById"];
}

function installTerminalBootstrapEnergyScenario(
  roomName: string,
  options: {
    flag?: boolean;
    terminalEnergy?: number;
    terminalReserve?: number;
  } = {},
): {
  room: Room;
  terminal: StructureTerminal;
  spawn: StructureSpawn;
  creep: Creep;
} {
  clearMarketActionArbiterForTest();
  clearMarketSaleExposureReservationsForTest();
  const room = createRoom(roomName);
  Object.assign(room, {
    energyAvailable: 300,
    energyCapacityAvailable: 5_600,
  });
  const terminalEnergy = options.terminalEnergy ?? 42_209;
  const terminal = room.terminal as StructureTerminal;
  Object.assign(terminal, {
    room,
    pos: { x: 15, y: 28, roomName },
    send: jest.fn(() => OK),
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY
          ? terminalEnergy
          : 0,
      getFreeCapacity: () => 300_000 - terminalEnergy,
    },
  });
  const spawn = {
    id: `${roomName}-bootstrap-spawn`,
    structureType: STRUCTURE_SPAWN,
    room,
    pos: { x: 16, y: 28, roomName },
    store: {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 300,
    },
  } as unknown as StructureSpawn;
  const creep = createCreep(room);
  Game.creeps[creep.name] = creep;
  Memory.cfg = {
    energyPickup: {
      terminalBootstrapRecoveryRooms: options.flag === false
        ? {}
        : { [roomName]: true },
    },
    resourceControl: {
      rooms: {
        [roomName]: {
          terminalEnergyReserve: options.terminalReserve ?? 20_000,
        },
      },
    },
  };
  Memory.runtime = {};
  getEnergyStoreTarget.mockReturnValue(spawn);
  getPickupTargetEnergyAmount.mockImplementation(
    (target: AnyStoreStructure, availability?: { terminalEnergyReserve?: number }) => {
      if (target !== terminal) return 0;
      return Math.max(
        0,
        terminalEnergy - (availability?.terminalEnergyReserve ?? 50_000),
      );
    },
  );
  getReservedPickupTarget.mockReturnValue(null);
  reservePickupTarget.mockReturnValue(true);
  (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
    (id: string) => {
      if (id === terminal.id) return terminal;
      if (id === spawn.id) return spawn;
      return null;
    },
  ) as Game["getObjectById"];

  return { room, terminal, spawn, creep };
}

function installNukerEnergyClaimScenario(
  roomName: string,
  taskAmount = 1_000,
): {
  room: Room;
  storage: StructureStorage;
  nuker: StructureNuker;
  taskId: string;
} {
  const room = createRoom(roomName);
  const storage = room.storage as StructureStorage;
  Object.assign(storage, {
    room,
    pos: { x: 10, y: 10, roomName },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? 5_000 : 0,
      getFreeCapacity: () => 100_000,
    },
  });
  const nuker = {
    id: `${roomName}-claim-nuker`,
    structureType: STRUCTURE_NUKER,
    pos: { x: 11, y: 10, roomName },
    store: {
      getUsedCapacity: () => 0,
      getFreeCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? 300_000 : 0,
    },
  } as unknown as StructureNuker;
  const taskId = `${roomName}-nuker-energy-claim`;
  (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
    if (id === storage.id) return storage;
    if (id === nuker.id) return nuker;
    return null;
  }) as unknown as Game["getObjectById"];
  replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
    id: taskId,
    type: "nuker_supply",
    priority: 0,
    steps: [{
      id: `${roomName}-energy:storage->nuker`,
      resource: RESOURCE_ENERGY,
      fromKind: "storage",
      toKind: "nuker",
      fromId: storage.id,
      toId: nuker.id,
      amount: taskAmount,
    }],
  }]);
  getEnergyStoreTarget.mockReturnValue(null);
  return { room, storage, nuker, taskId };
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
    clearLocalCarrierDestinationCapacityForTest();
    resetRuntimeServices();
    Game.time += 1;
    Memory.rooms = {};
    Memory.data = undefined;
    getEnergyStoreTarget.mockReset();
    isDroppedResourceTarget.mockReset();
    isDroppedResourceTarget.mockReturnValue(false);
    getPickupTargetEnergyAmount.mockReset();
    getPickupTargetEnergyAmount.mockReturnValue(0);
    getPickupReservationClaimAmount.mockReset();
    getPickupReservationClaimAmount.mockReturnValue(800);
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

  function installSpawnPrefillPreloadScenario(
    roomName: string,
    spawnBusyStates: boolean[],
    withPreload = true,
  ): {
    creep: Creep;
    storage: StructureStorage;
    terminal: StructureTerminal;
    energySource: StructureContainer;
    energyTarget: StructureExtension;
    spawns: StructureSpawn[];
  } {
    const room = createRoom(roomName);
    const storage = room.storage as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_LEMERGIUM ? 5_000 : 0,
        getFreeCapacity: () => 0,
      },
    });
    Object.assign(terminal, {
      pos: { x: 11, y: 10, roomName },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const energySource = {
      id: `${roomName}-prefill-energy-source`,
      structureType: STRUCTURE_CONTAINER,
      room,
      pos: { x: 12, y: 10, roomName },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
        getFreeCapacity: () => 1_500,
      },
    } as unknown as StructureContainer;
    const extension = {
      id: `${roomName}-empty-extension`,
      structureType: STRUCTURE_EXTENSION,
      room,
      pos: { x: 13, y: 10, roomName },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 50,
      },
    } as unknown as StructureExtension;
    const spawns = spawnBusyStates.map((busy, index) => ({
      id: `${roomName}-spawn-${index}`,
      name: `${roomName}-Spawn-${index}`,
      structureType: STRUCTURE_SPAWN,
      room,
      pos: { x: 14 + index, y: 10, roomName },
      spawning: busy ? { name: `queued-${index}` } : null,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 300,
      },
    } as unknown as StructureSpawn));
    Game.spawns = Object.fromEntries(
      spawns.map((spawn) => [spawn.name, spawn]),
    );
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(extension);
    getReservedPickupTarget.mockReturnValue(energySource);
    getPickupTargetEnergyAmount.mockImplementation((target: unknown) =>
      target === energySource ? 500 : 0,
    );
    reservePickupTarget.mockReturnValue(true);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === terminal.id) return terminal;
      if (id === energySource.id) return energySource;
      if (id === extension.id) return extension;
      return spawns.find((spawn) => spawn.id === id) || null;
    }) as unknown as Game["getObjectById"];
    if (withPreload) {
      replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [{
        id: `resourceControl:terminal_feed:${roomName}:L`,
        type: "terminal_feed",
        dispatchClass: "capacity_relief",
        priority: 80,
        steps: [{
          id: `${roomName}:L:storage->terminal`,
          resource: RESOURCE_LEMERGIUM,
          fromKind: "storage",
          toKind: "terminal",
          fromId: storage.id,
          toId: terminal.id,
          amount: 3_000,
        }],
      }]);
    }
    return {
      creep,
      storage,
      terminal,
      energySource,
      energyTarget: extension,
      spawns,
    };
  }

  it("keeps the 50k Terminal pickup reserve when bootstrap recovery is not flagged", () => {
    const { creep, terminal } = installTerminalBootstrapEnergyScenario(
      "W1N1",
      { flag: false },
    );

    carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(
      terminal,
      RESOURCE_ENERGY,
      expect.any(Number),
    );
    expect(getPickupTargetEnergyAmount).not.toHaveBeenCalledWith(
      terminal,
      { terminalEnergyReserve: 20_000 },
    );
  });

  it("keeps the legacy three-argument reservation and 50k claim cap on an unflagged Terminal", () => {
    const { creep, terminal } = installTerminalBootstrapEnergyScenario(
      "W1N1",
      { flag: false, terminalEnergy: 50_600 },
    );
    useActualEnergyPickupReservationsForTest();

    carrierRole().source?.(creep);

    expect(reservePickupTarget).toHaveBeenCalledWith(
      creep,
      terminal,
      600,
    );
    expect(creep.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_ENERGY,
      600,
    );
  });

  it("lets a manual emergency carrier whose config was deleted fall back to its physical flagged room", () => {
    const { creep, terminal } = installTerminalBootstrapEnergyScenario("W1N1");
    creep.memory.configName = "W1N1:manual:maxcarrier:expired";

    expect(Memory.data?.creepConfigs?.[creep.memory.configName]).toBeUndefined();

    carrierRole().source?.(creep);

    expect(reservePickupTarget).toHaveBeenCalledWith(
      creep,
      terminal,
      800,
      { terminalEnergyReserve: 20_000 },
    );
    expect(creep.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_ENERGY,
      800,
    );
    expect(Memory.runtime?.energyPickup?.terminalBootstrapRecovery?.W1N1)
      .toEqual(expect.objectContaining({ lastRecoveryPickupAt: Game.time }));
  });

  it("caps a flagged Terminal pickup exactly at the ResourceControl reserve floor", () => {
    const { creep, terminal } = installTerminalBootstrapEnergyScenario(
      "W1N1",
      { terminalEnergy: 20_500 },
    );

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_ENERGY,
      500,
    );
  });

  it("caps two same-tick recovery withdraw intents to their actual 800/200 claims without market exposure", () => {
    const {
      room,
      terminal,
      creep: first,
    } = installTerminalBootstrapEnergyScenario("W1N1", {
      terminalEnergy: 21_000,
      terminalReserve: 20_000,
    });
    first.name = "carrier-1";
    first.memory.configName = "W1N1:manual:maxcarrier:1";
    const second = createCreep(room);
    second.name = "carrier-2";
    second.memory.configName = "W1N1:manual:maxcarrier:2";
    Game.creeps = {
      [first.name]: first,
      [second.name]: second,
    };
    useActualEnergyPickupReservationsForTest();

    carrierRole().source?.(first);
    carrierRole().source?.(second);

    const firstAmount = (first.withdraw as jest.Mock).mock.calls[0]?.[2];
    const secondAmount = (second.withdraw as jest.Mock).mock.calls[0]?.[2];
    expect([firstAmount, secondAmount]).toEqual([800, 200]);
    expect(firstAmount + secondAmount).toBeLessThanOrEqual(1_000);
    expect(Memory.data?.marketSaleAutomation).toBeUndefined();
  });

  it("does not use flagged bootstrap Energy protected by market exposure", () => {
    const { room, creep, terminal } = installTerminalBootstrapEnergyScenario("W1N1");
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {
          protectedEnergy: {
            roomName: room.name,
            resourceType: RESOURCE_ENERGY,
            remainingExposure: 42_209,
          },
        },
      },
    } as unknown as Memory["data"];

    carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(
      terminal,
      RESOURCE_ENERGY,
      expect.any(Number),
    );
  });

  it("does not withdraw flagged bootstrap Energy after a same-tick Terminal action", () => {
    const { creep, terminal } = installTerminalBootstrapEnergyScenario("W1N1");
    expect(executeTerminalSend({
      terminal,
      resourceType: RESOURCE_ENERGY,
      amount: 1,
      transactionCost: 0,
      destinationRoomName: "W1N2",
      actor: "bootstrap-action-claim-test",
    })).toBe(OK);

    carrierRole().source?.(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(
      terminal,
      RESOURCE_ENERGY,
      expect.any(Number),
    );
  });

  it("does not leak one room recovery reserve to a carrier physically in another room", () => {
    const assigned = createRoom("W1N1");
    const physical = installTerminalBootstrapEnergyScenario("W2N2", {
      flag: false,
    });
    Memory.cfg!.energyPickup!.terminalBootstrapRecoveryRooms = {
      [assigned.name]: true,
    };
    Memory.cfg!.resourceControl!.rooms = {
      [assigned.name]: { terminalEnergyReserve: 20_000 },
    };
    const configName = `${assigned.name}:carrier:0`;
    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "carrier",
          args: [],
          roomName: assigned.name,
        },
      },
    };
    physical.creep.memory.configName = configName;
    const assignedSpawn = {
      ...physical.spawn,
      id: `${assigned.name}-spawn`,
      room: assigned,
      pos: { x: 10, y: 10, roomName: assigned.name },
    } as unknown as StructureSpawn;
    getEnergyStoreTarget.mockReturnValue(assignedSpawn);

    carrierRole().source?.(physical.creep);

    expect(physical.creep.withdraw).not.toHaveBeenCalledWith(
      physical.terminal,
      RESOURCE_ENERGY,
      expect.any(Number),
    );
    expect(reservePickupTarget).not.toHaveBeenCalledWith(
      physical.creep,
      physical.terminal,
      expect.any(Number),
      { terminalEnergyReserve: 20_000 },
    );
  });

  it("picks PowerSpawn supply before Terminal preload and non-critical Energy demand", () => {
    const room = createRoom("W1N2");
    const storage = room.storage as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === RESOURCE_POWER) return 80;
          if (resource === RESOURCE_LEMERGIUM) return 3_000;
          return 0;
        },
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
      if (id === terminal.id) return terminal;
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
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [{
      id: "resourceControl:terminal_feed:W1N2:L",
      type: "terminal_feed",
      dispatchClass: "capacity_relief",
      priority: 80,
      steps: [{
        id: "L:storage->terminal-behind-power-spawn",
        resource: RESOURCE_LEMERGIUM,
        fromKind: "storage",
        toKind: "terminal",
        fromId: storage.id,
        toId: terminal.id,
        amount: 3_000,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_POWER, 80);
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      expect.any(Number),
    );
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("power-spawn-supply-task");
  });

  it("keeps direct unmanaged PowerSpawn Energy ahead of capacity-relief preload", () => {
    const {
      creep,
      storage,
      energySource,
    } = installSpawnPrefillPreloadScenario(
      "W114N2",
      [true],
    );
    const powerSpawn = {
      id: "direct-unmanaged-power-spawn-energy-target",
      structureType: STRUCTURE_POWER_SPAWN,
      room: creep.room,
      pos: { x: 13, y: 11, roomName: creep.room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5_000 : 0,
      },
    } as unknown as StructurePowerSpawn;
    getEnergyStoreTarget.mockReturnValue(powerSpawn);

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
  });

  it("picks Nuker Ghodium before Terminal preload and non-critical Energy demand", () => {
    const room = createRoom("W101N2");
    const storage = room.storage as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_GHODIUM
            ? 500
            : resource === RESOURCE_LEMERGIUM
              ? 3_000
              : 0,
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
      if (id === terminal.id) return terminal;
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
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [{
      id: "resourceControl:terminal_feed:W101N2:L",
      type: "terminal_feed",
      dispatchClass: "capacity_relief",
      priority: 80,
      steps: [{
        id: "L:storage->terminal-behind-nuker-ghodium",
        resource: RESOURCE_LEMERGIUM,
        fromKind: "storage",
        toKind: "terminal",
        fromId: storage.id,
        toId: terminal.id,
        amount: 3_000,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_GHODIUM,
      500,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      expect.any(Number),
    );
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBe("nuker-ghodium-supply-task");
  });

  it("keeps critical Spawn energy ahead of Nuker Ghodium", () => {
    const room = createRoom("W102N2");
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

  it("picks accepted ResourceControl Terminal preload before ordinary Energy demand", () => {
    const room = createRoom("W130N2");
    const storage = room.storage as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_LEMERGIUM ? 5_000 : 0,
        getFreeCapacity: () => 0,
      },
    });
    Object.assign(terminal, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const energySource = {
      id: "ordinary-energy-source-behind-preload",
      structureType: STRUCTURE_CONTAINER,
      room,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
        getFreeCapacity: () => 1_500,
      },
    } as unknown as StructureContainer;
    const lab = {
      id: "ordinary-lab-energy-behind-preload",
      structureType: STRUCTURE_LAB,
      pos: { x: 13, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 1_000,
      },
    } as unknown as StructureLab;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(lab);
    getReservedPickupTarget.mockReturnValue(energySource);
    getPickupTargetEnergyAmount.mockImplementation((target: unknown) =>
      target === energySource ? 500 : 0,
    );
    reservePickupTarget.mockReturnValue(true);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === terminal.id) return terminal;
      if (id === energySource.id) return energySource;
      if (id === lab.id) return lab;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [{
      id: "resourceControl:terminal_feed:W130N2:L",
      type: "terminal_feed",
      dispatchClass: "capacity_relief",
      priority: 80,
      steps: [{
        id: "L:storage->terminal-preload",
        resource: RESOURCE_LEMERGIUM,
        fromKind: "storage",
        toKind: "terminal",
        fromId: storage.id,
        toId: terminal.id,
        amount: 3_000,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      800,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBe("resourceControl:terminal_feed:W130N2:L");
  });

  it("gives ordinary Energy one bounded source pass after an accepted capacity-relief pickup", () => {
    const {
      creep,
      storage,
      terminal,
      energySource,
    } = installSpawnPrefillPreloadScenario(
      "W109N2",
      [true, true],
    );
    let carriedResource: ResourceConstant | null = null;
    let carriedAmount = 0;
    const withdraw = jest.fn((
      target: AnyStoreStructure,
      resource: ResourceConstant,
      amount?: number,
    ) => {
      carriedResource = resource;
      carriedAmount = amount ?? target.store.getUsedCapacity(resource);
      return OK;
    });
    const transfer = jest.fn((
      _target: AnyStoreStructure,
      _resource: ResourceConstant,
    ) => {
      carriedResource = null;
      carriedAmount = 0;
      return OK;
    });
    Object.assign(creep, {
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === carriedResource
            ? carriedAmount
            : 0,
        getFreeCapacity: () => 800 - carriedAmount,
      },
      withdraw,
      transfer,
    });
    Game.creeps = { [creep.name]: creep };

    expect(carrierRole().source?.(creep)).toBe(true);
    expect(withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      800,
    );
    expect(getCreepAssignmentState(creep.name)?.yieldAfterCapacityReliefPickup)
      .toBe(true);

    Game.time += 1;
    expect(carrierRole().target(creep)).toBe(true);
    expect(transfer).toHaveBeenCalledWith(terminal, RESOURCE_LEMERGIUM);
    expect(carriedAmount).toBe(0);

    withdraw.mockClear();
    carrierRole().source?.(creep);

    expect(withdraw).toHaveBeenCalledWith(energySource, RESOURCE_ENERGY);
    expect(withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.yieldAfterCapacityReliefPickup)
      .toBeUndefined();
  });

  it("keeps capacity-relief yield through out-of-range ordinary Energy until pickup succeeds", () => {
    const {
      creep,
      storage,
      terminal,
      energySource,
    } = installSpawnPrefillPreloadScenario(
      "W110N2",
      [true, true],
    );
    let carriedResource: ResourceConstant | null = null;
    let carriedAmount = 0;
    let ordinaryAttempts = 0;
    const withdraw = jest.fn((
      target: AnyStoreStructure,
      resource: ResourceConstant,
      amount?: number,
    ) => {
      if (target === energySource && resource === RESOURCE_ENERGY) {
        ordinaryAttempts += 1;
        if (ordinaryAttempts === 1) return ERR_NOT_IN_RANGE;
      }
      carriedResource = resource;
      carriedAmount = amount ?? target.store.getUsedCapacity(resource);
      return OK;
    });
    const transfer = jest.fn(() => {
      carriedResource = null;
      carriedAmount = 0;
      return OK;
    });
    Object.assign(creep, {
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === carriedResource
            ? carriedAmount
            : 0,
        getFreeCapacity: () => 800 - carriedAmount,
      },
      withdraw,
      transfer,
    });
    Game.creeps = { [creep.name]: creep };

    expect(carrierRole().source?.(creep)).toBe(true);
    expect(withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      800,
    );

    Game.time += 1;
    expect(carrierRole().target(creep)).toBe(true);
    expect(transfer).toHaveBeenCalledWith(terminal, RESOURCE_LEMERGIUM);

    Game.time += 1;
    withdraw.mockClear();
    expect(carrierRole().source?.(creep)).toBe(false);
    expect(withdraw).toHaveBeenCalledWith(energySource, RESOURCE_ENERGY);
    expect(withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.yieldAfterCapacityReliefPickup)
      .toBe(true);

    Game.time += 1;
    withdraw.mockClear();
    expect(carrierRole().source?.(creep)).toBe(true);
    expect(withdraw).toHaveBeenCalledWith(energySource, RESOURCE_ENERGY);
    expect(withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      expect.any(Number),
    );
    expect(ordinaryAttempts).toBe(2);
    expect(getCreepAssignmentState(creep.name)?.yieldAfterCapacityReliefPickup)
      .toBeUndefined();
  });

  it("caps two same-tick capacity-relief withdraws to one task-step amount", () => {
    const {
      creep: first,
      storage,
      terminal,
    } = installSpawnPrefillPreloadScenario(
      "W106N2",
      [true, true],
    );
    const taskId = "resourceControl:terminal_feed:W106N2:L";
    replaceCarrierTasksForProducerRoom(
      "resourceControl:preload",
      first.room.name,
      [{
        id: taskId,
        type: "terminal_feed",
        dispatchClass: "capacity_relief",
        priority: 80,
        steps: [{
          id: "W106N2:L:storage->terminal",
          resource: RESOURCE_LEMERGIUM,
          fromKind: "storage",
          toKind: "terminal",
          fromId: storage.id,
          toId: terminal.id,
          amount: 1_000,
        }],
      }],
    );
    first.name = "capacity-relief-claim-1";
    const second = createCreep(first.room);
    second.name = "capacity-relief-claim-2";
    Game.creeps = {
      [first.name]: first,
      [second.name]: second,
    };

    carrierRole().source?.(first);
    carrierRole().source?.(second);

    const firstAmount = (first.withdraw as jest.Mock).mock.calls[0]?.[2];
    const secondAmount = (second.withdraw as jest.Mock).mock.calls[0]?.[2];
    expect([firstAmount, secondAmount]).toEqual([800, 200]);
    expect(firstAmount + secondAmount).toBeLessThanOrEqual(1_000);
    expect(getCreepAssignmentState(first.name)?.synthesisCarrierTaskId)
      .toBe(taskId);
    expect(getCreepAssignmentState(second.name)?.synthesisCarrierTaskId)
      .toBe(taskId);
  });

  it("caps capacity-relief withdraw to the Terminal destination free capacity", () => {
    const {
      creep,
      storage,
      terminal,
    } = installSpawnPrefillPreloadScenario(
      "W108N2",
      [true, true],
    );
    Object.assign(terminal, {
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_LEMERGIUM ? 275 : 0,
      },
    });

    expect(carrierRole().source?.(creep)).toBe(true);

    expect(creep.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      275,
    );
    expect(getCreepAssignmentState(creep.name)).toEqual(
      expect.objectContaining({
        synthesisCarrierPendingToId: terminal.id,
        synthesisCarrierPendingResource: RESOURCE_LEMERGIUM,
      }),
    );
  });

  it("delivers accepted capacity cargo from its snapshot after board deletion", () => {
    const {
      creep,
      storage,
      terminal,
      energyTarget,
    } = installSpawnPrefillPreloadScenario(
      "W111N2",
      [true, true],
    );
    let carriedLemergium = 0;
    const withdraw = jest.fn((
      _target: AnyStoreStructure,
      resource: ResourceConstant,
      amount?: number,
    ) => {
      if (resource === RESOURCE_LEMERGIUM) {
        carriedLemergium = amount ?? 0;
      }
      return OK;
    });
    const transfer = jest.fn((
      target: AnyStoreStructure,
      resource: ResourceConstant,
    ) => {
      expect(getCreepAssignmentState(creep.name)).toEqual(
        expect.objectContaining({
          synthesisCarrierPendingToId: terminal.id,
          synthesisCarrierPendingResource: RESOURCE_LEMERGIUM,
        }),
      );
      expect(target).toBe(terminal);
      expect(resource).toBe(RESOURCE_LEMERGIUM);
      carriedLemergium = 0;
      return OK;
    });
    Object.assign(creep, {
      store: {
        [RESOURCE_LEMERGIUM]: 0,
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_LEMERGIUM
            ? carriedLemergium
            : 0,
        getFreeCapacity: () => 800 - carriedLemergium,
      },
      withdraw,
      transfer,
    });
    const taskId =
      "resourceControl:terminal_feed:W111N2:L";

    expect(carrierRole().source?.(creep)).toBe(true);
    expect(withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      800,
    );
    expect(getCreepAssignmentState(creep.name)).toEqual(
      expect.objectContaining({
        synthesisCarrierTaskId: taskId,
        synthesisCarrierPendingToId: terminal.id,
        synthesisCarrierPendingResource: RESOURCE_LEMERGIUM,
      }),
    );

    replaceCarrierTasksForProducerRoom(
      "resourceControl:preload",
      creep.room.name,
      [],
    );
    expect(getCarrierTasksByRoom(creep.room.name)[taskId]).toBeUndefined();
    getEnergyStoreTarget.mockClear();
    getEnergyStoreTarget.mockReturnValue(energyTarget);

    Game.time += 1;
    expect(carrierRole().target(creep)).toBe(true);

    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer).toHaveBeenCalledWith(terminal, RESOURCE_LEMERGIUM);
    expect(transfer).not.toHaveBeenCalledWith(
      energyTarget,
      RESOURCE_LEMERGIUM,
    );
    expect(transfer).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
    );
    expect(getEnergyStoreTarget).not.toHaveBeenCalled();
    const state = getCreepAssignmentState(creep.name);
    expect(state?.synthesisCarrierTaskId).toBeUndefined();
    expect(state?.synthesisCarrierPendingFromId).toBeUndefined();
    expect(state?.synthesisCarrierPendingToId).toBeUndefined();
    expect(state?.synthesisCarrierPendingResource).toBeUndefined();
    expect(state?.synthesisCarrierPendingTaskType).toBeUndefined();
  });

  it("keeps critical Tower Energy ahead of ResourceControl Terminal preload", () => {
    const room = createRoom("W112N2");
    const storage = room.storage as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_LEMERGIUM ? 5_000 : 0,
        getFreeCapacity: () => 0,
      },
    });
    Object.assign(terminal, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const energySource = {
      id: "critical-energy-source-before-preload",
      structureType: STRUCTURE_CONTAINER,
      room,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
        getFreeCapacity: () => 1_500,
      },
    } as unknown as StructureContainer;
    const tower = {
      id: "critical-tower-before-preload",
      structureType: STRUCTURE_TOWER,
      pos: { x: 13, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 1_000,
      },
    } as unknown as StructureTower;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(tower);
    getReservedPickupTarget.mockReturnValue(energySource);
    getPickupTargetEnergyAmount.mockImplementation((target: unknown) =>
      target === energySource ? 500 : 0,
    );
    reservePickupTarget.mockReturnValue(true);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === terminal.id) return terminal;
      if (id === energySource.id) return energySource;
      if (id === tower.id) return tower;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [{
      id: "resourceControl:terminal_feed:W112N2:L",
      type: "terminal_feed",
      dispatchClass: "capacity_relief",
      priority: 80,
      steps: [{
        id: "L:storage->terminal-critical-preload",
        resource: RESOURCE_LEMERGIUM,
        fromKind: "storage",
        toKind: "terminal",
        fromId: storage.id,
        toId: terminal.id,
        amount: 3_000,
      }],
    }]);

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
  });

  it("treats all-busy Spawn Extension demand as prefill behind Terminal preload", () => {
    const { creep, storage, energySource } = installSpawnPrefillPreloadScenario(
      "W104N2",
      [true, true],
    );

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      800,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
    expect(switched).toBe(true);
  });

  it("keeps Extension Energy critical when any room Spawn is idle", () => {
    const { creep, storage, energySource } = installSpawnPrefillPreloadScenario(
      "W119N2",
      [true, false],
    );

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
  });

  it("does not treat an inactive idle Spawn as critical Extension capacity", () => {
    const {
      creep,
      storage,
      energySource,
      spawns,
    } = installSpawnPrefillPreloadScenario(
      "W120N2",
      [true, false],
    );
    Object.assign(spawns[0], { isActive: jest.fn(() => true) });
    Object.assign(spawns[1], { isActive: jest.fn(() => false) });

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      800,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
  });

  it("still fills busy-Spawn Extensions when no Terminal preload is runnable", () => {
    const { creep, energySource } = installSpawnPrefillPreloadScenario(
      "W103N2",
      [true, true],
      false,
    );

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
  });

  it("picks ResourceControl Energy preload before ordinary Energy demand", () => {
    const room = createRoom("W116N2");
    const storage = room.storage as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5_000 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const energySource = {
      id: "ordinary-energy-source-behind-energy-preload",
      structureType: STRUCTURE_CONTAINER,
      room,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
        getFreeCapacity: () => 1_500,
      },
    } as unknown as StructureContainer;
    const lab = {
      id: "ordinary-lab-behind-energy-preload",
      structureType: STRUCTURE_LAB,
      pos: { x: 13, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 1_000,
      },
    } as unknown as StructureLab;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(lab);
    getReservedPickupTarget.mockReturnValue(energySource);
    getPickupTargetEnergyAmount.mockImplementation((target: unknown) =>
      target === energySource ? 500 : 0,
    );
    reservePickupTarget.mockReturnValue(true);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === terminal.id) return terminal;
      if (id === energySource.id) return energySource;
      if (id === lab.id) return lab;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [{
      id: "resourceControl:terminal_feed:W116N2:energy",
      type: "terminal_feed",
      dispatchClass: "capacity_relief",
      priority: 80,
      steps: [{
        id: "energy:storage->terminal-preload",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "terminal",
        fromId: storage.id,
        toId: terminal.id,
        amount: 2_000,
      }],
    }]);

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_ENERGY,
      800,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
  });

  it("falls through to ordinary Energy when Terminal preload withdraw fails", () => {
    const room = createRoom("W118N2");
    const storage = room.storage as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_LEMERGIUM ? 5_000 : 0,
        getFreeCapacity: () => 0,
      },
    });
    const energySource = {
      id: "ordinary-energy-source-after-failed-preload",
      structureType: STRUCTURE_CONTAINER,
      room,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
        getFreeCapacity: () => 1_500,
      },
    } as unknown as StructureContainer;
    const lab = {
      id: "ordinary-lab-after-failed-preload",
      structureType: STRUCTURE_LAB,
      pos: { x: 13, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 1_000,
      },
    } as unknown as StructureLab;
    const creep = {
      ...createCreep(room),
      withdraw: jest.fn((target: AnyStoreStructure) =>
        target === storage ? ERR_NOT_ENOUGH_RESOURCES : OK,
      ),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(lab);
    getReservedPickupTarget.mockReturnValue(energySource);
    getPickupTargetEnergyAmount.mockImplementation((target: unknown) =>
      target === energySource ? 500 : 0,
    );
    reservePickupTarget.mockReturnValue(true);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === terminal.id) return terminal;
      if (id === energySource.id) return energySource;
      if (id === lab.id) return lab;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [{
      id: "resourceControl:terminal_feed:W118N2:L",
      type: "terminal_feed",
      dispatchClass: "capacity_relief",
      priority: 80,
      steps: [{
        id: "L:storage->terminal-failed-preload",
        resource: RESOURCE_LEMERGIUM,
        fromKind: "storage",
        toKind: "terminal",
        fromId: storage.id,
        toId: terminal.id,
        amount: 3_000,
      }],
    }]);

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      800,
    );
    expect(creep.withdraw).toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
  });

  it("clears an unrunnable Energy capacity assignment before ordinary Energy delivery", () => {
    const {
      creep,
      storage,
      terminal,
      energySource,
      energyTarget,
    } = installSpawnPrefillPreloadScenario(
      "W132N2",
      [true, true],
      false,
    );
    let carriedEnergy = 0;
    const withdraw = jest.fn((
      target: AnyStoreStructure,
      resource: ResourceConstant,
    ) => {
      if (target === energySource && resource === RESOURCE_ENERGY) {
        carriedEnergy = 500;
      }
      return OK;
    });
    const transfer = jest.fn((
      _target: AnyStoreStructure,
      resource: ResourceConstant,
    ) => {
      if (resource === RESOURCE_ENERGY) {
        carriedEnergy = 0;
      }
      return OK;
    });
    Object.assign(creep, {
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY
            ? carriedEnergy
            : 0,
        getFreeCapacity: () => 800 - carriedEnergy,
      },
      withdraw,
      transfer,
    });
    const taskId = "resourceControl:terminal_feed:W132N2:energy";
    replaceCarrierTasksForProducerRoom(
      "resourceControl:preload",
      creep.room.name,
      [{
        id: taskId,
        type: "terminal_feed",
        dispatchClass: "capacity_relief",
        priority: 80,
        steps: [{
          id: "W132N2:energy:storage->terminal",
          resource: RESOURCE_ENERGY,
          fromKind: "storage",
          toKind: "terminal",
          fromId: storage.id,
          toId: terminal.id,
          amount: 2_000,
        }],
      }],
    );
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = taskId;

    expect(carrierRole().source?.(creep)).toBe(true);

    expect(withdraw).toHaveBeenCalledWith(energySource, RESOURCE_ENERGY);
    expect(withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_ENERGY,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierPendingToId)
      .toBeUndefined();

    Game.time += 1;
    carrierRole().target(creep);

    expect(transfer).toHaveBeenCalledWith(energyTarget, RESOURCE_ENERGY);
    expect(transfer).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
  });

  it("clears an out-of-range Energy capacity assignment when critical Energy preempts next tick", () => {
    const {
      creep,
      storage,
      terminal,
      energySource,
      energyTarget,
    } = installSpawnPrefillPreloadScenario(
      "W131N2",
      [true, true],
      false,
    );
    Object.assign(storage, {
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5_000 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const tower = {
      id: "critical-tower-after-ranged-capacity",
      structureType: STRUCTURE_TOWER,
      room: creep.room,
      pos: { x: 14, y: 11, roomName: creep.room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 1_000,
      },
    } as unknown as StructureTower;
    let carriedEnergy = 0;
    const withdraw = jest.fn((
      target: AnyStoreStructure,
      resource: ResourceConstant,
    ) => {
      if (target === storage && resource === RESOURCE_ENERGY) {
        return ERR_NOT_IN_RANGE;
      }
      if (target === energySource && resource === RESOURCE_ENERGY) {
        carriedEnergy = 500;
      }
      return OK;
    });
    const transfer = jest.fn((
      _target: AnyStoreStructure,
      resource: ResourceConstant,
    ) => {
      if (resource === RESOURCE_ENERGY) carriedEnergy = 0;
      return OK;
    });
    Object.assign(creep, {
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY
            ? carriedEnergy
            : 0,
        getFreeCapacity: () => 800 - carriedEnergy,
      },
      withdraw,
      transfer,
    });
    const taskId = "resourceControl:terminal_feed:W131N2:energy";
    replaceCarrierTasksForProducerRoom(
      "resourceControl:preload",
      creep.room.name,
      [{
        id: taskId,
        type: "terminal_feed",
        dispatchClass: "capacity_relief",
        priority: 80,
        steps: [{
          id: "W131N2:energy:storage->terminal",
          resource: RESOURCE_ENERGY,
          fromKind: "storage",
          toKind: "terminal",
          fromId: storage.id,
          toId: terminal.id,
          amount: 2_000,
        }],
      }],
    );

    getEnergyStoreTarget.mockReturnValue(energyTarget);
    expect(carrierRole().source?.(creep)).toBe(false);
    expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 800);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBe(taskId);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierPendingToId)
      .toBeUndefined();

    Game.time += 1;
    getEnergyStoreTarget.mockReturnValue(tower);
    expect(carrierRole().source?.(creep)).toBe(true);
    expect(withdraw).toHaveBeenCalledWith(energySource, RESOURCE_ENERGY);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierPendingToId)
      .toBeUndefined();

    Game.time += 1;
    carrierRole().target(creep);

    expect(transfer).toHaveBeenCalledWith(tower, RESOURCE_ENERGY);
    expect(transfer).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
  });

  it("clears a stale same-id Energy binding when capacity relief becomes unclassified", () => {
    const {
      creep,
      storage,
      terminal,
      energySource,
      energyTarget,
    } = installSpawnPrefillPreloadScenario(
      "W107N2",
      [true, true],
      false,
    );
    Object.assign(storage, {
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5_000 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const tower = {
      id: "critical-tower-after-capacity-class-refresh",
      structureType: STRUCTURE_TOWER,
      room: creep.room,
      pos: { x: 14, y: 12, roomName: creep.room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 1_000,
      },
    } as unknown as StructureTower;
    let carriedEnergy = 0;
    const withdraw = jest.fn((
      target: AnyStoreStructure,
      resource: ResourceConstant,
    ) => {
      if (target === storage && resource === RESOURCE_ENERGY) {
        return ERR_NOT_IN_RANGE;
      }
      if (target === energySource && resource === RESOURCE_ENERGY) {
        carriedEnergy = 500;
      }
      return OK;
    });
    const transfer = jest.fn((
      _target: AnyStoreStructure,
      resource: ResourceConstant,
    ) => {
      if (resource === RESOURCE_ENERGY) carriedEnergy = 0;
      return OK;
    });
    Object.assign(creep, {
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY
            ? carriedEnergy
            : 0,
        getFreeCapacity: () => 800 - carriedEnergy,
      },
      withdraw,
      transfer,
    });
    const taskId = "resourceControl:terminal_feed:W107N2:energy";
    const step = {
      id: "W107N2:energy:storage->terminal",
      resource: RESOURCE_ENERGY,
      fromKind: "storage" as const,
      toKind: "terminal" as const,
      fromId: storage.id,
      toId: terminal.id,
      amount: 2_000,
    };
    replaceCarrierTasksForProducerRoom(
      "resourceControl:preload",
      creep.room.name,
      [{
        id: taskId,
        type: "terminal_feed",
        dispatchClass: "capacity_relief",
        priority: 80,
        steps: [step],
      }],
    );

    getEnergyStoreTarget.mockReturnValue(energyTarget);
    expect(carrierRole().source?.(creep)).toBe(false);
    expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 800);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBe(taskId);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierPendingToId)
      .toBeUndefined();

    Game.time += 1;
    replaceCarrierTasksForProducerRoom(
      "resourceControl:preload",
      creep.room.name,
      [{
        id: taskId,
        type: "terminal_feed",
        priority: 80,
        steps: [step],
      }],
    );
    expect(getCarrierTasksByRoom(creep.room.name)[taskId]?.dispatchClass)
      .toBeUndefined();
    getEnergyStoreTarget.mockReturnValue(tower);
    expect(carrierRole().source?.(creep)).toBe(true);
    expect(withdraw).toHaveBeenCalledWith(energySource, RESOURCE_ENERGY);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierPendingToId)
      .toBeUndefined();

    Game.time += 1;
    carrierRole().target(creep);

    expect(transfer).toHaveBeenCalledWith(tower, RESOURCE_ENERGY);
    expect(transfer).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
  });

  it("does not promote a non-ResourceControl terminal feed above ordinary Energy demand", () => {
    const room = createRoom("W129N2");
    const storage = room.storage as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_LEMERGIUM ? 5_000 : 0,
        getFreeCapacity: () => 0,
      },
    });
    const energySource = {
      id: "ordinary-energy-source-before-other-feed",
      structureType: STRUCTURE_CONTAINER,
      room,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
        getFreeCapacity: () => 1_500,
      },
    } as unknown as StructureContainer;
    const lab = {
      id: "ordinary-lab-before-other-feed",
      structureType: STRUCTURE_LAB,
      pos: { x: 13, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 1_000,
      },
    } as unknown as StructureLab;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(lab);
    getReservedPickupTarget.mockReturnValue(energySource);
    getPickupTargetEnergyAmount.mockImplementation((target: unknown) =>
      target === energySource ? 500 : 0,
    );
    reservePickupTarget.mockReturnValue(true);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === terminal.id) return terminal;
      if (id === energySource.id) return energySource;
      if (id === lab.id) return lab;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("otherProducer", room.name, [{
      id: "other:terminal_feed:W129N2:L",
      type: "terminal_feed",
      dispatchClass: "capacity_relief",
      priority: 200,
      steps: [{
        id: "L:storage->terminal-other-feed",
        resource: RESOURCE_LEMERGIUM,
        fromKind: "storage",
        toKind: "terminal",
        fromId: storage.id,
        toId: terminal.id,
        amount: 3_000,
      }],
    }]);

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
  });

  it("does not promote an unclassified ResourceControl terminal feed above ordinary Energy", () => {
    const {
      creep,
      storage,
      terminal,
      energySource,
    } = installSpawnPrefillPreloadScenario(
      "W133N2",
      [true, true],
      false,
    );
    replaceCarrierTasksForProducerRoom(
      "resourceControl:preload",
      creep.room.name,
      [{
        id: "resourceControl:terminal_feed:W133N2:L",
        type: "terminal_feed",
        priority: 1_000,
        steps: [{
          id: "W133N2:L:storage->terminal",
          resource: RESOURCE_LEMERGIUM,
          fromKind: "storage",
          toKind: "terminal",
          fromId: storage.id,
          toId: terminal.id,
          amount: 3_000,
        }],
      }],
    );

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      energySource,
      RESOURCE_ENERGY,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      storage,
      RESOURCE_LEMERGIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();
  });

  it("keeps PowerSpawn supply ahead of Nuker Ghodium", () => {
    const room = createRoom("W105N2");
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

  it.each([1, -1])(
    "keeps a normal board task at priority %i ahead of Nuker Energy and replaces its stale assignment",
    (normalPriority) => {
      const room = createRoom(normalPriority > 0 ? "W134N2" : "W135N2");
      const storage = room.storage as StructureStorage;
      Object.assign(storage, {
        pos: { x: 10, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: (resource?: ResourceConstant) => {
            if (resource === RESOURCE_ENERGY) return 5_000;
            if (resource === RESOURCE_UTRIUM) return 500;
            return 0;
          },
          getFreeCapacity: () => 100_000,
        },
      });
      const factory = {
        id: `normal-factory-${normalPriority}`,
        structureType: STRUCTURE_FACTORY,
        pos: { x: 11, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: () => 0,
          getFreeCapacity: () => 50_000,
        },
      } as unknown as StructureFactory;
      const nuker = {
        id: `background-nuker-${normalPriority}`,
        structureType: STRUCTURE_NUKER,
        pos: { x: 12, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: () => 0,
          getFreeCapacity: (resource?: ResourceConstant) =>
            resource === RESOURCE_ENERGY ? 300_000 : 0,
        },
      } as unknown as StructureNuker;
      const creep = createCreep(room);
      getEnergyStoreTarget.mockReturnValue(null);
      (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
        if (id === storage.id) return storage;
        if (id === factory.id) return factory;
        if (id === nuker.id) return nuker;
        return null;
      }) as unknown as Game["getObjectById"];
      replaceCarrierTasksForProducerRoom("normal-test", room.name, [{
        id: `normal-task-${normalPriority}`,
        type: "factory_supply",
        priority: normalPriority,
        steps: [{
          id: `U:storage->factory-${normalPriority}`,
          resource: RESOURCE_UTRIUM,
          fromKind: "storage",
          toKind: "factory",
          fromId: storage.id,
          toId: factory.id,
          amount: 500,
        }],
      }]);
      replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
        id: `nuker-energy-task-${normalPriority}`,
        type: "nuker_supply",
        priority: 0,
        steps: [{
          id: `energy:storage->nuker-${normalPriority}`,
          resource: RESOURCE_ENERGY,
          fromKind: "storage",
          toKind: "nuker",
          fromId: storage.id,
          toId: nuker.id,
          amount: 1_000,
        }],
      }]);
      ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId =
        `nuker-energy-task-${normalPriority}`;

      carrierRole().source?.(creep);

      expect(creep.withdraw).toHaveBeenCalledWith(
        storage,
        RESOURCE_UTRIUM,
        500,
      );
      expect(creep.withdraw).not.toHaveBeenCalledWith(
        storage,
        RESOURCE_ENERGY,
        expect.any(Number),
      );
      expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
        .toBe(`normal-task-${normalPriority}`);
    },
  );

  it.each([
    ["critical Spawn", STRUCTURE_SPAWN],
    ["ordinary Lab", STRUCTURE_LAB],
  ] as const)(
    "clears stale Nuker assignment when %s Energy demand preempts it",
    (_label, structureType) => {
      const room = createRoom("W122N2");
      const storage = room.storage as StructureStorage;
      Object.assign(storage, {
        pos: { x: 10, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: (resource?: ResourceConstant) =>
            resource === RESOURCE_ENERGY ? 5_000 : 0,
          getFreeCapacity: () => 100_000,
        },
      });
      const container = {
        id: `normal-energy-source-${structureType}`,
        structureType: STRUCTURE_CONTAINER,
        room,
        pos: { x: 11, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: (resource?: ResourceConstant) =>
            resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
          getFreeCapacity: () => 2_000,
        },
      } as unknown as StructureContainer;
      const energyTarget = {
        id: `normal-energy-target-${structureType}`,
        structureType,
        pos: { x: 12, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: () => 0,
          getFreeCapacity: () => 1_000,
        },
      } as unknown as AnyStoreStructure;
      const nuker = {
        id: `background-nuker-energy-demand-${structureType}`,
        structureType: STRUCTURE_NUKER,
        pos: { x: 13, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: () => 0,
          getFreeCapacity: (resource?: ResourceConstant) =>
            resource === RESOURCE_ENERGY ? 300_000 : 0,
        },
      } as unknown as StructureNuker;
      let carriedEnergy = 0;
      const creep = {
        ...createCreep(room),
        store: {
          getUsedCapacity: (resource?: ResourceConstant) =>
            resource === undefined || resource === RESOURCE_ENERGY
              ? carriedEnergy
              : 0,
          getFreeCapacity: () => 800 - carriedEnergy,
        },
        withdraw: jest.fn((target: AnyStoreStructure, resource: ResourceConstant) => {
          if (target === container && resource === RESOURCE_ENERGY) {
            carriedEnergy = 500;
          }
          return OK;
        }),
        transfer: jest.fn(() => {
          carriedEnergy = 0;
          return OK;
        }),
      } as unknown as Creep;
      getEnergyStoreTarget.mockReturnValue(energyTarget);
      getReservedPickupTarget.mockReturnValue(container);
      getPickupTargetEnergyAmount.mockImplementation((target: unknown) =>
        target === container ? 500 : 0,
      );
      reservePickupTarget.mockReturnValue(true);
      (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
        if (id === storage.id) return storage;
        if (id === container.id) return container;
        if (id === energyTarget.id) return energyTarget;
        if (id === nuker.id) return nuker;
        return null;
      }) as unknown as Game["getObjectById"];
      const nukerTaskId = `stale-nuker-before-${structureType}`;
      replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
        id: nukerTaskId,
        type: "nuker_supply",
        priority: 0,
        steps: [{
          id: `energy:storage->nuker-demand-${structureType}`,
          resource: RESOURCE_ENERGY,
          fromKind: "storage",
          toKind: "nuker",
          fromId: storage.id,
          toId: nuker.id,
          amount: 1_000,
        }],
      }]);
      ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = nukerTaskId;

      expect(carrierRole().source?.(creep)).toBe(true);

      expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
      expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
        .toBeUndefined();

      Game.time += 1;
      carrierRole().target(creep);

      expect(creep.transfer).toHaveBeenCalledWith(energyTarget, RESOURCE_ENERGY);
      expect(creep.transfer).not.toHaveBeenCalledWith(nuker, RESOURCE_ENERGY);
    },
  );

  it("clears stale Nuker assignment before dead-store work so carried Energy follows normal delivery", () => {
    const room = createRoom("W121N2");
    const storage = room.storage as StructureStorage;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5_000 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const nuker = {
      id: "background-nuker-dead-store",
      structureType: STRUCTURE_NUKER,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 300_000 : 0,
      },
    } as unknown as StructureNuker;
    const tower = {
      id: "normal-tower-after-dead-store",
      structureType: STRUCTURE_TOWER,
      pos: { x: 13, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 1_000,
      },
    } as unknown as StructureTower;
    const tombstone = {
      id: "energy-tombstone-before-nuker",
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        [RESOURCE_ENERGY]: 500,
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
      },
    } as unknown as Tombstone;
    let carriedEnergy = 0;
    const creep = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY
            ? carriedEnergy
            : 0,
        getFreeCapacity: () => 800 - carriedEnergy,
      },
      withdraw: jest.fn((target: Tombstone | AnyStoreStructure, resource: ResourceConstant) => {
        if (target === tombstone && resource === RESOURCE_ENERGY) {
          carriedEnergy = 500;
        }
        return OK;
      }),
      transfer: jest.fn(() => {
        carriedEnergy = 0;
        return OK;
      }),
    } as unknown as Creep;
    room.find = jest.fn((type: FindConstant) =>
      type === FIND_TOMBSTONES ? [tombstone] : [],
    ) as unknown as Room["find"];
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === nuker.id) return nuker;
      if (id === tower.id) return tower;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
      id: "stale-nuker-energy-before-dead-store",
      type: "nuker_supply",
      priority: 0,
      steps: [{
        id: "energy:storage->nuker-dead-store",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: nuker.id,
        amount: 1_000,
      }],
    }]);
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId =
      "stale-nuker-energy-before-dead-store";

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(tombstone, RESOURCE_ENERGY);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBeUndefined();

    getEnergyStoreTarget.mockReturnValue(tower);
    Game.time += 1;
    carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(tower, RESOURCE_ENERGY);
    expect(creep.transfer).not.toHaveBeenCalledWith(
      nuker,
      RESOURCE_ENERGY,
    );
  });

  it("picks Nuker Energy when all higher logistics stages are idle", () => {
    const room = createRoom("W125N2");
    const storage = room.storage as StructureStorage;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5_000 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const nuker = {
      id: "idle-nuker-energy-target",
      structureType: STRUCTURE_NUKER,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 300_000 : 0,
      },
    } as unknown as StructureNuker;
    const creep = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === nuker.id) return nuker;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
      id: "idle-nuker-energy-task",
      type: "nuker_supply",
      priority: 0,
      steps: [{
        id: "energy:storage->idle-nuker",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: nuker.id,
        amount: 1_000,
      }],
    }]);

    const switched = carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 800);
    expect(switched).toBe(true);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBe("idle-nuker-energy-task");
  });

  it("caps multiple same-tick Nuker Energy pickups after task refresh", () => {
    const { room, storage, taskId } = installNukerEnergyClaimScenario(
      "W126N2",
    );
    const first = {
      ...createCreep(room),
      name: "nuker-pickup-first",
    } as unknown as Creep;
    const second = {
      ...createCreep(room),
      name: "nuker-pickup-second",
    } as unknown as Creep;
    Game.creeps = {
      [first.name]: first,
      [second.name]: second,
    };

    carrierRole().source?.(first);
    const currentTask = getCarrierTasksByRoom(room.name)[taskId];
    replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
      id: currentTask.id,
      type: currentTask.type,
      priority: currentTask.priority,
      steps: currentTask.steps,
    }]);
    carrierRole().source?.(second);

    expect(first.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_ENERGY,
      800,
    );
    expect(second.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_ENERGY,
      200,
    );
  });

  it("releases a failed Nuker Energy pickup claim for the next Carrier", () => {
    const { room, storage } = installNukerEnergyClaimScenario(
      "W124N2",
    );
    const fullCapacityStore = {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 1_000,
    };
    const failed = {
      ...createCreep(room),
      name: "nuker-pickup-failed",
      store: fullCapacityStore,
      withdraw: jest.fn(() => ERR_NOT_IN_RANGE),
    } as unknown as Creep;
    const retry = {
      ...createCreep(room),
      name: "nuker-pickup-retry",
      store: fullCapacityStore,
    } as unknown as Creep;
    Game.creeps = {
      [failed.name]: failed,
      [retry.name]: retry,
    };

    carrierRole().source?.(failed);
    carrierRole().source?.(retry);

    expect(retry.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_ENERGY,
      1_000,
    );
  });

  it("shares one task budget between pickup and carried-Energy fallback", () => {
    const { room, storage, nuker } = installNukerEnergyClaimScenario(
      "W127N2",
    );
    const pickupCarrier = {
      ...createCreep(room),
      name: "nuker-shared-pickup",
    } as unknown as Creep;
    const fallbackCarrier = {
      ...createCreep(room),
      name: "nuker-shared-fallback",
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 800 : 0,
        getFreeCapacity: () => 0,
      },
    } as unknown as Creep;
    Game.creeps = {
      [pickupCarrier.name]: pickupCarrier,
      [fallbackCarrier.name]: fallbackCarrier,
    };

    carrierRole().source?.(pickupCarrier);
    carrierRole().target(fallbackCarrier);

    expect(pickupCarrier.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_ENERGY,
      800,
    );
    expect(fallbackCarrier.transfer).toHaveBeenCalledWith(
      nuker,
      RESOURCE_ENERGY,
      200,
    );
  });

  it("releases a failed carried-Energy fallback claim", () => {
    const { room, nuker } = installNukerEnergyClaimScenario(
      "W123N2",
    );
    const carriedStore = {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY ? 1_000 : 0,
      getFreeCapacity: () => 0,
    };
    const failed = {
      ...createCreep(room),
      name: "nuker-fallback-failed",
      store: carriedStore,
      transfer: jest.fn(() => ERR_NOT_IN_RANGE),
    } as unknown as Creep;
    const retry = {
      ...createCreep(room),
      name: "nuker-fallback-retry",
      store: carriedStore,
    } as unknown as Creep;
    Game.creeps = {
      [failed.name]: failed,
      [retry.name]: retry,
    };

    carrierRole().target(failed);
    carrierRole().target(retry);

    expect(retry.transfer).toHaveBeenCalledWith(
      nuker,
      RESOURCE_ENERGY,
      1_000,
    );
  });

  it("delivers accepted Nuker Energy from its pickup snapshot after task prune", () => {
    const room = createRoom("W128N2");
    const storage = room.storage as StructureStorage;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5_000 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const nuker = {
      id: "snapshot-nuker-energy-target",
      structureType: STRUCTURE_NUKER,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 300_000 : 0,
      },
    } as unknown as StructureNuker;
    const decoyNuker = {
      id: "snapshot-nuker-same-name-other-owner-target",
      structureType: STRUCTURE_NUKER,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 300_000 : 0,
      },
    } as unknown as StructureNuker;
    let carriedEnergy = 0;
    const creep = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY
            ? carriedEnergy
            : 0,
        getFreeCapacity: () => 800 - carriedEnergy,
      },
      withdraw: jest.fn(() => {
        carriedEnergy = 800;
        return OK;
      }),
      transfer: jest.fn(() => {
        carriedEnergy = 0;
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === nuker.id) return nuker;
      if (id === decoyNuker.id) return decoyNuker;
      return null;
    }) as unknown as Game["getObjectById"];
    const taskId = "snapshot-nuker-energy-task";
    const originalProducer = "nukerControl:original";
    replaceCarrierTasksForProducerRoom(originalProducer, room.name, [{
      id: taskId,
      type: "nuker_supply",
      priority: 0,
      steps: [{
        id: "energy:storage->snapshot-nuker",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: nuker.id,
        amount: 1_000,
      }],
    }]);

    carrierRole().source?.(creep);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierPendingTaskRef)
      .toEqual({
        system: "carrier-logistics",
        namespace: originalProducer,
        scope: { kind: "room", roomName: room.name },
        localId: taskId,
      });
    replaceCarrierTasksForProducerRoom("nukerControl:other", room.name, [{
      id: taskId,
      type: "nuker_supply",
      priority: 1_000,
      steps: [{
        id: "energy:storage->same-name-other-owner-nuker",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: decoyNuker.id,
        amount: 1_000,
      }],
    }]);
    replaceCarrierTasksForProducerRoom(originalProducer, room.name, []);
    Game.time += 1;
    carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(
      nuker,
      RESOURCE_ENERGY,
    );
    expect(creep.transfer).toHaveBeenCalledTimes(1);
    expect(getCreepAssignmentState(creep.name)).not.toEqual(
      expect.objectContaining({
        synthesisCarrierPendingTaskType: expect.any(String),
      }),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierPendingTaskRef)
      .toBeUndefined();
  });

  it("delivers accepted Nuker cargo from the pickup snapshot after task refresh", () => {
    const room = createRoom("W113N2");
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
    const room = createRoom("W115N2");
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
    const room = createRoom("W117N2");
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
    const room = createRoom("W101N0");
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
    const room = createRoom("W102N0");
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
    const room = createRoom("W104N0");
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
    const room = createRoom("W103N0");
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

  it("caps terminal_offload pickup by shared Storage capacity and step claims across carriers", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const room = createRoom("W4N7");
    const terminal = room.terminal as StructureTerminal;
    const storage = room.storage as StructureStorage;
    Object.assign(terminal, {
      room,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_HYDROGEN ? 2_000 : 0,
        getFreeCapacity: () => 10_000,
      },
    });
    Object.assign(storage, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 999_500,
        getFreeCapacity: () => 500,
      },
    });
    const first = {
      ...createCreep(room),
      name: "carrier-offload-first",
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    const second = {
      ...createCreep(room),
      name: "carrier-offload-second",
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    Game.creeps[first.name] = first;
    Game.creeps[second.name] = second;
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("test-offload-capacity", room.name, [{
      id: "terminal-offload-capacity-test",
      type: "terminal_offload",
      priority: 90,
      steps: [{
        id: "H:terminal->storage-capacity",
        resource: RESOURCE_HYDROGEN,
        fromKind: "terminal",
        toKind: "storage",
        fromId: terminal.id,
        toId: storage.id,
        amount: 800,
      }],
    }]);

    carrierRole().source?.(first);
    carrierRole().source?.(second);

    expect(first.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_HYDROGEN,
      500,
    );
    expect(second.withdraw).not.toHaveBeenCalled();
    expect(getCreepAssignmentState(first.name)).toMatchObject({
      synthesisCarrierPendingToId: storage.id,
      synthesisCarrierPendingResource: RESOURCE_HYDROGEN,
    });
  });

  it("atomically shrinks accepted offload snapshot transfers to 600 + 400 + 0", () => {
    const room = createRoom("W4N13");
    const terminal = room.terminal as StructureTerminal;
    const storage = room.storage as StructureStorage;
    Object.assign(terminal, {
      pos: { x: 10, y: 10, roomName: room.name },
    });
    Object.assign(storage, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 999_000,
        getFreeCapacity: () => 1_000,
      },
    });
    const createSnapshotCarrier = (name: string): Creep => ({
      ...createCreep(room),
      name,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_HYDROGEN ? 600 : 0,
        getFreeCapacity: () => 200,
      },
      transfer: jest.fn(() => OK),
    } as unknown as Creep);
    const first = createSnapshotCarrier("carrier-offload-snapshot-first");
    const second = createSnapshotCarrier("carrier-offload-snapshot-second");
    const third = createSnapshotCarrier("carrier-offload-snapshot-third");
    Game.creeps = {
      [first.name]: first,
      [second.name]: second,
      [third.name]: third,
    };
    for (const carrier of [first, second, third]) {
      Object.assign(ensureCreepAssignmentState(carrier.name), {
        synthesisCarrierPendingFromId: terminal.id,
        synthesisCarrierPendingToId: storage.id,
        synthesisCarrierPendingResource: RESOURCE_HYDROGEN,
        synthesisCarrierPendingTaskType: "terminal_offload",
      });
    }
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
      (id: string) => {
        if (id === terminal.id) return terminal;
        if (id === storage.id) return storage;
        return null;
      },
    ) as unknown as Game["getObjectById"];

    carrierRole().target(first);
    carrierRole().target(second);
    carrierRole().target(third);

    expect(first.transfer).toHaveBeenCalledWith(
      storage,
      RESOURCE_HYDROGEN,
    );
    expect(second.transfer).toHaveBeenCalledWith(
      storage,
      RESOURCE_HYDROGEN,
      400,
    );
    expect(third.transfer).not.toHaveBeenCalled();
    expect(getCreepAssignmentState(second.name)).toEqual(
      expect.objectContaining({
        synthesisCarrierPendingToId: storage.id,
        synthesisCarrierPendingResource: RESOURCE_HYDROGEN,
        synthesisCarrierPendingTaskType: "terminal_offload",
      }),
    );
    expect(getCreepAssignmentState(third.name)).toEqual(
      expect.objectContaining({
        synthesisCarrierPendingToId: storage.id,
        synthesisCarrierPendingTaskType: "terminal_offload",
      }),
    );
  });

  it("releases a failed accepted offload snapshot transfer slice", () => {
    const room = createRoom("W4N14");
    const terminal = room.terminal as StructureTerminal;
    const storage = room.storage as StructureStorage;
    Object.assign(terminal, {
      pos: { x: 10, y: 10, roomName: room.name },
    });
    Object.assign(storage, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 999_400,
        getFreeCapacity: () => 600,
      },
    });
    const createSnapshotCarrier = (
      name: string,
      transferCode: ScreepsReturnCode,
    ): Creep => ({
      ...createCreep(room),
      name,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_HYDROGEN ? 600 : 0,
        getFreeCapacity: () => 200,
      },
      transfer: jest.fn(() => transferCode),
    } as unknown as Creep);
    const failed = createSnapshotCarrier(
      "carrier-offload-snapshot-failed",
      ERR_NOT_IN_RANGE,
    );
    const next = createSnapshotCarrier(
      "carrier-offload-snapshot-after-failure",
      OK,
    );
    Game.creeps = { [failed.name]: failed, [next.name]: next };
    for (const carrier of [failed, next]) {
      Object.assign(ensureCreepAssignmentState(carrier.name), {
        synthesisCarrierPendingFromId: terminal.id,
        synthesisCarrierPendingToId: storage.id,
        synthesisCarrierPendingResource: RESOURCE_HYDROGEN,
        synthesisCarrierPendingTaskType: "terminal_offload",
      });
    }
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
      (id: string) => {
        if (id === terminal.id) return terminal;
        if (id === storage.id) return storage;
        return null;
      },
    ) as unknown as Game["getObjectById"];

    carrierRole().target(failed);
    carrierRole().target(next);

    expect(moveToTarget).toHaveBeenCalledWith(failed, storage);
    expect(next.transfer).toHaveBeenCalledWith(
      storage,
      RESOURCE_HYDROGEN,
    );
  });

  it("keeps accepted offload cargo bound to a full Storage after board refresh", () => {
    const room = createRoom("W4N8");
    const terminal = room.terminal as StructureTerminal;
    const storage = room.storage as StructureStorage;
    Object.assign(terminal, {
      pos: { x: 10, y: 10, roomName: room.name },
    });
    Object.assign(storage, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 1_000_000,
        getFreeCapacity: () => 0,
      },
    });
    const carrier = {
      ...createCreep(room),
      name: "carrier-offload-committed",
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_HYDROGEN
            ? 500
            : 0,
        getFreeCapacity: () => 300,
      },
      transfer: jest.fn(() => ERR_FULL),
    } as unknown as Creep;
    Object.assign(ensureCreepAssignmentState(carrier.name), {
      synthesisCarrierPendingFromId: terminal.id,
      synthesisCarrierPendingToId: storage.id,
      synthesisCarrierPendingResource: RESOURCE_HYDROGEN,
    });
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      return null;
    }) as unknown as Game["getObjectById"];
    getEnergyStoreTarget.mockReturnValue({
      id: "unrelated-energy-target",
    } as unknown as AnyStoreStructure);

    expect(carrierRole().target(carrier)).toBe(false);

    expect(carrier.transfer).not.toHaveBeenCalled();
    expect(getCreepAssignmentState(carrier.name)).toMatchObject({
      synthesisCarrierPendingFromId: terminal.id,
      synthesisCarrierPendingToId: storage.id,
      synthesisCarrierPendingResource: RESOURCE_HYDROGEN,
    });
    expect(getEnergyStoreTarget).not.toHaveBeenCalled();
  });

  it("shares Storage capacity between storage-only Energy return and terminal offload pickup", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const room = createRoom("W4N9");
    const terminal = room.terminal as StructureTerminal;
    const storage = room.storage as StructureStorage;
    Object.assign(terminal, {
      room,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_HYDROGEN ? 1_000 : 0,
        getFreeCapacity: () => 10_000,
      },
    });
    Object.assign(storage, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 999_500,
        getFreeCapacity: () => 500,
      },
    });
    const storageOnlyCarrier = {
      ...createCreep(room),
      name: "carrier-storage-only-capacity",
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 300 : 0,
        getFreeCapacity: () => 500,
      },
      transfer: jest.fn(() => OK),
    } as unknown as Creep;
    const offloadCarrier = {
      ...createCreep(room),
      name: "carrier-offload-after-storage-only",
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    Game.creeps = {
      [storageOnlyCarrier.name]: storageOnlyCarrier,
      [offloadCarrier.name]: offloadCarrier,
    };
    Object.assign(ensureCreepAssignmentState(storageOnlyCarrier.name), {
      carrierStorageOnlyMode: true,
      carrierPlanMode: "deliver",
      carrierPlanTargetKind: "structure",
      carrierPlanTargetId: storage.id,
    });
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("test-storage-only-capacity", room.name, [{
      id: "terminal-offload-after-storage-only",
      type: "terminal_offload",
      priority: 90,
      steps: [{
        id: "H:terminal->storage-after-energy",
        resource: RESOURCE_HYDROGEN,
        fromKind: "terminal",
        toKind: "storage",
        fromId: terminal.id,
        toId: storage.id,
        amount: 500,
      }],
    }]);

    carrierRole().target(storageOnlyCarrier);
    carrierRole().source?.(offloadCarrier);

    expect(storageOnlyCarrier.transfer).toHaveBeenCalledWith(
      storage,
      RESOURCE_ENERGY,
    );
    expect(offloadCarrier.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_HYDROGEN,
      200,
    );
  });

  it("shares Storage capacity across terminal offload and no-task non-Energy cleanup", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const room = createRoom("W4N10");
    const terminal = room.terminal as StructureTerminal;
    const storage = room.storage as StructureStorage;
    Object.assign(terminal, {
      room,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_HYDROGEN ? 1_000 : 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_UTRIUM ? 0 : 10_000,
      },
    });
    Object.assign(storage, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 999_500,
        getFreeCapacity: () => 500,
      },
    });
    const offloadCarrier = {
      ...createCreep(room),
      name: "carrier-offload-before-cleanup",
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 300,
      },
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    const cleanupCarrier = {
      ...createCreep(room),
      name: "carrier-no-task-cleanup-capacity",
      store: {
        [RESOURCE_UTRIUM]: 400,
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_UTRIUM ? 400 : 0,
        getFreeCapacity: () => 400,
      },
      transfer: jest.fn(() => OK),
    } as unknown as Creep;
    Game.creeps = {
      [offloadCarrier.name]: offloadCarrier,
      [cleanupCarrier.name]: cleanupCarrier,
    };
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("test-cleanup-capacity", room.name, [{
      id: "terminal-offload-before-cleanup",
      type: "terminal_offload",
      priority: 90,
      steps: [{
        id: "H:terminal->storage-before-U",
        resource: RESOURCE_HYDROGEN,
        fromKind: "terminal",
        toKind: "storage",
        fromId: terminal.id,
        toId: storage.id,
        amount: 300,
      }],
    }]);

    carrierRole().source?.(offloadCarrier);
    carrierRole().target(cleanupCarrier);

    expect(offloadCarrier.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_HYDROGEN,
      300,
    );
    expect(cleanupCarrier.transfer).toHaveBeenCalledWith(
      storage,
      RESOURCE_UTRIUM,
      200,
    );
  });

  it("releases a failed storage-only destination claim for terminal offload", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const room = createRoom("W4N11");
    const terminal = room.terminal as StructureTerminal;
    const storage = room.storage as StructureStorage;
    Object.assign(terminal, {
      room,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_HYDROGEN ? 1_000 : 0,
        getFreeCapacity: () => 10_000,
      },
    });
    Object.assign(storage, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 999_500,
        getFreeCapacity: () => 500,
      },
    });
    const failedCarrier = {
      ...createCreep(room),
      name: "carrier-storage-only-failed-claim",
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
        getFreeCapacity: () => 300,
      },
      transfer: jest.fn(() => ERR_NOT_IN_RANGE),
    } as unknown as Creep;
    const offloadCarrier = {
      ...createCreep(room),
      name: "carrier-offload-after-failed-claim",
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    const throwingCarrier = {
      ...createCreep(room),
      name: "carrier-storage-only-throwing-claim",
      store: failedCarrier.store,
      transfer: jest.fn(() => {
        throw new Error("storage transfer failed");
      }),
    } as unknown as Creep;
    Game.creeps = {
      [failedCarrier.name]: failedCarrier,
      [throwingCarrier.name]: throwingCarrier,
      [offloadCarrier.name]: offloadCarrier,
    };
    ensureCreepAssignmentState(failedCarrier.name).carrierStorageOnlyMode = true;
    ensureCreepAssignmentState(throwingCarrier.name).carrierStorageOnlyMode = true;
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return terminal;
      if (id === storage.id) return storage;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("test-failed-direct-capacity", room.name, [{
      id: "terminal-offload-after-failed-direct",
      type: "terminal_offload",
      priority: 90,
      steps: [{
        id: "H:terminal->storage-after-failed-direct",
        resource: RESOURCE_HYDROGEN,
        fromKind: "terminal",
        toKind: "storage",
        fromId: terminal.id,
        toId: storage.id,
        amount: 500,
      }],
    }]);

    carrierRole().target(failedCarrier);
    expect(() => carrierRole().target(throwingCarrier)).toThrow(
      "storage transfer failed",
    );
    carrierRole().source?.(offloadCarrier);

    expect(moveToTarget).toHaveBeenCalledWith(failedCarrier, storage);
    expect(offloadCarrier.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_HYDROGEN,
      500,
    );
  });

  it("keeps accepted offload Energy bound when the source Terminal disappears", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const room = createRoom("W4N12");
    const terminal = room.terminal as StructureTerminal;
    const storage = room.storage as StructureStorage;
    let carriedEnergy = 0;
    let storageFree = 500;
    let sourceVisible = true;
    Object.assign(terminal, {
      room,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 1_000 : 0,
        getFreeCapacity: () => 10_000,
      },
    });
    Object.assign(storage, {
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 1_000_000 - storageFree,
        getFreeCapacity: () => storageFree,
      },
    });
    const carrier = {
      ...createCreep(room),
      name: "carrier-offload-source-disappeared",
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY
            ? carriedEnergy
            : 0,
        getFreeCapacity: () => 500 - carriedEnergy,
      },
      withdraw: jest.fn(() => {
        carriedEnergy = 500;
        return OK;
      }),
      transfer: jest.fn(() => ERR_FULL),
    } as unknown as Creep;
    Game.creeps = { [carrier.name]: carrier };
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === terminal.id) return sourceVisible ? terminal : null;
      if (id === storage.id) return storage;
      return null;
    }) as unknown as Game["getObjectById"];
    replaceCarrierTasksForProducerRoom("test-offload-provenance", room.name, [{
      id: "terminal-offload-source-disappeared",
      type: "terminal_offload",
      priority: 90,
      steps: [{
        id: "energy:terminal->storage-source-disappeared",
        resource: RESOURCE_ENERGY,
        fromKind: "terminal",
        toKind: "storage",
        fromId: terminal.id,
        toId: storage.id,
        amount: 500,
      }],
    }]);

    carrierRole().source?.(carrier);
    expect(getCreepAssignmentState(carrier.name)).toEqual(
      expect.objectContaining({
        synthesisCarrierPendingTaskType: "terminal_offload",
      }),
    );

    replaceCarrierTasksForProducerRoom("test-offload-provenance", room.name, []);
    sourceVisible = false;
    storageFree = 0;
    getEnergyStoreTarget.mockClear();
    getEnergyStoreTarget.mockReturnValue({
      id: "unrelated-energy-target-after-source-loss",
    } as unknown as AnyStoreStructure);

    expect(carrierRole().target(carrier)).toBe(false);
    expect(carrier.transfer).not.toHaveBeenCalled();
    expect(getCreepAssignmentState(carrier.name)).toEqual(
      expect.objectContaining({
        synthesisCarrierPendingTaskType: "terminal_offload",
        synthesisCarrierPendingToId: storage.id,
        synthesisCarrierPendingResource: RESOURCE_ENERGY,
      }),
    );
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

  it("keeps a runnable sticky task ahead of a newly published higher-priority task", () => {
    const room = createRoom("W201N1");
    const stickySource = createCarrierTaskTestContainer(
      room,
      "carrier-sticky-source",
      2,
      { [RESOURCE_UTRIUM]: 2_000 },
    );
    const stickyTarget = createCarrierTaskTestContainer(
      room,
      "carrier-sticky-target",
      3,
    );
    const highPrioritySource = createCarrierTaskTestContainer(
      room,
      "carrier-high-priority-source",
      1,
      { [RESOURCE_KEANIUM]: 2_000 },
    );
    const highPriorityTarget = createCarrierTaskTestContainer(
      room,
      "carrier-high-priority-target",
      4,
    );
    installCarrierTaskTestObjects([
      stickySource,
      stickyTarget,
      highPrioritySource,
      highPriorityTarget,
    ]);
    replaceCarrierTasksForProducerRoom("carrier-selection-test", room.name, [
      createMineralHaulTaskDraft(
        "carrier-sticky-task",
        10,
        RESOURCE_UTRIUM,
        stickySource,
        stickyTarget,
      ),
      createMineralHaulTaskDraft(
        "carrier-new-high-priority-task",
        1_000,
        RESOURCE_KEANIUM,
        highPrioritySource,
        highPriorityTarget,
      ),
    ]);
    const creep = createCreep(room);
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId =
      "carrier-sticky-task";

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      stickySource,
      RESOURCE_UTRIUM,
      800,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      highPrioritySource,
      RESOURCE_KEANIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBe("carrier-sticky-task");
  });

  it("reselects an unrunnable sticky task by priority before source distance", () => {
    const room = createRoom("W202N2");
    const destination = createCarrierTaskTestContainer(
      room,
      "carrier-reselect-target",
      5,
    );
    const staleSource = createCarrierTaskTestContainer(
      room,
      "carrier-stale-source",
      2,
    );
    const lowerPriorityClosestSource = createCarrierTaskTestContainer(
      room,
      "carrier-lower-priority-closest-source",
      1,
      { [RESOURCE_UTRIUM]: 2_000 },
    );
    const highPriorityFarSource = createCarrierTaskTestContainer(
      room,
      "carrier-high-priority-far-source",
      8,
      { [RESOURCE_UTRIUM]: 2_000 },
    );
    const highPriorityNearSource = createCarrierTaskTestContainer(
      room,
      "carrier-high-priority-near-source",
      3,
      { [RESOURCE_UTRIUM]: 2_000 },
    );
    installCarrierTaskTestObjects([
      destination,
      staleSource,
      lowerPriorityClosestSource,
      highPriorityFarSource,
      highPriorityNearSource,
    ]);
    replaceCarrierTasksForProducerRoom("carrier-reselection-test", room.name, [
      createMineralHaulTaskDraft(
        "carrier-stale-task",
        10_000,
        RESOURCE_UTRIUM,
        staleSource,
        destination,
      ),
      createMineralHaulTaskDraft(
        "carrier-lower-priority-closest-task",
        99,
        RESOURCE_UTRIUM,
        lowerPriorityClosestSource,
        destination,
      ),
      createMineralHaulTaskDraft(
        "carrier-high-priority-far-task",
        100,
        RESOURCE_UTRIUM,
        highPriorityFarSource,
        destination,
      ),
      createMineralHaulTaskDraft(
        "carrier-high-priority-near-task",
        100,
        RESOURCE_UTRIUM,
        highPriorityNearSource,
        destination,
      ),
    ]);
    const creep = createCreep(room);
    Object.assign(creep, {
      pos: {
        getRangeTo: (pos: RoomPosition) => pos.x,
      } as unknown as RoomPosition,
    });
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId =
      "carrier-stale-task";

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      highPriorityNearSource,
      RESOURCE_UTRIUM,
      800,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      lowerPriorityClosestSource,
      RESOURCE_UTRIUM,
      expect.any(Number),
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      highPriorityFarSource,
      RESOURCE_UTRIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBe("carrier-high-priority-near-task");
  });

  it("keeps equal-priority equal-distance task order stable across producer refresh", () => {
    const room = createRoom("W203N3");
    const destination = createCarrierTaskTestContainer(
      room,
      "carrier-stable-tie-target",
      5,
    );
    const firstSource = createCarrierTaskTestContainer(
      room,
      "carrier-stable-tie-first-source",
      2,
      { [RESOURCE_UTRIUM]: 2_000 },
    );
    const secondSource = createCarrierTaskTestContainer(
      room,
      "carrier-stable-tie-second-source",
      2,
      { [RESOURCE_UTRIUM]: 2_000 },
    );
    const firstTask = createMineralHaulTaskDraft(
      "carrier-stable-tie-first-task",
      100,
      RESOURCE_UTRIUM,
      firstSource,
      destination,
    );
    const secondTask = createMineralHaulTaskDraft(
      "carrier-stable-tie-second-task",
      100,
      RESOURCE_UTRIUM,
      secondSource,
      destination,
    );
    installCarrierTaskTestObjects([
      destination,
      firstSource,
      secondSource,
    ]);
    replaceCarrierTasksForProducerRoom(
      "carrier-stable-order-test",
      room.name,
      [firstTask, secondTask],
    );
    Game.time += 1;
    replaceCarrierTasksForProducerRoom(
      "carrier-stable-order-test",
      room.name,
      [secondTask, firstTask],
    );
    const creep = createCreep(room);
    Object.assign(creep, {
      pos: {
        getRangeTo: (pos: RoomPosition) => pos.x,
      } as unknown as RoomPosition,
    });

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      firstSource,
      RESOURCE_UTRIUM,
      800,
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
      .toBe("carrier-stable-tie-first-task");
  });

  it("selects the nearest source and destination independently across parallel task steps", () => {
    const room = createRoom("W204N4");
    const farSource = createCarrierTaskTestContainer(
      room,
      "carrier-parallel-far-source",
      8,
      { [RESOURCE_UTRIUM]: 2_000 },
    );
    const nearDestination = createCarrierTaskTestContainer(
      room,
      "carrier-parallel-near-destination",
      1,
    );
    const nearSource = createCarrierTaskTestContainer(
      room,
      "carrier-parallel-near-source",
      2,
      { [RESOURCE_KEANIUM]: 2_000 },
    );
    const farDestination = createCarrierTaskTestContainer(
      room,
      "carrier-parallel-far-destination",
      9,
    );
    installCarrierTaskTestObjects([
      farSource,
      nearDestination,
      nearSource,
      farDestination,
    ]);
    const taskId = "carrier-parallel-step-task";
    replaceCarrierTasksForProducerRoom("carrier-parallel-test", room.name, [{
      id: taskId,
      type: "mineral_haul",
      priority: 100,
      steps: [
        {
          id: "carrier-parallel-far-source-step",
          resource: RESOURCE_UTRIUM,
          fromKind: "container",
          toKind: "container",
          fromId: farSource.id,
          toId: nearDestination.id,
          amount: 400,
        },
        {
          id: "carrier-parallel-near-source-step",
          resource: RESOURCE_KEANIUM,
          fromKind: "container",
          toKind: "container",
          fromId: nearSource.id,
          toId: farDestination.id,
          amount: 400,
        },
      ],
    }]);
    const pickupCarrier = createCreep(room);
    pickupCarrier.name = "carrier-parallel-pickup";
    Object.assign(pickupCarrier, {
      pos: {
        getRangeTo: (pos: RoomPosition) => pos.x,
      } as unknown as RoomPosition,
    });
    const deliveryCarrier = {
      ...createCreep(room),
      name: "carrier-parallel-delivery",
      pos: {
        getRangeTo: (pos: RoomPosition) => pos.x,
      } as unknown as RoomPosition,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) return 800;
          if (resource === RESOURCE_UTRIUM) return 400;
          if (resource === RESOURCE_KEANIUM) return 400;
          return 0;
        },
        getFreeCapacity: () => 0,
      },
      transfer: jest.fn(() => OK),
    } as unknown as Creep;
    Game.creeps = {
      [pickupCarrier.name]: pickupCarrier,
      [deliveryCarrier.name]: deliveryCarrier,
    };
    ensureCreepAssignmentState(deliveryCarrier.name).synthesisCarrierTaskId =
      taskId;

    carrierRole().source?.(pickupCarrier);
    carrierRole().target(deliveryCarrier);

    expect(pickupCarrier.withdraw).toHaveBeenCalledWith(
      nearSource,
      RESOURCE_KEANIUM,
      400,
    );
    expect(deliveryCarrier.transfer).toHaveBeenCalledWith(
      nearDestination,
      RESOURCE_UTRIUM,
    );
  });

  it("allows multiple carriers to bind and withdraw from an ordinary task in the same tick", () => {
    const room = createRoom("W205N5");
    const source = createCarrierTaskTestContainer(
      room,
      "carrier-shared-ordinary-source",
      2,
      { [RESOURCE_UTRIUM]: 5_000 },
    );
    const destination = createCarrierTaskTestContainer(
      room,
      "carrier-shared-ordinary-target",
      3,
    );
    installCarrierTaskTestObjects([source, destination]);
    const taskId = "carrier-shared-ordinary-task";
    replaceCarrierTasksForProducerRoom("carrier-shared-task-test", room.name, [
      createMineralHaulTaskDraft(
        taskId,
        100,
        RESOURCE_UTRIUM,
        source,
        destination,
      ),
    ]);
    const first = createCreep(room);
    first.name = "carrier-shared-ordinary-first";
    const second = createCreep(room);
    second.name = "carrier-shared-ordinary-second";
    Game.creeps = {
      [first.name]: first,
      [second.name]: second,
    };

    carrierRole().source?.(first);
    carrierRole().source?.(second);

    expect(first.withdraw).toHaveBeenCalledWith(
      source,
      RESOURCE_UTRIUM,
      800,
    );
    expect(second.withdraw).toHaveBeenCalledWith(
      source,
      RESOURCE_UTRIUM,
      800,
    );
    expect(getCreepAssignmentState(first.name)?.synthesisCarrierTaskId)
      .toBe(taskId);
    expect(getCreepAssignmentState(second.name)?.synthesisCarrierTaskId)
      .toBe(taskId);
  });

  it("keeps a sticky task bound to its exact producer when another owner publishes the same local id", () => {
    const room = createRoom("W207N1");
    const firstSource = createCarrierTaskTestContainer(
      room,
      "carrier-owner-a-source",
      2,
      { [RESOURCE_UTRIUM]: 2_000 },
    );
    const secondSource = createCarrierTaskTestContainer(
      room,
      "carrier-owner-b-source",
      3,
      { [RESOURCE_KEANIUM]: 2_000 },
    );
    const destination = createCarrierTaskTestContainer(
      room,
      "carrier-owner-sticky-target",
      4,
    );
    installCarrierTaskTestObjects([firstSource, secondSource, destination]);
    const taskId = "shared-carrier-local-id";
    replaceCarrierTasksForProducerRoom("carrier-owner-a", room.name, [
      createMineralHaulTaskDraft(
        taskId,
        10,
        RESOURCE_UTRIUM,
        firstSource,
        destination,
      ),
    ]);
    const creep = createCreep(room);
    creep.withdraw = jest.fn(() => ERR_NOT_IN_RANGE);

    carrierRole().source?.(creep);
    replaceCarrierTasksForProducerRoom("carrier-owner-b", room.name, [
      createMineralHaulTaskDraft(
        taskId,
        1_000,
        RESOURCE_KEANIUM,
        secondSource,
        destination,
      ),
    ]);
    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledTimes(2);
    expect(creep.withdraw).toHaveBeenNthCalledWith(
      2,
      firstSource,
      RESOURCE_UTRIUM,
      800,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      secondSource,
      RESOURCE_KEANIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)).toMatchObject({
      synthesisCarrierTaskId: taskId,
      dispatchBindings: {
        carrier: {
          system: "carrier-logistics",
          namespace: "carrier-owner-a",
          scope: { kind: "room", roomName: room.name },
          localId: taskId,
        },
      },
    });
  });

  it("reselects by the existing priority lane after the bound owner disappears", () => {
    const room = createRoom("W208N2");
    const oldSource = createCarrierTaskTestContainer(
      room,
      "carrier-removed-owner-source",
      2,
      { [RESOURCE_UTRIUM]: 2_000 },
    );
    const sameNameSource = createCarrierTaskTestContainer(
      room,
      "carrier-same-name-owner-source",
      3,
      { [RESOURCE_KEANIUM]: 2_000 },
    );
    const preferredSource = createCarrierTaskTestContainer(
      room,
      "carrier-priority-reselection-source",
      4,
      { [RESOURCE_ZYNTHIUM]: 2_000 },
    );
    const destination = createCarrierTaskTestContainer(
      room,
      "carrier-owner-reselection-target",
      5,
    );
    installCarrierTaskTestObjects([
      oldSource,
      sameNameSource,
      preferredSource,
      destination,
    ]);
    const sharedTaskId = "carrier-owner-reselection-shared";
    replaceCarrierTasksForProducerRoom("removed-owner", room.name, [
      createMineralHaulTaskDraft(
        sharedTaskId,
        10,
        RESOURCE_UTRIUM,
        oldSource,
        destination,
      ),
    ]);
    const creep = createCreep(room);
    creep.withdraw = jest.fn(() => ERR_NOT_IN_RANGE);
    carrierRole().source?.(creep);

    replaceCarrierTasksForProducerRoom("same-name-owner", room.name, [
      createMineralHaulTaskDraft(
        sharedTaskId,
        50,
        RESOURCE_KEANIUM,
        sameNameSource,
        destination,
      ),
    ]);
    replaceCarrierTasksForProducerRoom("preferred-owner", room.name, [
      createMineralHaulTaskDraft(
        "carrier-owner-reselection-preferred",
        100,
        RESOURCE_ZYNTHIUM,
        preferredSource,
        destination,
      ),
    ]);
    replaceCarrierTasksForProducerRoom("removed-owner", room.name, []);
    (creep.withdraw as jest.Mock).mockClear();

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      preferredSource,
      RESOURCE_ZYNTHIUM,
      800,
    );
    expect(creep.withdraw).not.toHaveBeenCalledWith(
      sameNameSource,
      RESOURCE_KEANIUM,
      expect.any(Number),
    );
    expect(getCreepAssignmentState(creep.name)?.dispatchBindings?.carrier)
      .toMatchObject({
        namespace: "preferred-owner",
        scope: { roomName: room.name },
        localId: "carrier-owner-reselection-preferred",
      });
  });

  it("releases a sticky binding whose scope no longer matches the assigned carrier room", () => {
    const oldRoom = createRoom("W209N3");
    const newRoom = createRoom("W210N3");
    const oldSource = createCarrierTaskTestContainer(
      oldRoom,
      "carrier-old-room-source",
      2,
      { [RESOURCE_UTRIUM]: 2_000 },
    );
    const oldTarget = createCarrierTaskTestContainer(
      oldRoom,
      "carrier-old-room-target",
      3,
    );
    const newSource = createCarrierTaskTestContainer(
      newRoom,
      "carrier-new-room-source",
      2,
      { [RESOURCE_KEANIUM]: 2_000 },
    );
    const newTarget = createCarrierTaskTestContainer(
      newRoom,
      "carrier-new-room-target",
      3,
    );
    installCarrierTaskTestObjects([
      oldSource,
      oldTarget,
      newSource,
      newTarget,
    ]);
    replaceCarrierTasksForProducerRoom("old-room-owner", oldRoom.name, [
      createMineralHaulTaskDraft(
        "carrier-old-room-task",
        100,
        RESOURCE_UTRIUM,
        oldSource,
        oldTarget,
      ),
    ]);
    replaceCarrierTasksForProducerRoom("new-room-owner", newRoom.name, [
      createMineralHaulTaskDraft(
        "carrier-new-room-task",
        100,
        RESOURCE_KEANIUM,
        newSource,
        newTarget,
      ),
    ]);
    const creep = createCreep(oldRoom);
    creep.memory.configName = "carrier-room-drift-config";
    creep.withdraw = jest.fn(() => ERR_NOT_IN_RANGE);
    getCreepConfigService().upsert(
      creep.memory.configName,
      "carrier",
      [],
      oldRoom.name,
    );
    carrierRole().source?.(creep);
    getCreepConfigService().upsert(
      creep.memory.configName,
      "carrier",
      [],
      newRoom.name,
    );
    (creep.withdraw as jest.Mock).mockClear();

    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(
      newSource,
      RESOURCE_KEANIUM,
      800,
    );
    expect(getCreepAssignmentState(creep.name)?.dispatchBindings?.carrier)
      .toMatchObject({
        namespace: "new-room-owner",
        scope: { roomName: newRoom.name },
        localId: "carrier-new-room-task",
      });
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
    const room = createRoom("W206N1");
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
