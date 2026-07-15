jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

jest.mock("@/runtime/powerBankBoostMemory", () => ({
  getAssignedPowerBankBoostLabId: jest.fn(),
}));

import { prepareCombatBoost } from "@/roles/combatBoosts";
import { getAssignedPowerBankBoostLabId } from "@/runtime/powerBankBoostMemory";
import { createMockStore } from "@mock/powerBank";

const mockedGetAssignedLabId = getAssignedPowerBankBoostLabId as jest.MockedFunction<
  typeof getAssignedPowerBankBoostLabId
>;

function createAttacker(): Creep {
  return {
    body: [{ type: ATTACK, hits: 100 }],
    pos: { isNearTo: jest.fn(() => true) } as unknown as RoomPosition,
  } as unknown as Creep;
}

function createBoostLab(energy: number): StructureLab {
  return {
    id: "lab-1" as Id<StructureLab>,
    store: createMockStore({
      [RESOURCE_CATALYZED_UTRIUM_ACID]: LAB_BOOST_MINERAL,
      [RESOURCE_ENERGY]: energy,
    }),
    boostCreep: jest.fn(() => OK),
  } as unknown as StructureLab;
}

describe("prepareCombatBoost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetAssignedLabId.mockReturnValue("lab-1");
  });

  it("does not issue a boost intent when the assigned lab lacks energy", () => {
    const lab = createBoostLab(0);
    Game.getObjectById = jest.fn(() => lab) as typeof Game.getObjectById;

    const ready = prepareCombatBoost(
      createAttacker(),
      "war:E1N57:E2N54:g1",
      RESOURCE_CATALYZED_UTRIUM_ACID,
    );

    expect(ready).toBe(false);
    expect(lab.boostCreep).not.toHaveBeenCalled();
  });

  it("issues a boost intent when the assigned lab has mineral and energy", () => {
    const lab = createBoostLab(LAB_BOOST_ENERGY);
    Game.getObjectById = jest.fn(() => lab) as typeof Game.getObjectById;
    const creep = createAttacker();

    const ready = prepareCombatBoost(
      creep,
      "war:E1N57:E2N54:g1",
      RESOURCE_CATALYZED_UTRIUM_ACID,
    );

    expect(ready).toBe(false);
    expect(lab.boostCreep).toHaveBeenCalledWith(creep);
  });
});
