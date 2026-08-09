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
} from "@mock/powerBank";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const TARGET_ROOM = "E3N60";
const TASK_ID = "task-0";
const BANK_ID = "powerbank-0";

function setupTask(overrides: Partial<PowerBankHarvestTask> = {}): PowerBankHarvestTask {
  const task: PowerBankHarvestTask = {
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

function setupBank() {
  const bank = createMockPowerBank({ id: BANK_ID, roomName: TARGET_ROOM });
  (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
    if (id === BANK_ID) return bank;
    return null;
  });
  return bank;
}

describe("powerBankAttackerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Game.time = 1000;
    (Memory as any).data = {};
  });

  it("does NOT attack hostile structures or creeps", () => {
    setupTask();
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    const attackCalls = (creep.attack as jest.Mock).mock.calls;
    for (const call of attackCalls) {
      const target = call[0];
      if (target && target.structureType) {
        expect(target.structureType).toBe(STRUCTURE_POWER_BANK);
      }
    }
  });

  it("stops attacking when TOUGH layer is broken", () => {
    setupTask();
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const toughIndex = creep.body.findIndex((p: any) => p.type === TOUGH);
    setBodyPartHits(creep, toughIndex, 0);

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(creep.attack).not.toHaveBeenCalled();
    expect(creep.move).not.toHaveBeenCalled();
  });

  it("does not abort when TOUGH broken so healer can recover it", () => {
    setupTask();
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const toughIndex = creep.body.findIndex((p: any) => p.type === TOUGH);
    setBodyPartHits(creep, toughIndex, 0);

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(Memory.data!.powerBankHarvest![TASK_ID].status).toBe("attacking");
    expect(Memory.data!.powerBankHarvest![TASK_ID].failReason).toBeUndefined();
    expect(Memory.data!.powerBankHarvest![TASK_ID].terminalTick).toBeUndefined();
  });

  it("moves to bank when not in range", () => {
    setupTask();
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      x: 10,
      y: 10,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });
    (creep.attack as jest.Mock).mockReturnValue(ERR_NOT_IN_RANGE);

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(moveToTarget).toHaveBeenCalledWith(
      creep,
      expect.anything(),
      1,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("boundary - attacker keeps leading toward target when healer is in previous room (target phase)", () => {
    setupTask({ status: "travelling" });
    const healer = createMockPowerBankCreep("powerBankHealer", {
      name: "healer-0",
      roomName: "W1N1",
      x: 24,
      y: 24,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });
    Game.creeps = { "healer-0": healer };

    // Attacker has crossed into a route room, healer is still in the previous room.
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N2",
      x: 25,
      y: 25,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      creep,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
    expect(creep.attack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("source phase blocks movement when status is renewing (with resolvable task)", () => {
    setupTask({ status: "renewing" });
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    const result = role.source?.(creep);

    expect(result).toBe(false);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });
});
