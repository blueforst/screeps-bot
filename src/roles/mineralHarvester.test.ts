import { mineralHarvesterRole } from "@/roles/mineralHarvester";
import { moveToTarget } from "@/roles/shared";

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
}));

function createMineral(id: string): Mineral {
  const container = {
    id: `${id}-container`,
    structureType: STRUCTURE_CONTAINER,
    pos: {
      x: 10,
      y: 10,
      roomName: "W1N1",
    },
  } as StructureContainer;

  return {
    id,
    mineralAmount: 2000,
    pos: {
      x: 11,
      y: 10,
      roomName: "W1N1",
      findInRange: () => [container],
    } as unknown as RoomPosition,
  } as Mineral;
}

describe("mineralHarvesterRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Game.time += 1;
  });

  it("moves onto the adjacent mineral container before harvesting", () => {
    const mineral = createMineral("mineral-a");
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(() => mineral) as Game["getObjectById"];
    const creep = {
      pos: {
        isEqualTo: () => false,
      },
      harvest: jest.fn(() => OK),
    } as unknown as Creep;
    const role = mineralHarvesterRole(mineral.id);

    expect(role.source?.(creep)).toBe(false);
    expect(moveToTarget).toHaveBeenCalledWith(creep, (mineral.pos.findInRange(FIND_STRUCTURES, 1)[0] as StructureContainer).pos, 0, {
      reusePath: 5,
    });
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it("harvests mineral in source phase and never switches to target delivery", () => {
    const mineral = createMineral("mineral-b");
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(() => mineral) as Game["getObjectById"];
    const creep = {
      pos: {
        isEqualTo: () => true,
      },
      harvest: jest.fn(() => OK),
    } as unknown as Creep;
    const role = mineralHarvesterRole(mineral.id);

    expect(role.source?.(creep)).toBe(false);
    expect(creep.harvest).toHaveBeenCalledWith(mineral);
    expect(role.target(creep)).toBe(false);
  });
});
