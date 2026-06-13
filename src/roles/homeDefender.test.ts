import { homeDefenderRole } from "@/roles/homeDefender";
import { getAssignedDefenseFront, getDefenderRole, getTowerFocusFront } from "@/runtime/defenseCoordination";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { createSafeZoneCostCallback, getBoundaryRamparts } from "@/runtime/safeZoneHelpers";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: jest.fn((fn: () => unknown) => fn()),
  measureCreepIntent: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock("@/runtime/defenseCoordination", () => ({
  getAssignedDefenseFront: jest.fn(),
  getDefenderRole: jest.fn(),
  getTowerFocusFront: jest.fn(),
}));

jest.mock("@/runtime/defenseMode", () => ({
  getPlayerHostiles: jest.fn(),
}));

jest.mock("@/runtime/safeZoneHelpers", () => ({
  createSafeZoneCostCallback: jest.fn(() => jest.fn()),
  getBoundaryRamparts: jest.fn(),
}));

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

class MockPos {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): number {
    const targetPos = "pos" in target && target.pos ? target.pos : target;
    return Math.max(Math.abs(this.x - (targetPos.x ?? 0)), Math.abs(this.y - (targetPos.y ?? 0)));
  }

  public isEqualTo(target: { x: number; y: number; roomName?: string }): boolean {
    return this.x === target.x && this.y === target.y && (!target.roomName || this.roomName === target.roomName);
  }

  public lookFor(): unknown[] {
    return [];
  }
}

function createHostile(id: string, x: number, y: number, hits = 100): Creep {
  return {
    id: id as Id<Creep>,
    hits,
    pos: new MockPos(x, y, "W1N1") as unknown as RoomPosition,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 1 : 0)),
  } as unknown as Creep;
}

function createRampart(x: number, y: number): StructureRampart {
  return {
    id: `rampart-${x}-${y}` as Id<StructureRampart>,
    my: true,
    structureType: STRUCTURE_RAMPART,
    pos: new MockPos(x, y, "W1N1") as unknown as RoomPosition,
  } as StructureRampart;
}

function createRoom(myCreeps: Creep[]): Room {
  return {
    name: "W1N1",
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_MY_CREEPS) return myCreeps;
      return [];
    }),
  } as unknown as Room;
}

describe("homeDefenderRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSafeZone as jest.Mock).mockReturnValue(new Set([10 * 50 + 10]));
    (createSafeZoneCostCallback as jest.Mock).mockReturnValue(jest.fn());
    (getDefenderRole as jest.Mock).mockReturnValue("primary");
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
  });

  it("attacks an adjacent hostile when the assigned boundary target retreats out of range", () => {
    const lockedTarget = createHostile("locked", 13, 10, 10);
    const reachableTarget = createHostile("reachable", 10, 11, 100);
    const rampart = createRampart(10, 10);
    const defender = {
      name: "defender-0",
      memory: { role: "homeDefender" },
      body: [{ type: ATTACK }],
      pos: new MockPos(10, 10, "W1N1") as unknown as RoomPosition,
      attack: jest.fn(() => OK),
      moveTo: jest.fn(() => OK),
    } as unknown as Creep;
    const room = createRoom([defender]);
    Object.defineProperty(defender, "room", { value: room });

    (getPlayerHostiles as jest.Mock).mockReturnValue([lockedTarget, reachableTarget]);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue({
      id: "front:0",
      hostileIds: [lockedTarget.id],
      centroid: { x: lockedTarget.pos.x, y: lockedTarget.pos.y },
      threatScore: 1,
    });
    (getBoundaryRamparts as jest.Mock).mockReturnValue([rampart]);

    homeDefenderRole("W1N1", "0").target(defender);

    expect(defender.attack).toHaveBeenCalledWith(reachableTarget);
    expect(defender.attack).not.toHaveBeenCalledWith(lockedTarget);
  });

  it("uses moveToTargetRoom when outside defended room", () => {
    const defender = {
      name: "defender-0",
      memory: { role: "homeDefender" },
      pos: new MockPos(25, 25, "W2N1") as unknown as RoomPosition,
      moveTo: jest.fn(() => OK),
    } as unknown as Creep;
    const otherRoom = { name: "W2N1" } as unknown as Room;
    Object.defineProperty(defender, "room", { value: otherRoom });

    homeDefenderRole("W1N1", "0").target(defender);

    expect(moveToTargetRoom).toHaveBeenCalledWith(defender, "W1N1");
    // Must NOT use raw moveTo
    expect(defender.moveTo).not.toHaveBeenCalled();
  });

  it("uses moveToTarget with costCallback and cacheKey for inside-hostile chase", () => {
    const safeZone = new Set<number>();
    for (let x = 8; x <= 12; x++) {
      for (let y = 8; y <= 12; y++) {
        safeZone.add(x * 50 + y);
      }
    }
    (getSafeZone as jest.Mock).mockReturnValue(safeZone);

    const hostile = createHostile("h1", 10, 12);
    const safeZoneCb = jest.fn();
    (createSafeZoneCostCallback as jest.Mock).mockReturnValue(safeZoneCb);

    const defender = {
      name: "defender-0",
      memory: { role: "homeDefender" },
      pos: new MockPos(10, 9, "W1N1") as unknown as RoomPosition,
      attack: jest.fn(() => OK),
      moveTo: jest.fn(() => OK),
    } as unknown as Creep;
    const room = createRoom([defender]);
    Object.defineProperty(defender, "room", { value: room });

    (getPlayerHostiles as jest.Mock).mockReturnValue([hostile]);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);

    homeDefenderRole("W1N1", "0").target(defender);

    expect(moveToTarget).toHaveBeenCalledWith(defender, hostile, 1, {
      costCallback: safeZoneCb,
      cacheKey: "safezone:W1N1",
      maxRooms: 1,
      reusePath: 2,
    });
    expect(defender.moveTo).not.toHaveBeenCalled();
  });

  it("uses moveToTarget with costCallback and cacheKey for boundary rampart positioning", () => {
    const safeZone = new Set<number>();
    for (let x = 8; x <= 12; x++) {
      for (let y = 8; y <= 12; y++) {
        safeZone.add(x * 50 + y);
      }
    }
    (getSafeZone as jest.Mock).mockReturnValue(safeZone);

    const hostile = createHostile("h1", 14, 10);
    const rampart = createRampart(12, 10);
    const safeZoneCb = jest.fn();
    (createSafeZoneCostCallback as jest.Mock).mockReturnValue(safeZoneCb);

    const defender = {
      name: "defender-0",
      memory: { role: "homeDefender" },
      pos: new MockPos(10, 10, "W1N1") as unknown as RoomPosition,
      attack: jest.fn(() => OK),
      moveTo: jest.fn(() => OK),
    } as unknown as Creep;
    const room = createRoom([defender]);
    Object.defineProperty(defender, "room", { value: room });

    (getPlayerHostiles as jest.Mock).mockReturnValue([hostile]);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    (getBoundaryRamparts as jest.Mock).mockReturnValue([rampart]);

    homeDefenderRole("W1N1", "0").target(defender);

    expect(moveToTarget).toHaveBeenCalledWith(defender, rampart.pos, 0, {
      costCallback: safeZoneCb,
      cacheKey: "safezone:W1N1",
      maxRooms: 1,
      reusePath: 3,
    });
    expect(defender.moveTo).not.toHaveBeenCalled();
  });

  it("never calls raw creep.moveTo", () => {
    const safeZone = new Set<number>();
    for (let x = 8; x <= 12; x++) {
      for (let y = 8; y <= 12; y++) {
        safeZone.add(x * 50 + y);
      }
    }
    (getSafeZone as jest.Mock).mockReturnValue(safeZone);

    const hostile = createHostile("h1", 14, 10);
    const rampart = createRampart(12, 10);
    const defender = {
      name: "defender-0",
      memory: { role: "homeDefender" },
      pos: new MockPos(12, 10, "W1N1") as unknown as RoomPosition,
      attack: jest.fn(() => OK),
      moveTo: jest.fn(() => OK),
    } as unknown as Creep;
    const room = createRoom([defender]);
    Object.defineProperty(defender, "room", { value: room });

    (getPlayerHostiles as jest.Mock).mockReturnValue([hostile]);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    (getBoundaryRamparts as jest.Mock).mockReturnValue([rampart]);

    homeDefenderRole("W1N1", "0").target(defender);

    expect(defender.moveTo).not.toHaveBeenCalled();
  });
});
