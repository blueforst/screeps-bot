import {
  chooseBoundaryBurstEngagement,
} from "@/runtime/hostilePriorities";

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
}

function createHostile(
  bodyCounts: Partial<Record<BodyPartConstant, number>>,
  pos = new MockPos(25, 25, "W1N1"),
): Creep {
  return {
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => bodyCounts[part] || 0),
    hits: 100,
    pos: pos as unknown as RoomPosition,
  } as unknown as Creep;
}

function createRampart(x: number, y: number): StructureRampart {
  return {
    pos: new MockPos(x, y, "W1N1") as unknown as RoomPosition,
  } as StructureRampart;
}

describe("hostilePriorities", () => {

  it("chooses the front-line dismantler over a back-line healer at the boundary", () => {
    const healer = createHostile({ [HEAL]: 5 }, new MockPos(20, 20, "W1N1"));
    const dismantler = createHostile({ [WORK]: 2, [MOVE]: 2 }, new MockPos(12, 10, "W1N1"));
    const engagement = chooseBoundaryBurstEngagement([healer, dismantler], [createRampart(10, 10)]);

    expect(engagement?.hostile).toBe(dismantler);
  });

  it("prefers an unoccupied rampart when another defender already holds the closest one", () => {
    const hostile = createHostile({ [WORK]: 2 }, new MockPos(12, 10, "W1N1"));
    const occupiedRampart = createRampart(10, 10);
    const freeRampart = createRampart(11, 10);

    const engagement = chooseBoundaryBurstEngagement([hostile], [occupiedRampart, freeRampart], new Set([occupiedRampart.id]));

    expect(engagement?.rampart).toBe(freeRampart);
  });
});
