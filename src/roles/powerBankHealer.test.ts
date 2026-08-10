jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => any) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
}));

import { powerBankHealerRole } from "@/roles/powerBankHealer";
import { clearCreepMovementStateForTest, getCreepMovementState } from "@/movement/creepState";
import { createMockPowerBankCreep, type MockCreepConfig } from "@mock/powerBank";

const { clearMovementState, moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  clearMovementState: jest.Mock;
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const TARGET_ROOM = "E3N60";
const TASK_ID = "task-0";
const ATTACKER_ID = "attacker-0";
const HEALER_ID = "healer-0";
const HEALER_BODY = [
  { type: HEAL as BodyPartConstant, hits: 100 },
  { type: MOVE as BodyPartConstant, hits: 100 },
];

type TaskOverrides = Partial<PowerBankHarvestTask> & {
  activeGeneration?: number;
  combatReady?: boolean;
  routeRooms?: string[];
  avoidRooms?: string[];
};

function setupTask(overrides: TaskOverrides = {}): PowerBankHarvestTask {
  const task = {
    id: TASK_ID,
    status: "attacking",
    sourceRoom: "W1N1",
    targetRoom: TARGET_ROOM,
    bankId: "pb-0",
    bankPos: { x: 25, y: 25 },
    hits: 2_000_000,
    power: 5000,
    ticksToDecay: 5000,
    freeTiles: 8,
    discoveredTick: 100,
    lastSeenTick: 100,
    attackerId: ATTACKER_ID,
    healerId: HEALER_ID,
    attackerReady: true,
    healerReady: true,
    haulerIds: [],
    boostLabs: [],
    compoundTransferTaskIds: [],
    ...overrides,
  } as PowerBankHarvestTask;
  if (!Memory.data) (Memory as any).data = {};
  if (!Memory.data.powerBankHarvest) Memory.data.powerBankHarvest = {};
  Memory.data.powerBankHarvest[TASK_ID] = task;
  return task;
}

function pairMemory(role: "powerBankAttacker" | "powerBankHealer", generation?: number): Partial<CreepMemory> {
  return {
    role,
    taskId: TASK_ID,
    ...(generation === undefined ? {} : { pairGeneration: generation }),
  } as Partial<CreepMemory>;
}

function setupPair(
  attackerOverrides: Partial<MockCreepConfig> = {},
  healerOverrides: Partial<MockCreepConfig> = {},
  generation?: number,
): { attacker: Creep; healer: Creep } {
  const attacker = createMockPowerBankCreep("powerBankAttacker", {
    id: ATTACKER_ID,
    name: ATTACKER_ID,
    roomName: TARGET_ROOM,
    x: 25,
    y: 25,
    ...attackerOverrides,
    memory: {
      ...pairMemory("powerBankAttacker", generation),
      ...(attackerOverrides.memory ?? {}),
    },
  });
  const healer = createMockPowerBankCreep("powerBankHealer", {
    id: HEALER_ID,
    name: HEALER_ID,
    roomName: attacker.room.name,
    x: attacker.pos.x - 1,
    y: attacker.pos.y,
    body: HEALER_BODY,
    ...healerOverrides,
    memory: {
      ...pairMemory("powerBankHealer", generation),
      ...(healerOverrides.memory ?? {}),
    },
  });
  Game.creeps = { [attacker.name]: attacker, [healer.name]: healer };
  (Game.getObjectById as jest.Mock) = jest.fn((id: string) =>
    Object.values(Game.creeps).find((creep) => creep.id === id) ?? null
  );
  return { attacker, healer };
}

describe("powerBankHealerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCreepMovementStateForTest();
    Game.time = 1000;
    (Memory as any).data = {};
    (Memory as any).runtime = {};
    Game.creeps = {} as Record<string, Creep>;
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);
    (Game as any).map = {
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
    };
  });

  it("retires an orphaned powerbank healer after task cleanup", () => {
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      body: HEALER_BODY,
      memory: {
        role: "powerBankHealer",
        taskId: TASK_ID,
        configName: "W1N1:powerbank:E3N60:healer:owner:task:g1",
      } as Partial<CreepMemory>,
    });

    powerBankHealerRole(TARGET_ROOM).source?.(healer);

    expect(healer.suicide).toHaveBeenCalled();
    expect(healer.heal).not.toHaveBeenCalled();
  });

  it("follows the same-room leader instead of routing independently", () => {
    setupTask({ status: "travelling" });
    const { attacker, healer } = setupPair(
      { roomName: "W1N1", x: 10, y: 10 },
      { roomName: "W1N1", x: 40, y: 40 },
    );

    powerBankHealerRole(TARGET_ROOM).source?.(healer);

    expect(moveToTarget).toHaveBeenCalledWith(
      healer,
      attacker,
      1,
      expect.objectContaining({ plainCost: 2, swampCost: 8, ignoreCreeps: false, reusePath: 0 }),
    );
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("requests occupied-aware pathing while regrouping with its same-room leader", () => {
    setupTask({ status: "travelling" });
    const { attacker, healer } = setupPair(
      { roomName: "W1N1", x: 13, y: 10 },
      { roomName: "W1N1", x: 10, y: 10 },
    );
    const blocker = createMockPowerBankCreep("worker", {
      id: "friendly-blocker",
      name: "friendly-blocker",
      roomName: "W1N1",
      x: 11,
      y: 10,
    });
    Game.creeps[blocker.name] = blocker;

    powerBankHealerRole(TARGET_ROOM).source?.(healer);

    expect(moveToTarget).toHaveBeenCalledWith(
      healer,
      attacker,
      1,
      expect.objectContaining({ ignoreCreeps: false, reusePath: 0 }),
    );
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("falls back to the traffic path when a single-width route has no unoccupied path", () => {
    setupTask({ status: "travelling" });
    const { attacker, healer } = setupPair(
      { roomName: "W1N1", x: 13, y: 10 },
      { roomName: "W1N1", x: 10, y: 10 },
    );
    moveToTarget.mockReturnValueOnce(ERR_NO_PATH).mockReturnValueOnce(OK);

    powerBankHealerRole(TARGET_ROOM).source?.(healer);

    expect(moveToTarget).toHaveBeenNthCalledWith(
      1,
      healer,
      attacker,
      1,
      expect.objectContaining({ ignoreCreeps: false, reusePath: 0 }),
    );
    expect(moveToTarget).toHaveBeenNthCalledWith(
      2,
      healer,
      attacker,
      1,
      expect.objectContaining({ ignoreCreeps: true, reusePath: 0 }),
    );
  });

  it("uses the shared task route and dangers to catch a leader in the next room", () => {
    setupTask({
      status: "travelling",
      routeRooms: ["W1N1", "W1N2", TARGET_ROOM],
      avoidRooms: ["W2N2"],
    });
    const { healer } = setupPair(
      { roomName: "W1N2", x: 1, y: 25 },
      { roomName: "W1N1", x: 49, y: 25 },
    );

    powerBankHealerRole(TARGET_ROOM, "stale|route").target(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      "W1N2",
      "W1N1|W1N2",
      expect.objectContaining({ avoidRooms: ["W2N2"] }),
    );
  });

  it("reverses the shared route when the follower crossed ahead of the leader", () => {
    setupTask({
      status: "travelling",
      routeRooms: ["W1N1", "W1N2", TARGET_ROOM],
    });
    const { healer } = setupPair(
      { roomName: "W1N1", x: 49, y: 25 },
      { roomName: "W1N2", x: 0, y: 25 },
    );

    powerBankHealerRole(TARGET_ROOM).target(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      "W1N1",
      "W1N2|W1N1",
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("waits beside the leader instead of travelling ahead", () => {
    setupTask({ status: "travelling" });
    const { attacker, healer } = setupPair(
      { roomName: "W1N1", x: 25, y: 25 },
      { roomName: "W1N1", x: 24, y: 25 },
    );

    powerBankHealerRole(TARGET_ROOM).target(healer);

    expect(healer.heal).toHaveBeenCalledWith(attacker);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(clearMovementState).toHaveBeenCalledWith(healer);
  });

  it("sidesteps when it blocks the leader's next shared-route exit", () => {
    setupTask({ status: "travelling", routeRooms: ["W1N1", "W0N1", TARGET_ROOM] });
    const { attacker, healer } = setupPair(
      { roomName: "W1N1", x: 31, y: 30 },
      { roomName: "W1N1", x: 30, y: 30 },
    );
    (attacker.room as Room & { findExitTo: jest.Mock }).findExitTo = jest.fn(() => FIND_EXIT_LEFT);

    powerBankHealerRole(TARGET_ROOM).target(healer);

    expect(healer.move).toHaveBeenCalledWith(TOP);
    expect(getCreepMovementState(healer)?.pathingRequestedAt).toBe(Game.time);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("heals and approaches the exact task-owned attacker during combat", () => {
    setupTask();
    const { attacker, healer } = setupPair(
      { x: 25, y: 25, hits: 3000, hitsMax: 4000 },
      { x: 28, y: 25 },
    );

    powerBankHealerRole(TARGET_ROOM).target(healer);

    expect(healer.rangedHeal).toHaveBeenCalledWith(attacker);
    expect(moveToTarget).toHaveBeenCalledWith(
      healer,
      attacker,
      1,
      expect.objectContaining({ maxRooms: 1, ignoreCreeps: false, reusePath: 0 }),
    );
  });

  it("does not support a same-task attacker whose member ID is not task-owned", () => {
    setupTask({ attackerId: "expected-attacker" });
    const { attacker, healer } = setupPair();

    powerBankHealerRole(TARGET_ROOM).target(healer);

    expect(healer.heal).not.toHaveBeenCalledWith(attacker);
    expect(healer.rangedHeal).not.toHaveBeenCalledWith(attacker);
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("does not bind a replacement with a mismatched generation", () => {
    setupTask({ activeGeneration: 7, combatReady: true });
    const { attacker, healer } = setupPair({}, { memory: pairMemory("powerBankHealer", 8) }, 7);

    powerBankHealerRole(TARGET_ROOM).target(healer);

    expect(healer.heal).not.toHaveBeenCalledWith(attacker);
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("does not issue healing intents after all HEAL parts are destroyed", () => {
    setupTask();
    const { attacker, healer } = setupPair({}, {
      body: [
        { type: HEAL as BodyPartConstant, hits: 0 },
        { type: MOVE as BodyPartConstant, hits: 100 },
      ],
    });

    powerBankHealerRole(TARGET_ROOM).target(healer);

    expect(healer.heal).not.toHaveBeenCalledWith(attacker);
    expect(healer.rangedHeal).not.toHaveBeenCalledWith(attacker);
  });

  it.each(["renewing", "boosting"] as const)("source phase preserves manager movement while %s", (status) => {
    setupTask({ status });
    const { healer } = setupPair({ roomName: "W1N1" }, { roomName: "W1N1", x: 49, y: 25 });

    const result = powerBankHealerRole(TARGET_ROOM).source?.(healer);

    expect(result).toBe(false);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(clearMovementState).not.toHaveBeenCalled();
  });
});
