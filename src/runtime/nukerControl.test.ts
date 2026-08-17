import {
  clearCarrierTaskBoardForTest,
  listCarrierTasksByRoom,
} from "@/runtime/carrierTaskBoard";
import {
  clearCreepAssignmentStateForTest,
} from "@/runtime/creepAssignmentState";
import {
  NUKER_CARRIER_TASK_PRODUCER,
  NUKER_ENERGY_SUPPLY_PRIORITY,
  runNukerControl,
} from "@/runtime/nukerControl";
import { listProductionReservations } from "@/runtime/resourceReservation";

type MutableStore = StoreDefinition & {
  set(resource: ResourceConstant, amount: number): void;
};

interface RoomScenario {
  room: Room;
  nuker: StructureNuker | null;
  storage: StructureStorage;
  terminal: StructureTerminal;
  removeNuker(): void;
}

function resetRuntimeServices(): void {
  delete (global as typeof global & { __runtimeServices?: unknown })
    .__runtimeServices;
}

function createMutableStore(
  initial: Partial<Record<ResourceConstant, number>>,
  capacities: Partial<Record<ResourceConstant, number>>,
  totalCapacity: number,
): MutableStore {
  const amounts = { ...initial };
  return {
    set(resource: ResourceConstant, amount: number): void {
      amounts[resource] = amount;
    },
    getUsedCapacity(resource?: ResourceConstant): number {
      if (resource !== undefined) return amounts[resource] || 0;
      return Object.values(amounts).reduce(
        (sum, amount) => sum + (amount || 0),
        0,
      );
    },
    getCapacity(resource?: ResourceConstant): number {
      if (resource !== undefined && capacities[resource] !== undefined) {
        return capacities[resource] || 0;
      }
      return totalCapacity;
    },
    getFreeCapacity(resource?: ResourceConstant): number {
      const capacity =
        resource !== undefined && capacities[resource] !== undefined
          ? capacities[resource] || 0
          : totalCapacity;
      const used = resource !== undefined
        ? amounts[resource] || 0
        : Object.values(amounts).reduce(
            (sum, amount) => sum + (amount || 0),
            0,
          );
      return Math.max(0, capacity - used);
    },
  } as MutableStore;
}

function createRoomScenario(options: {
  roomName: string;
  withNuker?: boolean;
  storageEnergy?: number;
  terminalEnergy?: number;
  storageGhodium?: number;
  terminalGhodium?: number;
  nukerEnergy?: number;
  nukerGhodium?: number;
}): RoomScenario {
  const roomName = options.roomName;
  const storage = {
    id: `${roomName}-storage`,
    structureType: STRUCTURE_STORAGE,
    pos: { x: 10, y: 10, roomName },
    store: createMutableStore(
      {
        [RESOURCE_ENERGY]: options.storageEnergy || 0,
        [RESOURCE_GHODIUM]: options.storageGhodium || 0,
      },
      {},
      1_000_000,
    ),
  } as unknown as StructureStorage;
  const terminal = {
    id: `${roomName}-terminal`,
    structureType: STRUCTURE_TERMINAL,
    pos: { x: 11, y: 10, roomName },
    cooldown: 0,
    store: createMutableStore(
      {
        [RESOURCE_ENERGY]: options.terminalEnergy || 0,
        [RESOURCE_GHODIUM]: options.terminalGhodium || 0,
      },
      {},
      300_000,
    ),
  } as unknown as StructureTerminal;
  let nuker: StructureNuker | null = options.withNuker === false
    ? null
    : {
        id: `${roomName}-nuker`,
        structureType: STRUCTURE_NUKER,
        pos: { x: 12, y: 10, roomName },
        store: createMutableStore(
          {
            [RESOURCE_ENERGY]: options.nukerEnergy || 0,
            [RESOURCE_GHODIUM]: options.nukerGhodium || 0,
          },
          {
            [RESOURCE_ENERGY]: 300_000,
            [RESOURCE_GHODIUM]: 5_000,
          },
          305_000,
        ),
      } as unknown as StructureNuker;

  const room = {
    name: roomName,
    controller: { my: true, level: 8 },
    storage,
    terminal,
    find(type: FindConstant): unknown[] {
      if (type === FIND_MY_STRUCTURES) return nuker ? [nuker] : [];
      return [];
    },
  } as unknown as Room;
  Object.assign(storage, { room });
  Object.assign(terminal, { room });
  if (nuker) Object.assign(nuker, { room });
  Game.rooms[roomName] = room;

  return {
    room,
    get nuker() {
      return nuker;
    },
    storage,
    terminal,
    removeNuker(): void {
      nuker = null;
    },
  };
}

function getNukerTasks(roomName: string) {
  return listCarrierTasksByRoom(roomName).filter(
    (task) => task.producer === NUKER_CARRIER_TASK_PRODUCER,
  );
}

describe("nukerControl", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    resetRuntimeServices();
    Game.time = 100;
    Game.rooms = {};
    Game.creeps = {};
    Game.flags = {};
    (Game as unknown as { market: Partial<Market> }).market = {
      calcTransactionCost: jest.fn(() => 100),
    };
    Memory.cfg = {
      resourceControl: {
        rooms: {},
      },
    };
    Memory.runtime = { hub: { needsPlan: false } };
    Memory.data = {};
  });

  it("E6N59 水位略低于 target 时按 floor 发布单 Carrier 批次", () => {
    const scenario = createRoomScenario({
      roomName: "E6N59",
      storageEnergy: 196_795,
      terminalEnergy: 21_376,
      storageGhodium: 5_000,
    });

    runNukerControl();

    const tasks = getNukerTasks(scenario.room.name);
    expect(tasks).toHaveLength(2);
    const ghodiumTask = tasks.find((task) =>
      task.steps.some((step) => step.resource === RESOURCE_GHODIUM),
    );
    const energyTask = tasks.find((task) =>
      task.steps.some((step) => step.resource === RESOURCE_ENERGY),
    );
    expect(ghodiumTask?.steps).toEqual([
      expect.objectContaining({
        resource: RESOURCE_GHODIUM,
        fromId: scenario.storage.id,
        toId: scenario.nuker?.id,
        amount: 5_000,
      }),
    ]);
    expect(energyTask?.priority).toBe(NUKER_ENERGY_SUPPLY_PRIORITY);
    expect(NUKER_ENERGY_SUPPLY_PRIORITY).toBe(0);
    expect(energyTask?.steps.reduce((sum, step) => sum + step.amount, 0))
      .toBe(1_000);
    expect(energyTask?.steps).toEqual([
      expect.objectContaining({ fromKind: "storage", amount: 1_000 }),
    ]);
    expect(Memory.runtime?.nukerControl?.ghodiumProductionDemand).toBe(5_000);
    expect(Memory.runtime?.nukerControl?.rooms.E6N59).toEqual(
      expect.objectContaining({
        reserveMode: false,
        ghodiumDeficit: 5_000,
        energyDeficit: 300_000,
        safeEnergy: 78_171,
        carrierTaskCount: 2,
      }),
    );
    expect(Memory.runtime?.hub?.needsPlan).toBe(true);
    expect(listProductionReservations().filter((reservation) =>
      reservation.holderId.startsWith("nuker:"),
    )).toHaveLength(2);
    expect(listProductionReservations().find((reservation) =>
      reservation.holderId.startsWith("nuker:") &&
      reservation.resource === RESOURCE_ENERGY,
    )?.amount).toBe(1_000);
  });

  it("Nuker 消失后清除任务、预留和运行态，并请求 Hub 重规划", () => {
    const scenario = createRoomScenario({
      roomName: "W4N1",
      storageEnergy: 200_000,
      storageGhodium: 5_000,
    });
    runNukerControl();
    expect(getNukerTasks(scenario.room.name)).toHaveLength(2);

    scenario.removeNuker();
    Game.time += 1;
    Memory.runtime!.hub!.needsPlan = false;
    runNukerControl();

    expect(getNukerTasks(scenario.room.name)).toHaveLength(0);
    expect(listProductionReservations().some((reservation) =>
      reservation.holderId.startsWith("nuker:"),
    )).toBe(false);
    expect(Memory.runtime?.nukerControl?.rooms).toEqual({});
    expect(Memory.runtime?.nukerControl?.ghodiumProductionDemand).toBe(0);
    expect(Memory.runtime?.hub?.needsPlan).toBe(true);
  });
});
