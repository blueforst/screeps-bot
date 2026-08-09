import {
  getTerminalActionEnergyOwnershipBudget,
  getTerminalActionRequiredEnergy,
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
  it("deducts every explicit ownership bucket from room-total Energy", () => {
    expect(
      getTerminalActionEnergyOwnershipBudget(ownershipInput()),
    ).toBe(43_000);
  });

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

  it("normalizes fractional and negative finite facts", () => {
    expect(
      getTerminalActionEnergyOwnershipBudget({
        totalEnergy: 100.9,
        ordinaryTerminalEnergyReserve: 10.8,
        productionEnergyCommitment: 5.9,
        otherOutgoingEnergyCommitment: -20,
        otherOutgoingFeeCommitment: 0,
        otherExplicitEnergyOwnership: 0,
      }),
    ).toBe(85);
  });

  it("fails closed for non-finite availability or ownership facts", () => {
    expect(
      getTerminalActionEnergyOwnershipBudget(
        ownershipInput({ totalEnergy: Number.POSITIVE_INFINITY }),
      ),
    ).toBe(0);
    expect(
      getTerminalActionEnergyOwnershipBudget(
        ownershipInput({ otherOutgoingFeeCommitment: Number.NaN }),
      ),
    ).toBe(0);
    expect(
      getTerminalActionEnergyOwnershipBudget(
        ownershipInput({ otherExplicitEnergyOwnership: Number.POSITIVE_INFINITY }),
      ),
    ).toBe(0);
  });

  it("saturates unsafe finite inputs without producing Infinity", () => {
    expect(
      getTerminalActionEnergyOwnershipBudget({
        totalEnergy: Number.MAX_VALUE,
        ordinaryTerminalEnergyReserve: 0,
        productionEnergyCommitment: 0,
        otherOutgoingEnergyCommitment: 0,
        otherOutgoingFeeCommitment: 0,
        otherExplicitEnergyOwnership: 0,
      }),
    ).toBe(Number.MAX_SAFE_INTEGER);
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

  it("requires amount plus fee for Energy payloads and only fee otherwise", () => {
    expect(
      getTerminalActionRequiredEnergy({
        energyPayload: true,
        amount: 10_000,
        transactionFee: 1_000,
      }),
    ).toBe(11_000);
    expect(
      getTerminalActionRequiredEnergy({
        energyPayload: false,
        amount: 10_000,
        transactionFee: 1_000,
      }),
    ).toBe(1_000);
  });

  it("keeps the current action out of other-task ownership", () => {
    const budget = getTerminalActionEnergyOwnershipBudget({
      totalEnergy: 31_000,
      ordinaryTerminalEnergyReserve: 20_000,
      productionEnergyCommitment: 0,
      otherOutgoingEnergyCommitment: 0,
      otherOutgoingFeeCommitment: 0,
      otherExplicitEnergyOwnership: 0,
    });
    const required = getTerminalActionRequiredEnergy({
      energyPayload: true,
      amount: 10_000,
      transactionFee: 1_000,
    });

    expect(budget).toBe(11_000);
    expect(required).toBe(11_000);
    expect(required).toBeLessThanOrEqual(budget);
  });

  it("normalizes required-Energy inputs and saturates their sum", () => {
    expect(
      getTerminalActionRequiredEnergy({
        energyPayload: true,
        amount: 10.9,
        transactionFee: 1.9,
      }),
    ).toBe(11);
    expect(
      getTerminalActionRequiredEnergy({
        energyPayload: false,
        amount: Number.MAX_VALUE,
        transactionFee: Number.NaN,
      }),
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      getTerminalActionRequiredEnergy({
        energyPayload: true,
        amount: Number.MAX_SAFE_INTEGER,
        transactionFee: 1,
      }),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});
