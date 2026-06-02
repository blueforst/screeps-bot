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

  it("heals paired attacker at range 1 with heal()", () => {
    setupTask();
    const attacker = createAttacker({ hits: 500, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.heal).toHaveBeenCalledWith(attacker);
  });

  it("does not move or heal while a reinforcement is still boosting", () => {
    setupTask();
    const attacker = createAttacker({ hits: 500, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: {
        role: "powerBankHealer",
        taskId: TASK_ID,
        powerBankReinforcementStage: "boosting",
      } as Partial<CreepMemory> & { powerBankReinforcementStage: PowerBankReinforcementStage },
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.heal).not.toHaveBeenCalled();
    expect(healer.rangedHeal).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("issues heal intent every tick when adjacent attacker is full", () => {
    setupTask();
    const attacker = createAttacker({ hits: 1000, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.heal).toHaveBeenCalledWith(attacker);
  });

  it("issues rangedHeal intent every tick when ranged attacker is full", () => {
    setupTask();
    const attacker = createAttacker({ x: 27, y: 25, hits: 1000, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.rangedHeal).toHaveBeenCalledWith(attacker);
    expect(moveToTarget).toHaveBeenCalled();
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

  it("uses rangedHeal() when at range 2-3", () => {
    setupTask();
    const attacker = createAttacker({ x: 27, y: 25, hits: 500, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.rangedHeal).toHaveBeenCalledWith(attacker);
    expect(moveToTarget).toHaveBeenCalled();
  });

  it("prioritizes paired attacker over unrelated damaged creep", () => {
    setupTask();
    const attacker = createAttacker({ hits: 500, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.heal).toHaveBeenCalledWith(attacker);
  });

  it("retires once the task enters hauling", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "hauling";
    const attacker = createAttacker({ hits: 1000, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.suicide).toHaveBeenCalled();
    expect(healer.heal).not.toHaveBeenCalled();
  });

  it("moves toward attacker when out of heal range", () => {
    setupTask();
    const attacker = createAttacker({ x: 40, y: 40, hits: 500, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 5,
      y: 5,
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

  it("prioritizes every-tick adjacent attacker heal intent over self-heal", () => {
    setupTask();
    const attacker = createAttacker({ hits: 1000, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 25,
      hits: 500,
      hitsMax: 1000,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.heal).toHaveBeenCalledWith(attacker);
    expect(healer.heal).not.toHaveBeenCalledWith(healer);
  });

  it("travels to attacker room when in different room", () => {
    setupTask();
    const attacker = createAttacker({ roomName: TARGET_ROOM });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("self-heals when no attacker found and healer is damaged", () => {
    setupTask();
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      hits: 500,
      hitsMax: 1000,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.heal).toHaveBeenCalledWith(healer);
  });

  it("stays near attacker when attacker is not damaged", () => {
    setupTask();
    const attacker = createAttacker({ hits: 1000, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 10,
      y: 10,
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

  it("source phase travels to target room when not there", () => {
    setupTask();
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.source?.(healer);

    expect(moveToTargetRoom).toHaveBeenCalled();
  });

  it("source phase returns true when in target room", () => {
    setupTask();
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    const result = role.source?.(healer);

    expect(result).toBe(true);
  });

  it("boosting creep cannot depart - target phase blocks when status is boosting", () => {
    setupTask();
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });
    Memory.data!.powerBankHarvest![TASK_ID].status = "boosting";

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.heal).not.toHaveBeenCalled();
    expect(healer.rangedHeal).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("boosting creep cannot depart - target phase blocks when status is preparing_boosts", () => {
    setupTask();
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });
    Memory.data!.powerBankHarvest![TASK_ID].status = "preparing_boosts";

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.heal).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("boosting creep cannot depart - source phase blocks when status is preparing_boosts", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "preparing_boosts";
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    const result = role.source?.(healer);

    expect(result).toBe(false);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("partner - missing attacker blocks travel in target phase during travelling", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("partner - present attacker allows travel in target phase during travelling", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    const attacker = createAttacker({ roomName: TARGET_ROOM });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(moveToTargetRoom).toHaveBeenCalled();
  });

  it("partner - missing attacker blocks travel in source phase during travelling", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);
    Game.creeps = {};

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    const result = role.source?.(healer);

    expect(result).toBe(false);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
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

  it("formation - healer heals adjacent damaged attacker during travelling source phase", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    const attacker = createAttacker({ roomName: "W1N1", x: 24, y: 25, hits: 500, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      x: 24,
      y: 24,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.source?.(healer);

    expect(healer.heal).toHaveBeenCalledWith(attacker);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
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

  it("formation - adjacent healer stays put when not in attacker's exit lane", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    const attacker = createAttacker({ roomName: "W1N1", x: 30, y: 30 });
    (attacker.room as Room & { findExitTo: jest.Mock }).findExitTo = jest.fn(() => FIND_EXIT_LEFT);
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      x: 31,
      y: 30,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.move).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("boundary - healer rejoins attacker in different room during travelling (source phase)", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    const attacker = createAttacker({ roomName: "W0N1" });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    const result = role.source?.(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      "W0N1",
      "",
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
    expect(result).toBe(false);
  });

  it("boundary - healer follows attacker into target room during travelling", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    const attacker = createAttacker({ roomName: TARGET_ROOM });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it("boundary - healer delegates exit-tile travel to shared moveToTargetRoom", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    const attacker = createAttacker({ roomName: "W1N1", x: 48, y: 25 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      x: 49,
      y: 25,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.source?.(healer);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      healer,
      TARGET_ROOM,
      undefined,
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("boundary - healer vacates target-room exit when it crossed before attacker", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "travelling";
    const attacker = createAttacker({ roomName: "W1N1", x: 15, y: 0 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 15,
      y: 49,
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(healer.move).toHaveBeenCalledWith(TOP);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("source phase blocks movement when status is spawning (with resolvable task)", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "spawning";
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

  it("source phase blocks movement when status is boosting (with resolvable task)", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "boosting";
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

  it("target phase blocks movement when status is spawning and not in target room", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "spawning";
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(healer.heal).not.toHaveBeenCalled();
    expect(healer.rangedHeal).not.toHaveBeenCalled();
  });

  it("target phase blocks movement when status is renewing and not in target room", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "renewing";
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(healer.heal).not.toHaveBeenCalled();
    expect(healer.rangedHeal).not.toHaveBeenCalled();
  });

  it("target phase blocks movement when status is boosting and not in target room", () => {
    setupTask();
    Memory.data!.powerBankHarvest![TASK_ID].status = "boosting";
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(healer.heal).not.toHaveBeenCalled();
    expect(healer.rangedHeal).not.toHaveBeenCalled();
  });

  it("orphan - no taskId must not remote-travel toward constructor targetRoom (source phase)", () => {
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.source?.(healer);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("orphan - no taskId must not remote-travel toward constructor targetRoom (target phase)", () => {
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("orphan - taskId pointing to missing task must not remote-travel (source phase)", () => {
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: "nonexistent-task" } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.source?.(healer);

    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("orphan - taskId pointing to missing task must not remote-travel (target phase)", () => {
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: "W1N1",
      memory: { role: "powerBankHealer", taskId: "nonexistent-task" } as Partial<CreepMemory>,
    });

    const role = powerBankHealerRole(TARGET_ROOM);
    role.target(healer);

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

    it("source phase blocks boosting creep on x=0 exit tile", () => {
      setupTask();
      Memory.data!.powerBankHarvest![TASK_ID].status = "boosting";
      const healer = createMockPowerBankCreep("powerBankHealer", {
        roomName: "W1N1",
        x: 0,
        y: 25,
        memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
      });

      const role = powerBankHealerRole(TARGET_ROOM);
      const result = role.source?.(healer);

      expect(result).toBe(false);
      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(moveToTarget).not.toHaveBeenCalled();
    });

    it("target phase blocks renewing creep on x=49 exit tile", () => {
      setupTask();
      Memory.data!.powerBankHarvest![TASK_ID].status = "renewing";
      const healer = createMockPowerBankCreep("powerBankHealer", {
        roomName: "W1N1",
        x: 49,
        y: 25,
        memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
      });

      const role = powerBankHealerRole(TARGET_ROOM);
      role.target(healer);

      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(moveToTarget).not.toHaveBeenCalled();
      expect(healer.heal).not.toHaveBeenCalled();
      expect(healer.rangedHeal).not.toHaveBeenCalled();
    });

    it("target phase blocks boosting creep on x=0 exit tile", () => {
      setupTask();
      Memory.data!.powerBankHarvest![TASK_ID].status = "boosting";
      const healer = createMockPowerBankCreep("powerBankHealer", {
        roomName: "W1N1",
        x: 0,
        y: 25,
        memory: { role: "powerBankHealer", taskId: TASK_ID } as Partial<CreepMemory>,
      });

      const role = powerBankHealerRole(TARGET_ROOM);
      role.target(healer);

      expect(moveToTargetRoom).not.toHaveBeenCalled();
      expect(moveToTarget).not.toHaveBeenCalled();
      expect(healer.heal).not.toHaveBeenCalled();
      expect(healer.rangedHeal).not.toHaveBeenCalled();
    });
  });

  it("formation does NOT override healing behavior during attacking status", () => {
    setupTask();
    const attacker = createAttacker({ roomName: TARGET_ROOM, x: 10, y: 10, hits: 500, hitsMax: 1000 });
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === ATTACKER_ID) return attacker;
      return null;
    });

    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      x: 5,
      y: 5,
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
});
