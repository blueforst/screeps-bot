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

  it("attacks target power bank when adjacent", () => {
    setupTask();
    const bank = setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(creep.attack).toHaveBeenCalledWith(bank);
  });

  it("does not move or attack while a reinforcement is still boosting", () => {
    setupTask();
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: {
        taskId: TASK_ID,
        powerBankReinforcementStage: "boosting",
      } as Partial<CreepMemory> & { powerBankReinforcementStage: PowerBankReinforcementStage },
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(creep.attack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("travels to target room when not there", () => {
    setupTask();
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
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

  it("retires and hands off to hauling when bank disappears", () => {
    setupTask();
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);

    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(Memory.data!.powerBankHarvest![TASK_ID].status).toBe("hauling");
    expect(Memory.data!.powerBankHarvest![TASK_ID].failReason).toBeUndefined();
    expect(Memory.data!.powerBankHarvest![TASK_ID].terminalTick).toBeUndefined();
    expect(creep.suicide).toHaveBeenCalled();
  });

  it("retires while the task is already hauling", () => {
    setupTask({ status: "hauling" });
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.source?.(creep);

    expect(creep.suicide).toHaveBeenCalled();
    expect(creep.attack).not.toHaveBeenCalled();
  });

  it("retires orphaned powerbank attackers with no task", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      memory: {
        role: "powerBankAttacker",
        configName: "W1N1:powerbank:E3N60:attacker:0",
      } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.source?.(creep);

    expect(creep.suicide).toHaveBeenCalled();
    expect(creep.attack).not.toHaveBeenCalled();
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

  it("source phase travels to target room when not there", () => {
    setupTask();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalled();
  });

  it("source phase returns true when in target room", () => {
    setupTask();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    const result = role.source?.(creep);

    expect(result).toBe(true);
  });

  it("boosting creep cannot depart - target phase blocks when status is boosting", () => {
    setupTask({ status: "boosting" });
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(creep.attack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("boosting creep cannot depart - target phase blocks when status is preparing_boosts", () => {
    setupTask({ status: "preparing_boosts" });
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(creep.attack).not.toHaveBeenCalled();
  });

  it("boosting creep cannot depart - target phase blocks when status is spawning", () => {
    setupTask({ status: "spawning" });
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(creep.attack).not.toHaveBeenCalled();
  });

  it("boosting creep cannot depart - target phase blocks when status is renewing", () => {
    setupTask({ status: "renewing" });
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(creep.attack).not.toHaveBeenCalled();
  });

  it("boosting creep cannot depart - source phase blocks when status is preparing_boosts", () => {
    setupTask({ status: "preparing_boosts" });
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    const result = role.source?.(creep);

    expect(result).toBe(false);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("partner - missing healer blocks travel in target phase during travelling", () => {
    setupTask({ status: "travelling" });
    Game.creeps = {};

    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("partner - present healer allows travel in target phase during travelling", () => {
    setupTask({ status: "travelling" });
    const healer = createMockPowerBankCreep("powerBankHealer", {
      name: "healer-0",
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });
    Game.creeps = { "healer-0": healer };

    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(moveToTargetRoom).toHaveBeenCalled();
  });

  it("partner - missing healer blocks travel in source phase during travelling", () => {
    setupTask({ status: "travelling" });
    Game.creeps = {};

    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    const result = role.source?.(creep);

    expect(result).toBe(false);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("formation - attacker leads toward target room instead of chasing same-room healer (source phase)", () => {
    setupTask({ status: "travelling" });
    const healer = createMockPowerBankCreep("powerBankHealer", {
      name: "healer-0",
      roomName: "W1N1",
      x: 10,
      y: 10,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });
    Game.creeps = { "healer-0": healer };

    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      x: 40,
      y: 40,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      creep,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("formation - attacker leads toward target room instead of chasing same-room healer (target phase)", () => {
    setupTask({ status: "travelling" });
    const healer = createMockPowerBankCreep("powerBankHealer", {
      name: "healer-0",
      roomName: "W1N1",
      x: 10,
      y: 10,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });
    Game.creeps = { "healer-0": healer };

    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      x: 40,
      y: 40,
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
    expect(moveToTarget).not.toHaveBeenCalled();
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

  it("boundary - attacker vacates target-room exit while waiting for healer", () => {
    setupTask({ status: "travelling" });
    setupBank();
    const healer = createMockPowerBankCreep("powerBankHealer", {
      name: "healer-0",
      roomName: "W1N2",
      x: 15,
      y: 0,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });
    Game.creeps = { "healer-0": healer };

    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      x: 15,
      y: 49,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(creep.move).toHaveBeenCalledWith(TOP);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(creep.attack).not.toHaveBeenCalled();
  });

  it("boundary - attacker delegates exit-tile travel to shared moveToTargetRoom", () => {
    setupTask({ status: "travelling" });
    const healer = createMockPowerBankCreep("powerBankHealer", {
      name: "healer-0",
      roomName: "W1N1",
      x: 48,
      y: 25,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });
    Game.creeps = { "healer-0": healer };

    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      x: 49,
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
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("boundary - attacker keeps leading toward target when healer is in previous room (source phase)", () => {
    setupTask({ status: "travelling" });
    const healer = createMockPowerBankCreep("powerBankHealer", {
      name: "healer-0",
      roomName: "W0N1",
      x: 24,
      y: 24,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });
    Game.creeps = { "healer-0": healer };

    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      x: 25,
      y: 25,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    const result = role.source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      creep,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
    expect(result).toBe(false);
  });

  it("source phase blocks movement when status is spawning (with resolvable task)", () => {
    setupTask({ status: "spawning" });
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

  it("source phase blocks movement when status is boosting (with resolvable task)", () => {
    setupTask({ status: "boosting" });
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

  it("target phase blocks movement when status is spawning and not in target room", () => {
    setupTask({ status: "spawning" });
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(creep.attack).not.toHaveBeenCalled();
  });

  it("target phase blocks movement when status is renewing and not in target room", () => {
    setupTask({ status: "renewing" });
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(creep.attack).not.toHaveBeenCalled();
  });

  it("target phase blocks movement when status is boosting and not in target room", () => {
    setupTask({ status: "boosting" });
    setupBank();
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(creep.attack).not.toHaveBeenCalled();
  });

  it("orphan - no taskId must not remote-travel toward constructor targetRoom (source phase)", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.source?.(creep);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("orphan - no taskId must not remote-travel toward constructor targetRoom (target phase)", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("orphan - taskId pointing to missing task must not remote-travel (source phase)", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: "nonexistent-task" } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.source?.(creep);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("orphan - taskId pointing to missing task must not remote-travel (target phase)", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: "W1N1",
      memory: { taskId: "nonexistent-task" } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  describe("boundary - exit-tile pre-travel regressions", () => {
    it("source phase blocks renewing creep on x=0 exit tile", () => {
      setupTask({ status: "renewing" });
      const creep = createMockPowerBankCreep("powerBankAttacker", {
        roomName: "W1N1",
        x: 0,
        y: 25,
        memory: { taskId: TASK_ID } as Partial<CreepMemory>,
      });

      const role = powerBankAttackerRole(TARGET_ROOM);
      const result = role.source?.(creep);

      expect(result).toBe(false);
      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(moveToTarget).not.toHaveBeenCalled();
    });

    it("source phase blocks boosting creep on x=49 exit tile", () => {
      setupTask({ status: "boosting" });
      const creep = createMockPowerBankCreep("powerBankAttacker", {
        roomName: "W1N1",
        x: 49,
        y: 25,
        memory: { taskId: TASK_ID } as Partial<CreepMemory>,
      });

      const role = powerBankAttackerRole(TARGET_ROOM);
      const result = role.source?.(creep);

      expect(result).toBe(false);
      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(moveToTarget).not.toHaveBeenCalled();
    });

    it("target phase blocks renewing creep on x=0 exit tile", () => {
      setupTask({ status: "renewing" });
      setupBank();
      const creep = createMockPowerBankCreep("powerBankAttacker", {
        roomName: "W1N1",
        x: 0,
        y: 25,
        memory: { taskId: TASK_ID } as Partial<CreepMemory>,
      });

      const role = powerBankAttackerRole(TARGET_ROOM);
      role.target(creep);

      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(moveToTarget).not.toHaveBeenCalled();
      expect(creep.attack).not.toHaveBeenCalled();
    });

    it("target phase blocks boosting creep on x=49 exit tile", () => {
      setupTask({ status: "boosting" });
      setupBank();
      const creep = createMockPowerBankCreep("powerBankAttacker", {
        roomName: "W1N1",
        x: 49,
        y: 25,
        memory: { taskId: TASK_ID } as Partial<CreepMemory>,
      });

      const role = powerBankAttackerRole(TARGET_ROOM);
      role.target(creep);

      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(moveToTarget).not.toHaveBeenCalled();
      expect(creep.attack).not.toHaveBeenCalled();
    });
  });

  it("formation does NOT apply during attacking status", () => {
    setupTask({ status: "attacking" });
    setupBank();
    const healer = createMockPowerBankCreep("powerBankHealer", {
      name: "healer-0",
      roomName: TARGET_ROOM,
      x: 10,
      y: 10,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });
    Game.creeps = { "healer-0": healer };

    const creep = createMockPowerBankCreep("powerBankAttacker", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankAttackerRole(TARGET_ROOM);
    role.target(creep);

    // During attacking, attacker fights independently — no formation check
    expect(creep.attack).toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });
});
