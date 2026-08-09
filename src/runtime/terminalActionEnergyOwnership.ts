const MAX_ENERGY_AMOUNT = Number.MAX_SAFE_INTEGER;

/**
 * 跨房动作可消费的房间总 Energy 所有权事实。
 *
 * Room Energy 恢复水位不属于库存所有权，因此本接口刻意不接收
 * energyFloor、energyTarget 或 energyExportStart。
 */
export interface TerminalActionEnergyOwnershipBudgetInput {
  totalEnergy: number;
  ordinaryTerminalEnergyReserve: number;
  productionEnergyCommitment: number;
  otherOutgoingEnergyCommitment: number;
  otherOutgoingFeeCommitment: number;
  otherExplicitEnergyOwnership: number;
}

export interface TerminalActionRequiredEnergyInput {
  energyPayload: boolean;
  amount: number;
  transactionFee: number;
}

function normalizeAvailableEnergyAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_ENERGY_AMOUNT, Math.floor(value));
}

function normalizeOwnedOrRequiredEnergyAmount(value: number): number {
  if (!Number.isFinite(value)) return MAX_ENERGY_AMOUNT;
  if (value <= 0) return 0;
  return Math.min(MAX_ENERGY_AMOUNT, Math.floor(value));
}

function addEnergyAmounts(left: number, right: number): number {
  return Math.min(MAX_ENERGY_AMOUNT, left + right);
}

/**
 * 返回跨房动作可以占用的 room-total Energy；所有显式所有权先于动作扣除。
 */
export function getTerminalActionEnergyOwnershipBudget(
  input: TerminalActionEnergyOwnershipBudgetInput,
): number {
  const totalEnergy = normalizeAvailableEnergyAmount(input.totalEnergy);
  const ownedEnergy = [
    input.ordinaryTerminalEnergyReserve,
    input.productionEnergyCommitment,
    input.otherOutgoingEnergyCommitment,
    input.otherOutgoingFeeCommitment,
    input.otherExplicitEnergyOwnership,
  ].reduce(
    (total, amount) =>
      addEnergyAmounts(total, normalizeOwnedOrRequiredEnergyAmount(amount)),
    0,
  );

  return Math.max(0, totalEnergy - ownedEnergy);
}

/**
 * Energy payload 消耗 payload+fee；其他资源 payload 只消耗 transaction fee。
 */
export function getTerminalActionRequiredEnergy(
  input: TerminalActionRequiredEnergyInput,
): number {
  const transactionFee = normalizeOwnedOrRequiredEnergyAmount(
    input.transactionFee,
  );
  if (!input.energyPayload) return transactionFee;
  return addEnergyAmounts(
    normalizeOwnedOrRequiredEnergyAmount(input.amount),
    transactionFee,
  );
}
