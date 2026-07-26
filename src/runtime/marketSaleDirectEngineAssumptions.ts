/**
 * Direct 首发灰度所依赖的 Screeps engine 固定语义。
 *
 * 上游实现基线：
 * https://github.com/screeps/engine/tree/80977824199a596d174d392fd0cf8c458c21fcbd
 *
 * 这里不是尝试在游戏内猜测 engine 版本，而是让定价、对账和测试共同引用
 * 同一份可审查 fixture。上游语义变化时必须先更新 fixture 与回归测试；在此
 * 之前，任何不符合 tuple/数量/时间/能量证据的结果都会进入 reconcile gap。
 */
export const DIRECT_ENGINE_ASSUMPTIONS = {
  commit: "80977824199a596d174d392fd0cf8c458c21fcbd",
  transactionEnergyRounding: "ceil",
  minimumPositiveExecutionAmount: 1,
  transactionTimeEqualsAttemptTick: true,
  transactionOrderType: "buy",
  changedOrderSkippedWithinProcessingCycle: true,
  inactiveOwnOrderMayReactivate: true,
  successfulDealAppliesTerminalCooldown: true,
} as const;

/**
 * Direct 运行时资格门禁。这里故意逐字段校验而不是只检查一个版本字符串：
 * 任一用于定价或对账的 engine 语义被改动，都必须先显式更新本门禁、fixture
 * 和审查证据，旧 Shadow 资格也会因 fingerprint 变化而失效。
 */
export function directEngineAssumptionsValid(
  assumptions: Readonly<Record<string, unknown>> =
    DIRECT_ENGINE_ASSUMPTIONS,
): boolean {
  return (
    assumptions.commit ===
      "80977824199a596d174d392fd0cf8c458c21fcbd" &&
    assumptions.transactionEnergyRounding === "ceil" &&
    assumptions.minimumPositiveExecutionAmount === 1 &&
    assumptions.transactionTimeEqualsAttemptTick === true &&
    assumptions.transactionOrderType === "buy" &&
    assumptions.changedOrderSkippedWithinProcessingCycle === true &&
    assumptions.inactiveOwnOrderMayReactivate === true &&
    assumptions.successfulDealAppliesTerminalCooldown === true
  );
}

export interface PinnedDirectDealFixture {
  requestedAmount: number;
  currentOrderAmount: number;
  currentTerminalResource: number;
  currentTerminalEnergy: number;
  transactionEnergy: number;
  terminalCooldown: number;
  orderChangedThisCycle: boolean;
}

export interface PinnedDirectDealFixtureResult {
  executedAmount: number;
  skipped: boolean;
  cooldownApplied: boolean;
}

/**
 * 引擎回归 fixture 的最小可执行模型。它不替代 live 对账，只用于把 underfill、
 * cooldown 和 changed-order skip 这些上游事实连接到本仓库的行为测试。
 */
export function evaluatePinnedDirectDealFixture(
  input: PinnedDirectDealFixture,
): PinnedDirectDealFixtureResult {
  for (const value of [
    input.requestedAmount,
    input.currentOrderAmount,
    input.currentTerminalResource,
    input.currentTerminalEnergy,
    input.transactionEnergy,
    input.terminalCooldown,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("invalid pinned Direct deal fixture input");
    }
  }
  if (
    input.orderChangedThisCycle ||
    input.terminalCooldown > 0 ||
    input.currentTerminalEnergy < input.transactionEnergy
  ) {
    return {
      executedAmount: 0,
      skipped: input.orderChangedThisCycle,
      cooldownApplied: false,
    };
  }
  const executedAmount = Math.min(
    input.requestedAmount,
    input.currentOrderAmount,
    input.currentTerminalResource,
  );
  return {
    executedAmount,
    skipped: false,
    cooldownApplied: executedAmount > 0,
  };
}

export function fixtureTransactionEnergy(
  amount: number,
  rate: number,
): number {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    !Number.isFinite(rate) ||
    rate < 0 ||
    rate >= 1
  ) {
    throw new RangeError("invalid pinned transaction-energy fixture input");
  }
  return Math.ceil(amount * rate);
}
