jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => any) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
}));

import { powerBankHealerRole } from "@/roles/powerBankHealer";
import { createMockPowerBankCreep } from "@mock/powerBank";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const TARGET_ROOM = "E3N60";
const TASK_ID = "task-0";
const ATTACKER_ID = "attacker-0";

function setupTask(attackerId?: string): PowerBankHarvestTask {
  const task: PowerBankHarvestTask = {
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
    attackerId: attackerId ?? ATTACKER_ID,
    haulerIds: [],
    boostLabs: [],
    compoundTransferTaskIds: [],
  };
  if (!Memory.data) (Memory as any).data = {};
  if (!Memory.data.powerBankHarvest) Memory.data.powerBankHarvest = {};
  Memory.data.powerBankHarvest![TASK_ID] = task;
  return task;
}

function createAttacker(overrides: { x?: number; y?: number; roomName?: string; hits?: number; hitsMax?: number } = {}): Creep {
  const attacker = createMockPowerBankCreep("powerBankAttacker", {
    id: ATTACKER_ID,
    name: ATTACKER_ID,
    roomName: overrides.roomName ?? TARGET_ROOM,
    x: overrides.x ?? 25,
    y: overrides.y ?? 25,
    hits: overrides.hits,
    hitsMax: overrides.hitsMax,
    memory: { role: "powerBankAttacker", taskId: TASK_ID } as Partial<CreepMemory>,
  });
  return attacker;
}

describe("powerBankHealerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Memory as any).data = {};
    Game.creeps = {} as Record<string, Creep>;
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);
    (Game as any).map = {
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
    };
  });

  it("retires orphaned powerbank healers after terminal task cleanup removed taskId", () => {
    const attackerConfigName = "W1N1:powerbank:E3N60:attacker:0";
    const healerConfigName = "W1N1:powerbank:E3N60:healer:0";
    const attacker = createMockPowerBankCreep("powerBankAttacker", {
      id: ATTACKER_ID,
      name: ATTACKER_ID,
      roomName: TARGET_ROOM,
      x: 25,
      y: 25,
      hits: 500,
      hitsMax: 1000,
      memory: { role: "powerBankAttacker", configName: attackerConfigName } as Partial<CreepMemory>,
    });
    Game.creeps = { [ATTACKER_ID]: attacker };

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { role: "powerBankHealer", configName: healerConfigName } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.source?.(healer);

    expect(healer.suicide).toHaveBeenCalled();
    expect(healer.heal).not.toHaveBeenCalledWith(attacker);
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("formation - healer moves toward same-room attacker instead of target room when range > 1 (source phase)", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    const attacker = createAttacker({ roomName: "W1N1", x: 10, y: 10 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      x: 40,
      y: 40,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.source?.(healer);

    expect(moveToTarget).toHaveBeenCalledWith(
      healer,
      attacker,
      1,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("formation - healer moves toward same-room attacker during travelling target phase", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    const attacker = createAttacker({ roomName: "W1N1", x: 10, y: 10 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      x: 40,
      y: 40,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(moveToTarget).toHaveBeenCalledWith(
      healer,
      attacker,
      1,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("formation - adjacent healer sidesteps when blocking attacker's exit lane", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    const attacker = createAttacker({ roomName: "W1N1", x: 31, y: 30 });
    (attacker.room as Room & { findExitTo: jest.Mock }).findExitTo = jest.fn(() => FIND_EXIT_LEFT);
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      x: 30,
      y: 30,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.move).toHaveBeenCalledWith(TOP);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("source phase blocks movement when status is renewing (with resolvable task)", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "renewing";
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    const result = role.source?.(healer);

    expect(result).toBe(false);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  describe("boundary - exit-tile pre-travel regressions", () => {
    it("source phase blocks renewing creep on x=49 exit tile", () => {
      setupTask();
      Memory.data!.powerBankHarvest![TASK_ID].status = "renewing";
      const healer = createMockPowerBankCreep("powerBankHealer", {
        roomName: "W1N1",
        x: 49,
        y: 25,
        memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
      });

      const role = powerBankHealerRole(TARGET_ROOM);
      const result = role.source?.(healer);

      expect(result).toBe(false);
      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(moveToTarget).not.toHaveBeenCalled();
    });
  });
});
