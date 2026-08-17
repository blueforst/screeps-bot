jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: (fn: () => any) => fn(),
  measureCreepDecision: (fn: () => any) => fn(),
}));

import { powerBankHaulerRole } from "@/roles/powerBankHauler";
import { createMockPowerBankCreep, createMockStore, MockPos } from "@mock/powerBank";
import { clearCreepMovementStateForTest } from "@/movement/creepState";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const SOURCE_ROOM = "W1N1";
const TARGET_ROOM = "E3N60";
const TASK_ID = "task-0";
const BANK_POS = { x: 25, y: 25 };

function setupTask(
  status: PowerBankHarvestStatus = "hauling",
  overrides: Partial<PowerBankHarvestTask> = {},
): PowerBankHarvestTask {
  const task: PowerBankHarvestTask = {
    id: TASK_ID,
    status,
    sourceRoom: SOURCE_ROOM,
    targetRoom: TARGET_ROOM,
    bankId: "pb-0",
    bankPos: BANK_POS,
    hits: 2_000_000,
    power: 5000,
    ticksToDecay: 5000,
    freeTiles: 8,
    discoveredTick: 100,
    lastSeenTick: 100,
    haulerIds: [],
    boostLabs: [],
    compoundTransferTaskIds: [],
    ...overrides,
  };
  if (!Memory.data) (Memory as any).data = {};
  if (!Memory.data.powerBankHarvest) Memory.data.powerBankHarvest = {};
  Memory.data.powerBankHarvest![TASK_ID] = task;
  return task;
}

function createHauler(overrides: {
  roomName?: string;
  x?: number;
  y?: number;
  store?: Record<string, number>;
  carryCapacity?: number;
}): Creep {
  return createMockPowerBankCreep("powerBankHauler", {
    roomName: overrides.roomName ?? TARGET_ROOM,
    x: overrides.x ?? 20,
    y: overrides.y ?? 20,
    store: overrides.store ?? {},
    carryCapacity: overrides.carryCapacity ?? 1600,
    memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:0` } as Partial<CreepMemory>,
  });
}

function createDeliveryRoom(
  roomName: string,
  options: {
    terminalFree?: number;
    storageFree?: number;
    hostile?: boolean;
  } = {},
): Room {
  const capacity = 10_000;
  const makeStructure = (
    kind: typeof STRUCTURE_TERMINAL | typeof STRUCTURE_STORAGE,
    free: number | undefined,
  ): StructureTerminal | StructureStorage | undefined => {
    if (free === undefined) return undefined;
    return {
      id: `${roomName}-${kind}` as Id<StructureTerminal | StructureStorage>,
      structureType: kind,
      pos: new MockPos(20, 20, roomName) as unknown as RoomPosition,
      store: createMockStore({ [RESOURCE_POWER]: capacity - free }, capacity),
    } as unknown as StructureTerminal | StructureStorage;
  };

  const hostile = { id: `${roomName}-hostile` } as Creep;
  return {
    name: roomName,
    controller: { my: true } as StructureController,
    terminal: makeStructure(STRUCTURE_TERMINAL, options.terminalFree) as StructureTerminal | undefined,
    storage: makeStructure(STRUCTURE_STORAGE, options.storageFree) as StructureStorage | undefined,
    find: jest.fn((constant: FindConstant) => {
      if (constant === FIND_HOSTILE_CREEPS) return options.hostile ? [hostile] : [];
      return [];
    }),
  } as unknown as Room;
}

describe("powerBankHaulerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Memory as any).data = {};
    Game.creeps = {} as Record<string, Creep>;
    Game.rooms = {} as Record<string, Room>;
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);
    Game.map = {
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) } as unknown as RoomTerrain)),
      findRoute: jest.fn(() => [{ exit: RIGHT, room: SOURCE_ROOM }]),
    } as unknown as GameMap;
    (global as typeof global & { RoomPosition: typeof MockPos }).RoomPosition = MockPos;
    delete (global as any).__runtimeServices;
    clearCreepMovementStateForTest();
  });

  describe("wait at safe range while bank alive", () => {

    it("moves to power bank vicinity before attacking starts", () => {
      setupTask("travelling");
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 10, y: 10 });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(moveToTarget).toHaveBeenCalledWith(
        hauler,
        expect.objectContaining({ roomName: TARGET_ROOM }),
        0,
        expect.objectContaining({ reusePath: 10, ignoreCreeps: true, avoidExitTiles: true }),
      );
      expect(result).toBe(false);
    });
  });

  describe("安全备用投递房", () => {
    it("原来源 terminal 和 storage 满载时前往 TTL 内可达的安全己方备用房", () => {
      const task = setupTask("hauling");
      Game.rooms[SOURCE_ROOM] = createDeliveryRoom(SOURCE_ROOM, { terminalFree: 0, storageFree: 0 });
      const alternateRoom = createDeliveryRoom("W2N1", { terminalFree: 5000 });
      Game.rooms[alternateRoom.name] = alternateRoom;
      const hauler = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 600 },
        carryCapacity: 1000,
      });
      (hauler as Creep & { ticksToLive: number }).ticksToLive = 500;

      const role = powerBankHaulerRole(TARGET_ROOM);
      expect(role.target(hauler)).toBe(false);
      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler,
        alternateRoom.name,
        undefined,
        expect.objectContaining({ travelRange: 3, reusePath: 10 }),
      );

      hauler.room = alternateRoom;
      hauler.pos = new MockPos(20, 19, alternateRoom.name) as unknown as RoomPosition;
      expect(role.target(hauler)).toBe(false);
      expect(hauler.transfer).toHaveBeenCalledWith(alternateRoom.terminal, RESOURCE_POWER, 600);
      expect((task as any).deliveredPower).toBe(600);
      expect((task as any).lastProgressAt).toBe(Game.time);
      expect((hauler.memory as any).powerBankDeliveryRoom).toBe(alternateRoom.name);
    });
  });
});
