import { mountCreep } from "@/mount/mountCreep";
import { clearCarrierTaskBoardForTest, replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState } from "@/runtime/creepAssignmentState";

jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(),
}));

jest.mock("@/roles/energyTargets", () => ({
  getEnergyStoreTarget: jest.fn(() => null),
  isDroppedResourceTarget: jest.fn(() => false),
}));

jest.mock("@/runtime/energyPickupReservation", () => ({
  getPickupTargetEnergyAmount: jest.fn(() => 0),
  getReservedPickupTarget: jest.fn(() => null),
  releasePickupReservation: jest.fn(),
  reservePickupTarget: jest.fn(() => false),
}));

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getPlannedStoragePos: jest.fn(() => null),
  getPlannedControllerLinkPos: jest.fn(() => null),
  getProtoStorageContainer: jest.fn(() => null),
  getProtoControllerLinkContainer: jest.fn(() => null),
}));

jest.mock("@/runtime/crossShardNaming", () => ({
  decodeCrossShardTravelerName: jest.fn(() => null),
}));

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
  Creep: typeof Creep;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function installCreepPrototype(): void {
  class CreepMock {}
  (global as RuntimeGlobal).Creep = CreepMock as unknown as typeof Creep;
}

function createRoom(name = "W1N1", options: { storage?: StructureStorage | null; terminal?: StructureTerminal | null } = {}): Room {
  const room = {
    name,
    controller: { my: true, level: 6 } as StructureController,
    storage: options.storage === undefined ? {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureStorage : options.storage,
    terminal: options.terminal === undefined ? {
      id: `${name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal : options.terminal,
    find: () => [],
  } as unknown as Room;

  Game.rooms[name] = room;
  return room;
}

describe("mountCreep carrier switching", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    resetRuntimeServices();
    installCreepPrototype();
    mountCreep();
    Game.time += 1;
    Memory.rooms = {};
    Game.rooms = {};
    Game.creeps = {};
  });

  it("does not ping-pong source and target when a carrier holds minerals with no valid synthesis delivery target", () => {
    const room = createRoom("W1N9", { storage: null, terminal: null });
    const lab = {
      id: "lab-1",
      structureType: STRUCTURE_LAB,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 200 : 0),
        getFreeCapacity: () => 0,
      },
    } as unknown as StructureLab;
    replaceCarrierTasksForProducerRoom("test", room.name, [
      {
        id: "lab-cleanup-task",
        type: "lab_cleanup",
        priority: 100,
        steps: [
          {
            id: "step-1",
            resource: RESOURCE_KEANIUM,
            fromKind: "lab",
            toKind: "storage",
            fromId: lab.id,
            toId: lab.id,
            amount: 200,
          },
        ],
      },
    ]);

    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) =>
      id === lab.id ? lab : null,
    ) as Game["getObjectById"];

    let keanium = 100;
    const creep = {
      name: "carrier-1",
      room,
      memory: {
        ready: true,
        working: true,
        role: "carrier",
        roleArgs: [],
      },
      pos: {
        getRangeTo: () => 1,
      } as unknown as RoomPosition,
      store: {
        [RESOURCE_KEANIUM]: 100,
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) {
            return keanium;
          }
          return resource === RESOURCE_KEANIUM ? keanium : 0;
        },
        getFreeCapacity: () => 900,
      },
      say: jest.fn(),
      transfer: jest.fn(() => ERR_FULL),
      withdraw: jest.fn(() => ERR_NOT_ENOUGH_RESOURCES),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "lab-cleanup-task";
    Object.setPrototypeOf(creep, Creep.prototype);
    Game.creeps[creep.name] = creep;

    creep.work();
    expect(creep.memory.working).toBe(true);

    creep.work();
    expect(creep.memory.working).toBe(true);
  });
});
