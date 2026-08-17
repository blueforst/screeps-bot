import {
  doesCreepBodyMatch,
  retireMismatchedMinersAfterHandoff,
} from "@/runtime/minerBodyPolicy";
import { getLinkMinerBodyForRegenSourceLevel } from "@/config/spawnProfiles";

function createMiner(
  name: string,
  body: BodyPartConstant[],
  inSourceRange: boolean,
  adjacentMinerNames: string[] = [],
): Creep {
  return {
    name,
    body: body.map((type) => ({ type, hits: 100 })),
    pos: {
      inRangeTo: jest.fn((target: RoomObject) => {
        if ((target as Source).id === "source-a") {
          return inSourceRange;
        }
        return adjacentMinerNames.includes((target as Creep).name);
      }),
    } as unknown as RoomPosition,
    suicide: jest.fn(() => OK),
  } as unknown as Creep;
}

describe("minerBodyPolicy", () => {
  const oldBody = [
    ...Array<BodyPartConstant>(12).fill(WORK),
    ...Array<BodyPartConstant>(6).fill(CARRY),
    ...Array<BodyPartConstant>(5).fill(MOVE),
  ];
  const newBody = getLinkMinerBodyForRegenSourceLevel(4);
  const source = { id: "source-a" } as Source;

  it("retires only the mismatched miner after the replacement reaches the Source", () => {
    const oldMiner = createMiner("old", oldBody, true);
    const replacement = createMiner("replacement", newBody, true);

    retireMismatchedMinersAfterHandoff([oldMiner, replacement], source, newBody);

    expect(doesCreepBodyMatch(replacement, newBody)).toBe(true);
    expect(oldMiner.suicide).toHaveBeenCalledTimes(1);
    expect(replacement.suicide).not.toHaveBeenCalled();
  });

  it("hands off from an occupied single-access Source when the replacement reaches the staging tile", () => {
    const oldMiner = createMiner("old", oldBody, true);
    const replacement = createMiner("replacement", newBody, false, ["old"]);

    retireMismatchedMinersAfterHandoff([oldMiner, replacement], source, newBody);

    expect(oldMiner.suicide).toHaveBeenCalledTimes(1);
    expect(replacement.suicide).not.toHaveBeenCalled();
  });
});
