import {
  MAX_FEE_EVENTS,
  advanceFeeLedgerWindow,
  applyFillFeeDebt,
  buildProcessedFillKey,
  commitProspectiveFeeReservation,
  createEmptyMarketSaleFeeLedger,
  evaluateProspectiveFeeGate,
  getFeeLedgerTotals,
  markExternalOrderMutationFeeGap,
  reconcileDisappearedOrderFeeDebt,
  releaseProspectiveFeeReservation,
  reserveProspectiveFee,
  resolveExternalOrderMutationFeeGap,
  resolveDisappearedOrderFeeGap,
  takeCarriedFeeDebt,
  type FeeLedgerLimits,
  type MarketSaleFeeLedgerState,
  type ProspectiveFeeGateInput,
} from "@/runtime/marketSaleFeeLedger";

const LIMITS: FeeLedgerLimits = {
  feeWindowTicks: 10,
  fillReceiptWindowTicks: 20,
  maxFeeEvents: 8,
  maxSameTickReservations: 4,
  maxProcessedFills: 8,
};

function gateInput(
  ledger: MarketSaleFeeLedgerState,
  overrides: Partial<ProspectiveFeeGateInput> = {},
): ProspectiveFeeGateInput {
  return {
    ledger,
    gameTime: 100,
    action: "extend",
    prospectiveFeeMilli: 200,
    creditsMilli: 10_000,
    creditReserveMilli: 1_000,
    rollingFeeBudgetMilli: 5_000,
    limits: LIMITS,
    ...overrides,
  };
}

describe("prospective fee reservation and gates", () => {

  it("enforces credit reserve and rolling fee budget including uncommitted reservations", () => {
    const first = reserveProspectiveFee({
      ...gateInput(createEmptyMarketSaleFeeLedger(), {
        prospectiveFeeMilli: 600,
        creditsMilli: 1_000,
        creditReserveMilli: 300,
        rollingFeeBudgetMilli: 1_000,
      }),
      reservationId: "first",
    });
    expect(first.allowed).toBe(true);

    const denied = evaluateProspectiveFeeGate(gateInput(first.ledger, {
      prospectiveFeeMilli: 500,
      creditsMilli: 1_000,
      creditReserveMilli: 300,
      rollingFeeBudgetMilli: 1_000,
    }));
    expect(denied.allowed).toBe(false);
    expect(denied.reasons).toEqual(expect.arrayContaining([
      "credit_reserve",
      "rolling_fee_budget",
    ]));
  });
});

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
