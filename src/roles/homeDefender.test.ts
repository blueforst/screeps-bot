import { homeDefenderRole } from "@/roles/homeDefender";
import { getAssignedDefenseFront, getDefenderRole, getTowerFocusFront } from "@/runtime/defenseCoordination";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { createSafeZoneCostCallback, getBoundaryRamparts } from "@/runtime/safeZoneHelpers";

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
});
