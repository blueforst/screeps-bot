import {
  DIRECT_ENGINE_ASSUMPTIONS,
  directEngineAssumptionsValid,
  evaluatePinnedDirectDealFixture,
  fixtureTransactionEnergy,
} from "@/runtime/marketSaleDirectEngineAssumptions";

describe("Direct pinned Screeps engine assumptions", () => {
  it("固定首发审查使用的 engine commit 与 fail-closed 语义", () => {
    expect(directEngineAssumptionsValid()).toBe(true);
    expect(DIRECT_ENGINE_ASSUMPTIONS).toEqual({
      commit: "80977824199a596d174d392fd0cf8c458c21fcbd",
      transactionEnergyRounding: "ceil",
      minimumPositiveExecutionAmount: 1,
      transactionTimeEqualsAttemptTick: true,
      transactionOrderType: "buy",
      changedOrderSkippedWithinProcessingCycle: true,
      inactiveOwnOrderMayReactivate: true,
      successfulDealAppliesTerminalCooldown: true,
    });
  });

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

  it("ceil 能量模型证明任意正 underfill 的单位费用不超过 amount=1", () => {
    for (const rate of [0, 0.0001, 0.25, 0.999999]) {
      const worst = fixtureTransactionEnergy(1, rate);
      for (const amount of [1, 2, 3, 999, 1_000]) {
        const energy = fixtureTransactionEnergy(amount, rate);
        expect(energy / amount).toBeLessThanOrEqual(worst);
      }
    }
  });

  it("fixture 对越界数量和费率默认拒绝", () => {
    expect(() => fixtureTransactionEnergy(-1, 0.1)).toThrow();
    expect(() => fixtureTransactionEnergy(1.5, 0.1)).toThrow();
    expect(() => fixtureTransactionEnergy(1, 1)).toThrow();
  });
});
