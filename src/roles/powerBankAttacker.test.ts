jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => any) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
}));

import { powerBankAttackerRole } from "@/roles/powerBankAttacker";
import {
  createMockPowerBankCreep,
  createMockPowerBank,
  setBodyPartHits,
  type MockCreepConfig,
} from "@mock/powerBank";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const TARGET_ROOM = "E3N60";
const TASK_ID = "task-0";
const BANK_ID = "powerbank-0";
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
    bankId: BANK_ID,
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
    x: 24,
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
  return { attacker, healer };
}

function setupBank() {
  const bank = createMockPowerBank({ id: BANK_ID, roomName: TARGET_ROOM });
  (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
    if (id === BANK_ID) return bank;
    return Object.values(Game.creeps).find((creep) => creep.id === id) ?? null;
  });
  return bank;
}

describe("powerBankAttackerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Game.time = 1000;
    Game.creeps = {} as Record<string, Creep>;
    (Memory as any).data = {};
    (Memory as any).runtime = {};
  });

  it("attacks only the task-owned bank when the pair is combat ready", () => {
    setupTask();
    const bank = setupBank();
    const { attacker } = setupPair();

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledTimes(1);
    expect(attacker.attack).toHaveBeenCalledWith(bank);
  });

  it("stops attacking while every TOUGH part is broken without changing task state", () => {
    const task = setupTask();
    setupBank();
    const { attacker } = setupPair();
    for (let index = 0; index < attacker.body.length; index += 1) {
      if (attacker.body[index].type === TOUGH) setBodyPartHits(attacker, index, 0);
    }

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(task.status).toBe("attacking");
    expect(task.failReason).toBeUndefined();
  });

  it("stops attacking when no ATTACK part remains active", () => {
    setupTask();
    setupBank();
    const { attacker } = setupPair();
    for (let index = 0; index < attacker.body.length; index += 1) {
      if (attacker.body[index].type === ATTACK) setBodyPartHits(attacker, index, 0);
    }

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it.each([
    ["healer missing", undefined],
    ["healer in another room", { roomName: "E2N60" }],
    ["healer not adjacent", { x: 10, y: 10 }],
    ["healer has no active HEAL", { body: [{ type: HEAL as BodyPartConstant, hits: 0 }, { type: MOVE as BodyPartConstant, hits: 100 }] }],
  ])("does not attack when %s", (_label, healerOverrides) => {
    setupTask();
    setupBank();
    const { attacker, healer } = setupPair({}, healerOverrides ?? {});
    if (healerOverrides === undefined) Game.creeps = { [attacker.name]: attacker };

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).not.toHaveBeenCalled();
    expect(healer.suicide).not.toHaveBeenCalled();
  });

  it("rejects a newly spawned member whose generation does not match the active pair", () => {
    setupTask({ activeGeneration: 4, combatReady: true });
    setupBank();
    const { attacker } = setupPair({ memory: pairMemory("powerBankAttacker", 5) }, {}, 4);

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("requires manager combatReady for generation-owned pairs", () => {
    setupTask({ activeGeneration: 4, combatReady: false });
    setupBank();
    const { attacker } = setupPair({}, {}, 4);

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("attacks with a generation-owned primary pair after manager readiness", () => {
    setupTask({ activeGeneration: 4, combatReady: true });
    const bank = setupBank();
    const { attacker } = setupPair({}, {}, 4);

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(bank);
  });

  it("resolves a ready reinforcement by its own generation and member IDs", () => {
    setupTask({
      activeGeneration: 4,
      combatReady: true,
      attackerId: "primary-attacker",
      healerId: "primary-healer",
      reinforcement: {
        index: 1,
        generation: 5,
        stage: "attacking",
        attackerId: ATTACKER_ID,
        healerId: HEALER_ID,
        combatReady: true,
      },
    });
    const bank = setupBank();
    const { attacker } = setupPair({}, {}, 5);

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(bank);
  });

  it("does not bind a same-task healer whose member ID is not task-owned", () => {
    setupTask({ healerId: "expected-healer" });
    setupBank();
    const { attacker } = setupPair();

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("moves to the bank only after the full pair gate passes", () => {
    setupTask();
    setupBank();
    const { attacker } = setupPair({ x: 10, y: 10 }, { x: 11, y: 10 });
    (attacker.attack as jest.Mock).mockReturnValue(ERR_NOT_IN_RANGE);

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(moveToTarget).toHaveBeenCalledWith(
      attacker,
      expect.anything(),
      1,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("waits after crossing a room boundary until the healer catches up", () => {
    setupTask({ status: "travelling", attackerReady: true, healerReady: true });
    const { attacker } = setupPair(
      { roomName: "W1N2", x: 0, y: 25 },
      { roomName: "W1N1", x: 49, y: 25 },
    );

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("waits on an ordinary tile when the healer is not adjacent", () => {
    setupTask({ status: "travelling", attackerReady: true, healerReady: true });
    const { attacker } = setupPair(
      { roomName: "W1N1", x: 25, y: 25 },
      { roomName: "W1N1", x: 20, y: 20 },
    );

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.move).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("uses the task route and danger snapshot when the adjacent pair advances", () => {
    setupTask({
      status: "travelling",
      routeRooms: ["W1N1", "W1N2", TARGET_ROOM],
      avoidRooms: ["W2N2"],
    });
    const { attacker } = setupPair(
      { roomName: "W1N1", x: 25, y: 25 },
      { roomName: "W1N1", x: 24, y: 25 },
    );

    powerBankAttackerRole(TARGET_ROOM, "stale|route").target(attacker);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      attacker,
      TARGET_ROOM,
      `W1N1|W1N2|${TARGET_ROOM}`,
      expect.objectContaining({ avoidRooms: ["W2N2"] }),
    );
  });

  it("observes a missing bank without changing status or suiciding", () => {
    const task = setupTask();
    const { attacker } = setupPair();
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) =>
      Object.values(Game.creeps).find((creep) => creep.id === id) ?? null
    );

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(task.status).toBe("attacking");
    expect(attacker.suicide).not.toHaveBeenCalled();
    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("source phase blocks movement while the manager is renewing", () => {
    setupTask({ status: "renewing" });
    const { attacker } = setupPair({ roomName: "W1N1" }, { roomName: "W1N1" });

    const result = powerBankAttackerRole(TARGET_ROOM).source?.(attacker);

    expect(result).toBe(false);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });
});
