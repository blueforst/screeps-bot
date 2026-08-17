import {
  DIRECT_ENGINE_ASSUMPTIONS,
  directEngineAssumptionsValid,
  evaluatePinnedDirectDealFixture,
} from "@/runtime/marketSaleDirectEngineAssumptions";

describe("Direct pinned Screeps engine assumptions", () => {

  it("任一影响资格的 pinned 语义漂移都会令运行时门禁 fail-closed", () => {
    for (const key of Object.keys(DIRECT_ENGINE_ASSUMPTIONS)) {
      expect(
        directEngineAssumptionsValid({
          ...DIRECT_ENGINE_ASSUMPTIONS,
          [key]: "__drift__",
        }),
      ).toBe(false);
    }
  });

  it("fixture 覆盖 underfill、changed-order skip、cooldown 与成功后 cooldown", () => {
    expect(
      evaluatePinnedDirectDealFixture({
        requestedAmount: 1_000,
        currentOrderAmount: 375,
        currentTerminalResource: 1_000,
        currentTerminalEnergy: 1_000,
        transactionEnergy: 300,
        terminalCooldown: 0,
        orderChangedThisCycle: false,
      }),
    ).toEqual({
      executedAmount: 375,
      skipped: false,
      cooldownApplied: true,
    });
    expect(
      evaluatePinnedDirectDealFixture({
        requestedAmount: 1_000,
        currentOrderAmount: 1_000,
        currentTerminalResource: 1_000,
        currentTerminalEnergy: 1_000,
        transactionEnergy: 300,
        terminalCooldown: 0,
        orderChangedThisCycle: true,
      }),
    ).toEqual({
      executedAmount: 0,
      skipped: true,
      cooldownApplied: false,
    });
    expect(
      evaluatePinnedDirectDealFixture({
        requestedAmount: 1_000,
        currentOrderAmount: 1_000,
        currentTerminalResource: 1_000,
        currentTerminalEnergy: 1_000,
        transactionEnergy: 300,
        terminalCooldown: 1,
        orderChangedThisCycle: false,
      }),
    ).toEqual({
      executedAmount: 0,
      skipped: false,
      cooldownApplied: false,
    });
  });
});
