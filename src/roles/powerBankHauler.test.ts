jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: (fn: () => any) => fn(),
  measureCreepDecision: (fn: () => any) => fn(),
}));

import { powerBankHaulerRole } from "@/roles/powerBankHauler";
import { createMockPowerBankCreep, createMockDroppedPower, createMockStore, MockPos } from "@mock/powerBank";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const SOURCE_ROOM = "W1N1";
const TARGET_ROOM = "E3N60";
const TASK_ID = "task-0";
const BANK_POS = { x: 25, y: 25 };

function setupTask(status: PowerBankHarvestStatus = "hauling"): PowerBankHarvestTask {
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

describe("powerBankHaulerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Memory as any).data = {};
    Game.creeps = {} as Record<string, Creep>;
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);
    Game.map = {
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) } as unknown as RoomTerrain)),
    } as unknown as GameMap;
    (global as typeof global & { RoomPosition: typeof MockPos }).RoomPosition = MockPos;
  });

  describe("travel to target room", () => {
    it("moves to target room when not there yet", () => {
      setupTask("hauling");
      const hauler = createHauler({ roomName: SOURCE_ROOM });

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.source(hauler);

      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler,
        TARGET_ROOM,
        undefined,
        expect.objectContaining({ travelRange: 3, reusePath: 10 }),
      );
    });
  });

  describe("wait at safe range while bank alive", () => {
    it("flees to range 5+ from bank position during attacking phase", () => {
      setupTask("attacking");
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 26, y: 25 });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(hauler.move).toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it("stays still when already at range 5+", () => {
      setupTask("attacking");
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 30, y: 30 });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(hauler.move).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it("moves to power bank vicinity instead of idling at room edge", () => {
      setupTask("attacking");
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 10, y: 10 });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(hauler.moveTo).toHaveBeenCalledWith(
        expect.objectContaining({ roomName: TARGET_ROOM }),
        expect.objectContaining({ range: 0, reusePath: 10 }),
      );
      const [stagingPos] = (hauler.moveTo as jest.Mock).mock.calls[0];
      expect(stagingPos.getRangeTo(BANK_POS)).toBeGreaterThanOrEqual(5);
      expect(stagingPos.getRangeTo(BANK_POS)).toBeLessThanOrEqual(6);
      expect(result).toBe(false);
    });

    it("does not stage on an exit tile when the bank is near a room edge", () => {
      const task = setupTask("attacking");
      task.bankPos = { x: 7, y: 5 };
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 14, y: 49 });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      const [stagingPos] = (hauler.moveTo as jest.Mock).mock.calls[0];
      expect(stagingPos.x).toBeGreaterThan(0);
      expect(stagingPos.x).toBeLessThan(49);
      expect(stagingPos.y).toBeGreaterThan(0);
      expect(stagingPos.y).toBeLessThan(49);
      expect(stagingPos.getRangeTo(task.bankPos)).toBeGreaterThanOrEqual(5);
      expect(result).toBe(false);
    });

    it("moves to power bank vicinity before attacking starts", () => {
      setupTask("travelling");
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 10, y: 10 });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(hauler.moveTo).toHaveBeenCalledWith(
        expect.objectContaining({ roomName: TARGET_ROOM }),
        expect.objectContaining({ range: 0, reusePath: 10 }),
      );
      expect(result).toBe(false);
    });
  });

  describe("pick up dropped power after bank destroyed", () => {
    it("picks up dropped power on bank position", () => {
      setupTask("hauling");
      const dropped = createMockDroppedPower({ x: 25, y: 25, roomName: TARGET_ROOM, amount: 3000 });

      const hauler = createHauler({ roomName: TARGET_ROOM });

      (hauler.room.find as jest.Mock) = jest.fn((_type: number, opts: any) => {
        if (_type === FIND_DROPPED_RESOURCES) {
          return opts.filter(dropped) ? [dropped] : [];
        }
        return [];
      });

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.source(hauler);

      expect(hauler.pickup).toHaveBeenCalledWith(dropped);
    });

    it("moves to dropped power when not in range", () => {
      setupTask("hauling");
      const dropped = createMockDroppedPower({ x: 25, y: 25, roomName: TARGET_ROOM, amount: 3000 });

      const hauler = createHauler({ roomName: TARGET_ROOM, x: 10, y: 10 });
      (hauler.pickup as jest.Mock) = jest.fn(() => ERR_NOT_IN_RANGE);

      (hauler.room.find as jest.Mock) = jest.fn((_type: number, opts: any) => {
        if (_type === FIND_DROPPED_RESOURCES) {
          return opts.filter(dropped) ? [dropped] : [];
        }
        return [];
      });

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.source(hauler);

      expect(moveToTarget).toHaveBeenCalledWith(hauler, dropped);
    });

    it("returns true (switch to target) when carry is full", () => {
      setupTask("hauling");
      const hauler = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 1600 },
        carryCapacity: 1600,
      });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(result).toBe(true);
    });

    it("returns false when no power on ground and empty", () => {
      setupTask("hauling");

      const hauler = createHauler({ roomName: TARGET_ROOM });

      (hauler.room.find as jest.Mock) = jest.fn(() => []);

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(result).toBe(false);
    });

    it("returns true when no power on ground but carrying some", () => {
      setupTask("hauling");
      const hauler = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 500 },
      });

      (hauler.room.find as jest.Mock) = jest.fn(() => []);

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(result).toBe(true);
    });
  });

  describe("deliver power to source room", () => {
    it("travels to source room when carrying power", () => {
      setupTask("hauling");
      const hauler = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 1000 },
      });

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.target(hauler);

      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler,
        SOURCE_ROOM,
        undefined,
        expect.objectContaining({ travelRange: 3, reusePath: 10 }),
      );
    });

    it("transfers power to terminal first", () => {
      setupTask("hauling");
      const hauler = createHauler({
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_POWER]: 1000 },
      });

      const terminalStore = createMockStore({ [RESOURCE_POWER]: 0 }, 100000);
      const terminal = {
        store: terminalStore,
        pos: new (require("@mock/powerBank").MockPos)(25, 25, SOURCE_ROOM) as unknown as RoomPosition,
      } as unknown as StructureTerminal;

      (hauler.room as any).terminal = terminal;
      (hauler.room as any).storage = null;

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.target(hauler);

      expect(hauler.transfer).toHaveBeenCalledWith(terminal, RESOURCE_POWER);
    });

    it("falls back to storage when terminal full", () => {
      setupTask("hauling");
      const hauler = createHauler({
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_POWER]: 1000 },
      });

      const terminal = {
        store: createMockStore({}, 0),
      } as unknown as StructureTerminal;
      (terminal.store.getFreeCapacity as jest.Mock) = jest.fn(() => 0);

      const storageStore = createMockStore({ [RESOURCE_POWER]: 0 }, 100000);
      const storage = {
        store: storageStore,
        pos: new (require("@mock/powerBank").MockPos)(20, 20, SOURCE_ROOM) as unknown as RoomPosition,
      } as unknown as StructureStorage;

      (hauler.room as any).terminal = terminal;
      (hauler.room as any).storage = storage;

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.target(hauler);

      expect(hauler.transfer).toHaveBeenCalledWith(storage, RESOURCE_POWER);
    });
  });

  describe("ignore generic energy assignments", () => {
    it("prepare returns true immediately — does not participate in energy assignments", () => {
      setupTask("hauling");
      const hauler = createHauler({ roomName: TARGET_ROOM });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.prepare!(hauler);

      expect(result).toBe(true);
    });
  });

  describe("deliver held power on task abort", () => {
    it("delivers held power when task is aborted", () => {
      setupTask("aborted");
      const hauler = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 800 },
      });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler,
        SOURCE_ROOM,
        undefined,
        expect.objectContaining({ travelRange: 3, reusePath: 10 }),
      );
    });

    it("suicides when task aborted and empty", () => {
      setupTask("aborted");
      const hauler = createHauler({ roomName: TARGET_ROOM });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(result).toBe(true);
      expect(hauler.suicide).toHaveBeenCalled();
    });

    it("suicides in target when aborted and empty", () => {
      setupTask("aborted");
      const hauler = createHauler({ roomName: TARGET_ROOM });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.target(hauler);

      expect(result).toBe(true);
      expect(hauler.suicide).toHaveBeenCalled();
    });
  });

  describe("multiple haulers split pickup", () => {
    it("second hauler picks up remaining power after first fills", () => {
      setupTask("hauling");

      const dropped1 = createMockDroppedPower({ id: "dp-1", x: 25, y: 25, amount: 3000 });
      const dropped2 = createMockDroppedPower({ id: "dp-2", x: 26, y: 25, amount: 2000 });

      const hauler1 = createMockPowerBankCreep("powerBankHauler", {
        roomName: TARGET_ROOM,
        x: 25,
        y: 24,
        store: { [RESOURCE_POWER]: 1600 },
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:0` } as Partial<CreepMemory>,
      });

      const hauler2 = createMockPowerBankCreep("powerBankHauler", {
        roomName: TARGET_ROOM,
        x: 26,
        y: 24,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:1` } as Partial<CreepMemory>,
      });

      const findAll = [dropped1, dropped2];
      const filterFn = (r: Resource) => r.resourceType === RESOURCE_POWER;

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result1 = role.source(hauler1);
      expect(result1).toBe(true);

      (hauler2.room.find as jest.Mock) = jest.fn((_type: number, opts: any) => {
        if (_type === FIND_DROPPED_RESOURCES) {
          return findAll.filter(opts.filter);
        }
        return [];
      });

      const result2 = role.source(hauler2);
      expect(hauler2.pickup).toHaveBeenCalled();
    });
  });

  describe("goes back for more power", () => {
    it("target phase returns to target room when hauling still active", () => {
      setupTask("hauling");
      const hauler = createHauler({
        roomName: SOURCE_ROOM,
      });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.target(hauler);

      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler,
        TARGET_ROOM,
        undefined,
        expect.objectContaining({ travelRange: 3, reusePath: 10 }),
      );
      expect(result).toBe(false);
    });

    it("target phase returns false when in target room with hauling active", () => {
      setupTask("hauling");
      const hauler = createHauler({ roomName: TARGET_ROOM });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.target(hauler);

      expect(result).toBe(false);
    });
  });

  describe("no task", () => {
    it("salvages dropped power from remembered target room", () => {
      const dropped = createMockDroppedPower({ x: 25, y: 25, roomName: TARGET_ROOM, amount: 1000 });
      const hauler = createMockPowerBankCreep("powerBankHauler", {
        roomName: TARGET_ROOM,
        carryCapacity: 1600,
        memory: {
          role: "powerBankHauler",
          roleArgs: [TARGET_ROOM, ""],
          configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:0`,
        } as Partial<CreepMemory>,
      });
      (hauler.room.find as jest.Mock) = jest.fn((type: number, opts: any) => {
        if (type === FIND_DROPPED_RESOURCES) {
          return opts.filter(dropped) ? [dropped] : [];
        }
        return [];
      });

      const role = powerBankHaulerRole();
      const result = role.source(hauler);

      expect(hauler.pickup).toHaveBeenCalledWith(dropped);
      expect(result).toBe(false);
    });

    it("travels to remembered target room to salvage when empty", () => {
      const hauler = createMockPowerBankCreep("powerBankHauler", {
        roomName: SOURCE_ROOM,
        carryCapacity: 1600,
        memory: {
          role: "powerBankHauler",
          roleArgs: [TARGET_ROOM, ""],
          configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:0`,
        } as Partial<CreepMemory>,
      });

      const role = powerBankHaulerRole();
      const result = role.source(hauler);

      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler,
        TARGET_ROOM,
        undefined,
        expect.objectContaining({ travelRange: 3, reusePath: 10 }),
      );
      expect(result).toBe(false);
    });

    it("waits away from a live bank while salvaging before power drops", () => {
      const bank = {
        structureType: STRUCTURE_POWER_BANK,
        pos: new (require("@mock/powerBank").MockPos)(25, 25, TARGET_ROOM) as unknown as RoomPosition,
      } as StructurePowerBank;
      const hauler = createMockPowerBankCreep("powerBankHauler", {
        roomName: TARGET_ROOM,
        x: 26,
        y: 25,
        carryCapacity: 1600,
        memory: {
          role: "powerBankHauler",
          roleArgs: [TARGET_ROOM, ""],
          configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:0`,
        } as Partial<CreepMemory>,
      });
      (hauler.room.find as jest.Mock) = jest.fn((type: number, opts?: any) => {
        if (type === FIND_DROPPED_RESOURCES) return [];
        if (type === FIND_STRUCTURES) return opts.filter(bank) ? [bank] : [];
        return [];
      });

      const role = powerBankHaulerRole();
      const result = role.source(hauler);

      expect(hauler.move).toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it("delivers held power and returns true when no task", () => {
      const hauler = createMockPowerBankCreep("powerBankHauler", {
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 500 },
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:0` } as Partial<CreepMemory>,
      });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(moveToTargetRoom).toHaveBeenCalled();
    });

    it("suicides when no task and empty after salvage scan", () => {
      const hauler = createMockPowerBankCreep("powerBankHauler", {
        roomName: TARGET_ROOM,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:0` } as Partial<CreepMemory>,
      });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(result).toBe(true);
      expect(hauler.suicide).toHaveBeenCalled();
    });
  });
});
