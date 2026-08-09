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
import { clearCreepMovementStateForTest, ensureCreepMovementState } from "@/movement/creepState";

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

  describe("ignore generic energy assignments", () => {
    it("prepare returns true immediately — does not participate in energy assignments", () => {
      setupTask("hauling");
      const hauler = createHauler({ roomName: TARGET_ROOM });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.prepare!(hauler);

      expect(result).toBe(true);
    });
  });

  describe("goes back for more power", () => {

    it("target phase returns false when in target room with hauling active", () => {
      setupTask("hauling");
      const hauler = createHauler({ roomName: TARGET_ROOM });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.target(hauler);

      expect(result).toBe(false);
    });

    it("source 与 target 往返消费任务路线和危险房快照", () => {
      setupTask("hauling", {
        routeRooms: [SOURCE_ROOM, "W2N1", TARGET_ROOM],
        avoidRooms: ["W9N9"],
      });
      const hauler = createHauler({ roomName: SOURCE_ROOM });

      const role = powerBankHaulerRole(TARGET_ROOM, "legacy-route");
      expect(role.target(hauler)).toBe(false);
      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler,
        TARGET_ROOM,
        `${SOURCE_ROOM}|W2N1|${TARGET_ROOM}`,
        expect.objectContaining({ avoidRooms: ["W9N9"] }),
      );

      moveToTargetRoom.mockClear();
      Game.rooms[SOURCE_ROOM] = createDeliveryRoom(SOURCE_ROOM, { terminalFree: 1000 });
      const inbound = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 500 },
        carryCapacity: 1000,
      });
      (inbound as Creep & { ticksToLive: number }).ticksToLive = 500;
      expect(role.target(inbound)).toBe(false);
      expect(moveToTargetRoom).toHaveBeenCalledWith(
        inbound,
        SOURCE_ROOM,
        `${SOURCE_ROOM}|W2N1|${TARGET_ROOM}`,
        expect.objectContaining({ avoidRooms: ["W9N9"] }),
      );
    });
  });

  describe("Power 专用容量与领取", () => {
    it("调用真实 pickup intent，并在部分装载且掉落消失后切换为投递", () => {
      setupTask("hauling");
      const dropped = createMockDroppedPower({ roomName: TARGET_ROOM, amount: 400 });
      const hauler = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 0 },
        carryCapacity: 1000,
      });
      hauler.room.find = jest.fn((constant: FindConstant) =>
        constant === FIND_DROPPED_RESOURCES ? [dropped] : [],
      ) as Room["find"];

      const role = powerBankHaulerRole(TARGET_ROOM);
      expect(role.source(hauler)).toBe(false);
      expect(hauler.pickup).toHaveBeenCalledWith(dropped);

      hauler.store = createMockStore({ [RESOURCE_POWER]: 400 }, 1000) as Store<ResourceConstant, false>;
      hauler.room.find = jest.fn(() => []) as Room["find"];
      expect(role.source(hauler)).toBe(true);
    });

    it("忽略非 Power 载荷，不会把携带 energy 误判为待投递 Power", () => {
      setupTask("hauling");
      const hauler = createHauler({
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_ENERGY]: 500 },
        carryCapacity: 1000,
      });

      const role = powerBankHaulerRole(TARGET_ROOM);
      expect(role.target(hauler)).toBe(false);
      expect(hauler.transfer).not.toHaveBeenCalled();
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

    it("来源 terminal 满载时优先回退到同房 storage", () => {
      const task = setupTask("hauling");
      const sourceRoom = createDeliveryRoom(SOURCE_ROOM, { terminalFree: 0, storageFree: 1000 });
      Game.rooms[SOURCE_ROOM] = sourceRoom;
      const hauler = createHauler({
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_POWER]: 500 },
        carryCapacity: 1000,
      });
      hauler.room = sourceRoom;

      const role = powerBankHaulerRole(TARGET_ROOM);
      expect(role.target(hauler)).toBe(false);
      expect(hauler.transfer).toHaveBeenCalledWith(sourceRoom.storage, RESOURCE_POWER, 500);
      expect((task as any).deliveredPower).toBe(500);
    });

    it("按有效 headroom 限制部分投递并累计真实计划交付量", () => {
      const task = setupTask("hauling");
      const sourceRoom = createDeliveryRoom(SOURCE_ROOM, { terminalFree: 200, storageFree: 0 });
      Game.rooms[SOURCE_ROOM] = sourceRoom;
      const hauler = createHauler({
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_POWER]: 500 },
        carryCapacity: 1000,
      });
      hauler.room = sourceRoom;

      const role = powerBankHaulerRole(TARGET_ROOM);
      expect(role.target(hauler)).toBe(false);
      expect(hauler.transfer).toHaveBeenCalledWith(sourceRoom.terminal, RESOURCE_POWER, 200);
      expect((task as any).deliveredPower).toBe(200);
    });

    it("同 tick 多车竞争时预留 headroom，投递 intent 总量不会超过目标容量", () => {
      const task = setupTask("hauling");
      const sourceRoom = createDeliveryRoom(SOURCE_ROOM, { terminalFree: 400, storageFree: 0 });
      Game.rooms[SOURCE_ROOM] = sourceRoom;
      const first = createHauler({
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_POWER]: 300 },
        carryCapacity: 1000,
      });
      const second = createMockPowerBankCreep("powerBankHauler", {
        name: "powerBankHauler-1",
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_POWER]: 300 },
        carryCapacity: 1000,
        memory: {
          role: "powerBankHauler",
          taskId: TASK_ID,
          configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:1`,
        } as Partial<CreepMemory>,
      });
      first.room = sourceRoom;
      second.room = sourceRoom;

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.target(first);
      role.target(second);

      expect(first.transfer).toHaveBeenCalledWith(sourceRoom.terminal, RESOURCE_POWER, 300);
      expect(second.transfer).toHaveBeenCalledWith(sourceRoom.terminal, RESOURCE_POWER, 100);
      expect((task as any).deliveredPower).toBe(400);
    });

    it("跳过危险或 TTL 不足的备用房并报告准确 blocker", () => {
      const task = setupTask("hauling");
      Game.rooms[SOURCE_ROOM] = createDeliveryRoom(SOURCE_ROOM, { terminalFree: 0, storageFree: 0 });
      Game.rooms.W2N1 = createDeliveryRoom("W2N1", { terminalFree: 5000, hostile: true });
      Game.rooms.W3N1 = createDeliveryRoom("W3N1", { terminalFree: 5000 });
      (Game.map.findRoute as jest.Mock).mockReturnValue([
        { exit: RIGHT, room: "W2N1" },
        { exit: RIGHT, room: "W3N1" },
      ]);
      const hauler = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 500 },
        carryCapacity: 1000,
      });
      (hauler as Creep & { ticksToLive: number }).ticksToLive = 100;

      const role = powerBankHaulerRole(TARGET_ROOM);
      expect(role.target(hauler)).toBe(false);
      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect((task as any).blocker).toBe("hauler_delivery_ttl_insufficient");
      expect((task as any).nextAttemptAt).toBe(Game.time + 5);
    });

    it("没有任何接收容量时将等待升级为有界 timeout blocker", () => {
      const task = setupTask("hauling");
      Game.rooms[SOURCE_ROOM] = createDeliveryRoom(SOURCE_ROOM, { terminalFree: 0, storageFree: 0 });
      const hauler = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 500 },
        carryCapacity: 1000,
      });
      (hauler as Creep & { ticksToLive: number }).ticksToLive = 500;

      const role = powerBankHaulerRole(TARGET_ROOM);
      expect(role.target(hauler)).toBe(false);
      expect((task as any).blocker).toBe("hauler_delivery_capacity");

      Game.time += 25;
      expect(role.target(hauler)).toBe(false);
      expect((task as any).blocker).toBe("hauler_delivery_capacity_timeout");
    });

    it("任务已终止但仍携带 Power 时继续改投备用房", () => {
      setupTask("failed");
      Game.rooms[SOURCE_ROOM] = createDeliveryRoom(SOURCE_ROOM, { terminalFree: 0, storageFree: 0 });
      Game.rooms.W2N1 = createDeliveryRoom("W2N1", { storageFree: 5000 });
      const hauler = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 500 },
        carryCapacity: 1000,
      });
      (hauler as Creep & { ticksToLive: number }).ticksToLive = 500;

      const role = powerBankHaulerRole(TARGET_ROOM);
      expect(role.prepare!(hauler)).toBe(true);
      expect(role.source(hauler)).toBe(false);
      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler,
        "W2N1",
        undefined,
        expect.objectContaining({ travelRange: 3 }),
      );
      expect(hauler.suicide).not.toHaveBeenCalled();
    });
  });

  describe("no task", () => {

    it("retires instead of salvaging toward a non-patrol target room", () => {
      const outsideTarget = "W0N55";
      const hauler = createMockPowerBankCreep("powerBankHauler", {
        roomName: SOURCE_ROOM,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", configName: `${SOURCE_ROOM}:powerbank:${outsideTarget}:hauler:0` } as Partial<CreepMemory>,
      });

      const role = powerBankHaulerRole(outsideTarget);
      const result = role.source(hauler);

      expect(result).toBe(true);
      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(hauler.suicide).toHaveBeenCalled();
    });
  });

  describe("flee traffic awareness (Task 3)", () => {
    /**
     * Helper to register creeps in Game.creeps and set up room.find(FIND_MY_CREEPS)
     * so the tick context service / findMyCreepAt can discover them.
     */
    function registerCreepsInRoom(creeps: Creep[], roomName: string): void {
      for (const c of creeps) {
        Game.creeps[c.name] = c;
      }
      if (!Game.rooms[roomName]) {
        (Game.rooms as Record<string, Room>)[roomName] = creeps[0].room;
      }
      const room = Game.rooms[roomName];
      (room as any).find = jest.fn((constant: number) => {
        if (constant === FIND_MY_CREEPS) return creeps;
        if (constant === FIND_STRUCTURES) return [];
        if (constant === FIND_DROPPED_RESOURCES) return [];
        return [];
      });
    }

    it("side-steps when intended flee tile is occupied by another hauler", () => {
      setupTask("attacking");
      // Hauler at (26, 25), bank at (25, 25). Radial flee direction = RIGHT (x increases).
      // Intended flee tile: (27, 25). Block it with another hauler.
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 26, y: 25 });
      const blocker = createMockPowerBankCreep("powerBankHauler", {
        name: "hauler-blocker",
        roomName: TARGET_ROOM,
        x: 27,
        y: 25,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:1` } as Partial<CreepMemory>,
      });

      registerCreepsInRoom([hauler, blocker], TARGET_ROOM);

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.source(hauler);

      // Should have moved but NOT in the RIGHT direction (6) since (27,25) is blocked
      expect(hauler.move).toHaveBeenCalled();
      const moveDir = (hauler.move as jest.Mock).mock.calls[0][0] as DirectionConstant;
      expect(moveDir).not.toBe(RIGHT as DirectionConstant);
    });

    it("does not move when flee tile occupied and no safe side direction", () => {
      setupTask("attacking");
      // Hauler at (26, 25), bank at (25, 25). Flee direction = RIGHT → (27, 25).
      // Place haulers on (27,25), (27,24), (27,26) — the intended tile + two side tiles.
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 26, y: 25 });
      const blockerCenter = createMockPowerBankCreep("powerBankHauler", {
        name: "hauler-center",
        roomName: TARGET_ROOM,
        x: 27,
        y: 25,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:1` } as Partial<CreepMemory>,
      });
      const blockerTop = createMockPowerBankCreep("powerBankHauler", {
        name: "hauler-top",
        roomName: TARGET_ROOM,
        x: 27,
        y: 24,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:2` } as Partial<CreepMemory>,
      });
      const blockerBottom = createMockPowerBankCreep("powerBankHauler", {
        name: "hauler-bottom",
        roomName: TARGET_ROOM,
        x: 27,
        y: 26,
        carryCapacity: 1600,
        memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:3` } as Partial<CreepMemory>,
      });

      registerCreepsInRoom([hauler, blockerCenter, blockerTop, blockerBottom], TARGET_ROOM);

      const role = powerBankHaulerRole(TARGET_ROOM);
      role.source(hauler);

      expect(hauler.move).not.toHaveBeenCalled();
    });
  });
});
