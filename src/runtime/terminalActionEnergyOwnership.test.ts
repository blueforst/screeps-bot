import {
  getTerminalActionEnergyOwnershipBudget,
  type TerminalActionEnergyOwnershipBudgetInput,
} from "@/runtime/terminalActionEnergyOwnership";

const ownershipInput = (
  overrides: Partial<TerminalActionEnergyOwnershipBudgetInput> = {},
): TerminalActionEnergyOwnershipBudgetInput => ({
  totalEnergy: 100_000,
  ordinaryTerminalEnergyReserve: 20_000,
  productionEnergyCommitment: 10_000,
  otherOutgoingEnergyCommitment: 15_000,
  otherOutgoingFeeCommitment: 5_000,
  otherExplicitEnergyOwnership: 7_000,
  ...overrides,
});

describe("terminal action Energy ownership", () => {

  it("allows the exact remaining budget and clamps over-ownership to zero", () => {
    expect(
      getTerminalActionEnergyOwnershipBudget(
        ownershipInput({ totalEnergy: 57_000 }),
      ),
    ).toBe(0);
    expect(
      getTerminalActionEnergyOwnershipBudget(
        ownershipInput({ totalEnergy: 56_999 }),
      ),
    ).toBe(0);
    expect(
      getTerminalActionEnergyOwnershipBudget(
        ownershipInput({ totalEnergy: 57_001 }),
      ),
    ).toBe(1);
  });

  it("cannot consume room watermarks because they are absent from the API", () => {
    const inputWithIgnoredWatermarks = {
      ...ownershipInput(),
      energyFloor: 1_000_000,
      energyTarget: 2_000_000,
      energyExportStart: 3_000_000,
    };

    expect(
      getTerminalActionEnergyOwnershipBudget(inputWithIgnoredWatermarks),
    ).toBe(43_000);
  });
});
