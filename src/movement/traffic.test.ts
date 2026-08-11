import { clearCreepMovementStateForTest, ensureCreepMovementState } from "@/movement/creepState";
import { isBlockerActivelyMoving, moveToAdjacentPosition } from "@/movement/traffic";

jest.mock("@/runtime/runtimeServices", () => ({
  getTickContextService: jest.fn(),
}));

import { getTickContextService } from "@/runtime/runtimeServices";

function setupRoomContext(creeps: Creep[] = []) {
  (getTickContextService as jest.Mock).mockReturnValue({
    getRoomContext: jest.fn(() => ({
      getMyCreeps: jest.fn(() => creeps),
      getStructures: jest.fn(() => []),
      getConstructionSites: jest.fn(() => []),
    })),
  });
}

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: (fn: () => any) => fn(),
}));

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: RoomPosition | { pos: RoomPosition }): number {
    const pos = "pos" in target ? target.pos : target;
    return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
  }

  public getDirectionTo(target: RoomPosition): DirectionConstant {
    const dx = Math.sign(target.x - this.x);
    const dy = Math.sign(target.y - this.y);
    if (dx === 0 && dy === -1) return TOP;
    if (dx === 1 && dy === -1) return TOP_RIGHT;
    if (dx === 1 && dy === 0) return RIGHT;
    if (dx === 1 && dy === 1) return BOTTOM_RIGHT;
    if (dx === 0 && dy === 1) return BOTTOM;
    if (dx === -1 && dy === 1) return BOTTOM_LEFT;
    if (dx === -1 && dy === 0) return LEFT;
    return TOP_LEFT;
  }
}

function makeCreep(name: string, x: number, y: number, roomName = "W1N1") {
  const pos = new MockRoomPosition(x, y, roomName) as unknown as RoomPosition;
  return {
    name,
    pos,
    room: { name: roomName } as Room,
    move: jest.fn(() => OK),
    memory: {},
  } as unknown as Creep;
}

function makePowerCreep(name: string, x: number, y: number, roomName = "W1N1") {
  const pos = new MockRoomPosition(x, y, roomName) as unknown as RoomPosition;
  return {
    name,
    pos,
    room: { name: roomName } as Room,
    ticksToLive: 1_000,
    powers: {},
    move: jest.fn(() => OK),
    memory: {},
  } as unknown as PowerCreep;
}

function planHeadOnStep(creep: Creep, target: RoomPosition): void {
  ensureCreepMovementState(creep).movePathState = {
    key: "head-on",
    path: "",
    steps: [
      { x: creep.pos.x, y: creep.pos.y },
      { x: target.x, y: target.y },
    ],
    targetRoom: target.roomName,
    targetX: target.x,
    targetY: target.y,
    range: 0,
    stuckTicks: 0,
    expiresAt: Game.time + 1,
  };
}

describe("moveToAdjacentPosition", () => {
  beforeEach(() => {
    clearCreepMovementStateForTest();
    Game.powerCreeps = {};
    Object.assign(global, { RoomPosition: MockRoomPosition });
    Object.assign(Game, {
      map: {
        getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
      },
    });
  });

  it("lets a normal creep push a waiting Power Creep while preserving its work-anchor range", () => {
    const pusher = makeCreep("pusher", 10, 10);
    const powerCreep = makePowerCreep("operator", 11, 10);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;
    setupRoomContext([pusher]);
    Game.powerCreeps = { operator: powerCreep };

    const state = ensureCreepMovementState(powerCreep);
    state.workAnchor = { x: 13, y: 10, roomName: "W1N1", range: 3 };

    const result = moveToAdjacentPosition(pusher, nextPos);

    expect(result).toBe(OK);
    expect(powerCreep.move).toHaveBeenCalledWith(LEFT);
    expect(pusher.move).toHaveBeenCalledWith(RIGHT);
    expect(state.movementPushedAt).toBe(Game.time);
    expect(state.workAnchor).toEqual({ x: 13, y: 10, roomName: "W1N1", range: 3 });
  });

  it("lets a moving Power Creep push a stationary normal creep through the same traffic protocol", () => {
    const powerCreep = makePowerCreep("operator", 10, 10);
    const blocker = makeCreep("blocker", 11, 10);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;
    setupRoomContext([blocker]);
    Game.powerCreeps = { operator: powerCreep };

    const result = moveToAdjacentPosition(powerCreep, nextPos);

    expect(result).toBe(OK);
    expect(blocker.move).toHaveBeenCalledWith(LEFT);
    expect(powerCreep.move).toHaveBeenCalledWith(RIGHT);
    expect(ensureCreepMovementState(blocker.name).movementPushedAt).toBe(Game.time);
  });

  it("does not push a Power Creep that already requested pathing this tick", () => {
    const pusher = makeCreep("pusher", 10, 10);
    const powerCreep = makePowerCreep("operator", 11, 10);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;
    setupRoomContext([pusher]);
    Game.powerCreeps = { operator: powerCreep };
    ensureCreepMovementState(powerCreep).pathingRequestedAt = Game.time;

    const result = moveToAdjacentPosition(pusher, nextPos);

    expect(result).toBe(OK);
    expect(powerCreep.move).not.toHaveBeenCalled();
    expect(pusher.move).toHaveBeenCalledWith(RIGHT);
  });

  it("returns ERR_BUSY when stationary blocker returns ERR_TIRED on push attempt", () => {
    const pusher = makeCreep("pusher", 10, 10);
    const blocker = makeCreep("blocker", 11, 10);
    (blocker.move as jest.Mock).mockReturnValue(ERR_TIRED);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;

    setupRoomContext([pusher, blocker]);

    const result = moveToAdjacentPosition(pusher, nextPos);

    expect(result).toBe(ERR_BUSY);
    expect(blocker.move).toHaveBeenCalled();
  });

  it("coordinates a head-on War swap only for reciprocal exact partners", () => {
    const attacker = makeCreep("attacker", 10, 10);
    const healer = makeCreep("healer", 11, 10);
    const attackerConfig = "W1N1:war:W2N2:meleeAttacker:0";
    const healerConfig = "W1N1:war:W2N2:healer:0";
    Object.assign(attacker.memory, {
      role: "meleeAttacker",
      configName: attackerConfig,
      _warPartnerConfigName: healerConfig,
    });
    Object.assign(healer.memory, {
      role: "healer",
      configName: healerConfig,
      _warPartnerConfigName: attackerConfig,
    });
    planHeadOnStep(healer, attacker.pos);
    setupRoomContext([attacker, healer]);

    const result = moveToAdjacentPosition(attacker, healer.pos);

    expect(result).toBe(OK);
    expect(healer.move).toHaveBeenCalledWith(LEFT);
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
  });

  it("does not infer a head-on partner for the unpaired standard attacker", () => {
    const attacker = makeCreep("attacker-1", 10, 10);
    const healer = makeCreep("healer-1", 11, 10);
    Object.assign(attacker.memory, {
      role: "meleeAttacker",
      configName: "W1N1:war:W2N2:meleeAttacker:1",
    });
    Object.assign(healer.memory, {
      role: "healer",
      configName: "W1N1:war:W2N2:healer:1",
    });
    planHeadOnStep(healer, attacker.pos);
    setupRoomContext([attacker, healer]);

    const result = moveToAdjacentPosition(attacker, healer.pos);

    expect(result).toBe(OK);
    expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
  });

  it("fails closed when only one War member points at the other", () => {
    const attacker = makeCreep("attacker-drift", 10, 10);
    const healer = makeCreep("healer-drift", 11, 10);
    const attackerConfig = "W1N1:war:W2N2:meleeAttacker:0";
    const healerConfig = "W1N1:war:W2N2:healer:0";
    Object.assign(attacker.memory, {
      role: "meleeAttacker",
      configName: attackerConfig,
      _warPartnerConfigName: healerConfig,
    });
    Object.assign(healer.memory, {
      role: "healer",
      configName: healerConfig,
      _warPartnerConfigName: "W1N1:war:W2N2:meleeAttacker:other",
    });
    planHeadOnStep(healer, attacker.pos);
    setupRoomContext([attacker, healer]);

    const result = moveToAdjacentPosition(attacker, healer.pos);

    expect(result).toBe(OK);
    expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
  });
});
