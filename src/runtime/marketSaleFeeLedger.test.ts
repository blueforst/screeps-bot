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

describe("fee event rolling window", () => {
  it("prunes expired events and stale same-tick reservations without mutating persisted input", () => {
    const original: MarketSaleFeeLedgerState = {
      ...createEmptyMarketSaleFeeLedger(),
      feeEvents: [
        { id: "expired", tick: 90, action: "create", feeMilli: 100 },
        { id: "active", tick: 91, action: "extend", feeMilli: 200 },
      ],
      sameTickReservations: [
        { id: "old-reservation", tick: 99, action: "extend", feeMilli: 50, status: "reserved" },
      ],
    };

    const advanced = advanceFeeLedgerWindow(original, 100, LIMITS);

    expect(advanced.feeEvents).toEqual([
      { id: "active", tick: 91, action: "extend", feeMilli: 200 },
    ]);
    expect(advanced.sameTickReservations).toEqual([]);
    expect(original.feeEvents).toHaveLength(2);
    expect(original.sameTickReservations).toHaveLength(1);
  });

  it("keeps fee events strictly bounded and fails closed instead of dropping active fees", () => {
    const oversized: MarketSaleFeeLedgerState = {
      ...createEmptyMarketSaleFeeLedger(),
      feeEvents: Array.from({ length: MAX_FEE_EVENTS + 1 }, (_, index) => ({
        id: `event-${index}`,
        tick: 100,
        action: "create" as const,
        feeMilli: 1,
      })),
    };

    expect(() => advanceFeeLedgerWindow(oversized, 100, LIMITS))
      .toThrow("fee ledger array exceeds its hard bound");
  });
});

describe("prospective fee reservation and gates", () => {
  it("reserves once per stable id, commits to the rolling window, and retains the same-tick credit hold", () => {
    const empty = createEmptyMarketSaleFeeLedger();
    const reserved = reserveProspectiveFee({
      ...gateInput(empty),
      reservationId: "mutation-1",
    });

    expect(reserved).toMatchObject({
      allowed: true,
      alreadyReserved: false,
      projectedCreditsMilli: 9_800,
      projectedRollingFeeMilli: 200,
    });
    expect(reserved.ledger.sameTickReservations).toHaveLength(1);

    const duplicate = reserveProspectiveFee({
      ...gateInput(reserved.ledger),
      reservationId: "mutation-1",
    });
    expect(duplicate.alreadyReserved).toBe(true);
    expect(duplicate.allowed).toBe(false);
    expect(duplicate.reasons).toEqual(["reservation_already_exists"]);
    expect(duplicate.ledger.sameTickReservations).toHaveLength(1);

    const committed = commitProspectiveFeeReservation({
      ledger: duplicate.ledger,
      reservationId: "mutation-1",
      gameTime: 100,
      limits: LIMITS,
    });
    expect(getFeeLedgerTotals(committed)).toEqual({
      rollingFeeMilli: 200,
      reservedThisTickMilli: 200,
      uncommittedReservationMilli: 0,
    });
    expect(commitProspectiveFeeReservation({
      ledger: committed,
      reservationId: "mutation-1",
      gameTime: 100,
      limits: LIMITS,
    })).toEqual(committed);

    const nextTick = advanceFeeLedgerWindow(committed, 101, LIMITS);
    expect(nextTick.sameTickReservations).toEqual([]);
    expect(nextTick.feeEvents).toHaveLength(1);
  });

  it("releases an uncommitted reservation after a rejected market write", () => {
    const reserved = reserveProspectiveFee({
      ...gateInput(createEmptyMarketSaleFeeLedger()),
      reservationId: "failed-write",
    });
    const released = releaseProspectiveFeeReservation({
      ledger: reserved.ledger,
      reservationId: "failed-write",
      gameTime: 100,
      limits: LIMITS,
    });

    expect(released.sameTickReservations).toEqual([]);
    expect(released.feeEvents).toEqual([]);
  });

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

  it("protects manual order slots and the managed-order cap on create", () => {
    const denied = evaluateProspectiveFeeGate(gateInput(
      createEmptyMarketSaleFeeLedger(),
      {
        action: "create",
        orderSlots: {
          usedOrderSlots: 295,
          totalOrderSlots: 300,
          minFreeOrderSlots: 5,
          managedOrderCount: 3,
          maxManagedOrders: 3,
        },
      },
    ));

    expect(denied.allowed).toBe(false);
    expect(denied.freeOrderSlotsAfter).toBe(4);
    expect(denied.reasons).toEqual(expect.arrayContaining([
      "free_order_slots",
      "managed_order_limit",
    ]));
  });

  it("fails closed when an active event or same-tick reservation would exceed its configured bound", () => {
    const oneEvent: MarketSaleFeeLedgerState = {
      ...createEmptyMarketSaleFeeLedger(),
      feeEvents: [
        { id: "only-event", tick: 100, action: "create", feeMilli: 1 },
      ],
    };
    const gate = evaluateProspectiveFeeGate(gateInput(oneEvent, {
      limits: {
        ...LIMITS,
        maxFeeEvents: 1,
      },
    }));
    expect(gate.reasons).toContain("fee_event_capacity");

    const first = reserveProspectiveFee({
      ...gateInput(createEmptyMarketSaleFeeLedger(), {
        limits: {
          ...LIMITS,
          maxSameTickReservations: 1,
        },
      }),
      reservationId: "one",
    });
    const second = evaluateProspectiveFeeGate(gateInput(first.ledger, {
      limits: {
        ...LIMITS,
        maxSameTickReservations: 1,
      },
    }));
    expect(second.reasons).toContain("reservation_capacity");
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

  it("does not collide when ids contain separators", () => {
    expect(buildProcessedFillKey("a:b", "c"))
      .not.toBe(buildProcessedFillKey("a", "b:c"));
  });

  it("marks reconcile_gap when a previously seen fill key changes its immutable amounts", () => {
    const first = applyFillFeeDebt({
      ledger: createEmptyMarketSaleFeeLedger(),
      gameTime: 100,
      transactionId: "tx-conflict",
      orderId: "order-1",
      feeDebtMilli: 10,
      filledAmount: 1,
      preRemainingAmount: 3,
      limits: LIMITS,
    });
    const conflict = applyFillFeeDebt({
      ledger: first.ledger,
      gameTime: 100,
      transactionId: "tx-conflict",
      orderId: "order-1",
      feeDebtMilli: 7,
      filledAmount: 2,
      preRemainingAmount: 3,
      limits: LIMITS,
    });

    expect(conflict.reconcileGap).toBe(true);
    expect(conflict.ledger.reconcileGap).toMatchObject({
      reason: "fill_receipt_conflict",
      orderId: "order-1",
      transactionId: "tx-conflict",
    });
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

describe("order disappearance fee reconciliation", () => {
  it("external order mutation stays fenced until exact operator fee reconciliation", () => {
    const marked = markExternalOrderMutationFeeGap({
      ledger: createEmptyMarketSaleFeeLedger(),
      gameTime: 100,
      orderId: "managed-1",
    });

    expect(marked.reconcileGap).toMatchObject({
      reason: "external_order_mutation",
      orderId: "managed-1",
      observedAt: 100,
    });
    expect(
      evaluateProspectiveFeeGate(gateInput(marked)).reasons,
    ).toContain("reconcile_gap");
    expect(() =>
      resolveExternalOrderMutationFeeGap({
        ledger: marked,
        orderId: "other-order",
        resourceType: RESOURCE_HYDROGEN,
        verifiedRemainingFeeDebtMilli: 25,
      }),
    ).toThrow("does not match");

    const resolved = resolveExternalOrderMutationFeeGap({
      ledger: marked,
      orderId: "managed-1",
      resourceType: RESOURCE_HYDROGEN,
      verifiedRemainingFeeDebtMilli: 25,
    });
    expect(resolved.reconcileGap).toBeUndefined();
    expect(resolved.carriedFeeDebtMilli[RESOURCE_HYDROGEN]).toBe(25);
    const extracted = takeCarriedFeeDebt(
      resolved,
      RESOURCE_HYDROGEN,
    );
    expect(extracted.feeDebtMilli).toBe(25);
    expect(
      extracted.ledger.carriedFeeDebtMilli[RESOURCE_HYDROGEN],
    ).toBeUndefined();
  });

  it("carries every remaining milli-credit after policy cancellation", () => {
    const original = createEmptyMarketSaleFeeLedger();
    const cancelled = reconcileDisappearedOrderFeeDebt({
      ledger: original,
      gameTime: 100,
      orderId: "order-1",
      resourceType: RESOURCE_HYDROGEN,
      remainingFeeDebtMilli: 17,
      reason: "policy_cancelled",
    });

    expect(cancelled).toMatchObject({
      resolved: true,
      classification: "policy_cancelled",
      refundedFeeDebtMilli: 0,
      carriedFeeDebtMilli: 17,
    });
    expect(cancelled.ledger.carriedFeeDebtMilli[RESOURCE_HYDROGEN]).toBe(17);
    expect(original.carriedFeeDebtMilli[RESOURCE_HYDROGEN]).toBeUndefined();

    const taken = takeCarriedFeeDebt(cancelled.ledger, RESOURCE_HYDROGEN);
    expect(taken.feeDebtMilli).toBe(17);
    expect(taken.ledger.carriedFeeDebtMilli[RESOURCE_HYDROGEN]).toBeUndefined();
  });

  it("writes off only an externally verified server-expiry refund and carries residual inherited debt", () => {
    const ledger: MarketSaleFeeLedgerState = {
      ...createEmptyMarketSaleFeeLedger(),
      carriedFeeDebtMilli: { [RESOURCE_HYDROGEN]: 10 },
    };
    const expired = reconcileDisappearedOrderFeeDebt({
      ledger,
      gameTime: 100,
      orderId: "order-1",
      resourceType: RESOURCE_HYDROGEN,
      remainingFeeDebtMilli: 100,
      reason: "server_expired",
      verifiedRefundMilli: 80,
    });

    expect(expired).toMatchObject({
      resolved: true,
      classification: "server_expired",
      refundedFeeDebtMilli: 80,
      carriedFeeDebtMilli: 20,
    });
    expect(expired.ledger.carriedFeeDebtMilli[RESOURCE_HYDROGEN]).toBe(30);
  });

  it("never infers server expiry or refund and freezes unknown disappearance as reconcile_gap", () => {
    const unverifiedExpiry = reconcileDisappearedOrderFeeDebt({
      ledger: createEmptyMarketSaleFeeLedger(),
      gameTime: 100,
      orderId: "order-1",
      resourceType: RESOURCE_HYDROGEN,
      remainingFeeDebtMilli: 100,
      reason: "server_expired",
    });
    expect(unverifiedExpiry).toMatchObject({
      resolved: false,
      classification: "reconcile_gap",
      preservedFeeDebtMilli: 100,
      ledger: {
        reconcileGap: {
          reason: "unknown_disappearance",
          orderId: "order-1",
        },
      },
    });

    const unknown = reconcileDisappearedOrderFeeDebt({
      ledger: createEmptyMarketSaleFeeLedger(),
      gameTime: 100,
      orderId: "order-unknown",
      resourceType: RESOURCE_HYDROGEN,
      remainingFeeDebtMilli: 100,
      reason: "unknown",
    });
    expect(unknown).toMatchObject({
      resolved: false,
      classification: "reconcile_gap",
      preservedFeeDebtMilli: 100,
    });
    expect(unknown.ledger.carriedFeeDebtMilli[RESOURCE_HYDROGEN]).toBeUndefined();

    const gate = evaluateProspectiveFeeGate(gateInput(unknown.ledger));
    expect(gate.reasons).toContain("reconcile_gap");
  });

  it("exact operator resolution clears only a matching disappearance gap", () => {
    const unknown = reconcileDisappearedOrderFeeDebt({
      ledger: createEmptyMarketSaleFeeLedger(),
      gameTime: 100,
      orderId: "order-1",
      resourceType: RESOURCE_HYDROGEN,
      remainingFeeDebtMilli: 100,
      reason: "unknown",
    });
    expect(() =>
      resolveDisappearedOrderFeeGap({
        ledger: unknown.ledger,
        gameTime: 101,
        orderId: "other-order",
        resourceType: RESOURCE_HYDROGEN,
        remainingFeeDebtMilli: 100,
        reason: "policy_cancelled",
      }),
    ).toThrow("does not match");

    const resolved = resolveDisappearedOrderFeeGap({
      ledger: unknown.ledger,
      gameTime: 101,
      orderId: "order-1",
      resourceType: RESOURCE_HYDROGEN,
      remainingFeeDebtMilli: 100,
      reason: "server_expired",
      verifiedRefundMilli: 40,
    });
    expect(resolved).toMatchObject({
      resolved: true,
      refundedFeeDebtMilli: 40,
      carriedFeeDebtMilli: 60,
      ledger: { reconcileGap: undefined },
    });
  });
});

describe("milli-credit integer safety", () => {
  it("rejects fractional milli-credit inputs", () => {
    expect(() => evaluateProspectiveFeeGate(gateInput(
      createEmptyMarketSaleFeeLedger(),
      { prospectiveFeeMilli: 0.5 },
    ))).toThrow("non-negative safe integer");
  });

  it("rejects carried-debt addition beyond safe integer precision", () => {
    const ledger: MarketSaleFeeLedgerState = {
      ...createEmptyMarketSaleFeeLedger(),
      carriedFeeDebtMilli: {
        [RESOURCE_HYDROGEN]: Number.MAX_SAFE_INTEGER,
      },
    };
    expect(() => reconcileDisappearedOrderFeeDebt({
      ledger,
      gameTime: 100,
      orderId: "order-overflow",
      resourceType: RESOURCE_HYDROGEN,
      remainingFeeDebtMilli: 1,
      reason: "policy_cancelled",
    })).toThrow("safe integer precision");
  });
});
