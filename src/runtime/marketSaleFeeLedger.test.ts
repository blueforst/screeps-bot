import {
  applyFillFeeDebt,
  createEmptyMarketSaleFeeLedger,
  type FeeLedgerLimits,
} from "@/runtime/marketSaleFeeLedger";

const LIMITS: FeeLedgerLimits = {
  feeWindowTicks: 10,
  fillReceiptWindowTicks: 20,
  maxFeeEvents: 8,
  maxSameTickReservations: 4,
  maxProcessedFills: 8,
};


describe("fill idempotency and fee-debt allocation", () => {
  it("uses transactionId+orderId exactly once and preserves pricing rounding remainder", () => {
    const first = applyFillFeeDebt({
      ledger: createEmptyMarketSaleFeeLedger(),
      gameTime: 100,
      transactionId: "tx-1",
      orderId: "order-1",
      feeDebtMilli: 10,
      filledAmount: 1,
      preRemainingAmount: 3,
      limits: LIMITS,
    });
    expect(first).toMatchObject({
      applied: true,
      duplicate: false,
      reconcileGap: false,
      allocation: {
        allocatedFeeDebtMilli: 3,
        remainingFeeDebtMilli: 7,
        postRemainingAmount: 2,
      },
    });

    const duplicate = applyFillFeeDebt({
      ledger: first.ledger,
      gameTime: 100,
      transactionId: "tx-1",
      orderId: "order-1",
      feeDebtMilli: 7,
      filledAmount: 1,
      preRemainingAmount: 3,
      limits: LIMITS,
    });
    expect(duplicate).toMatchObject({
      applied: false,
      duplicate: true,
      reconcileGap: false,
    });
    expect(duplicate.ledger.processedFills).toHaveLength(1);
  });

  it("fails closed at receipt capacity and admits new evidence only after the receipt window expires", () => {
    const singleReceiptLimits = {
      ...LIMITS,
      fillReceiptWindowTicks: 2,
      maxProcessedFills: 1,
    };
    const first = applyFillFeeDebt({
      ledger: createEmptyMarketSaleFeeLedger(),
      gameTime: 100,
      transactionId: "tx-1",
      orderId: "order-1",
      feeDebtMilli: 10,
      filledAmount: 1,
      preRemainingAmount: 2,
      limits: singleReceiptLimits,
    });
    const full = applyFillFeeDebt({
      ledger: first.ledger,
      gameTime: 101,
      transactionId: "tx-2",
      orderId: "order-1",
      feeDebtMilli: 5,
      filledAmount: 1,
      preRemainingAmount: 1,
      limits: singleReceiptLimits,
    });
    expect(full.ledger.reconcileGap?.reason).toBe("fill_receipt_capacity");

    const afterExpiry = applyFillFeeDebt({
      ledger: { ...first.ledger, reconcileGap: undefined },
      gameTime: 102,
      transactionId: "tx-2",
      orderId: "order-1",
      feeDebtMilli: 5,
      filledAmount: 1,
      preRemainingAmount: 1,
      limits: singleReceiptLimits,
    });
    expect(afterExpiry.applied).toBe(true);
    expect(afterExpiry.ledger.processedFills).toHaveLength(1);
  });
});
