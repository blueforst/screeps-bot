import {
  createEmptyDirectPendingStore,
  markDirectSubmissionResult,
  normalizeDirectPendingStore,
  prepareDirectPending,
  recoverPendingDirectDeal,
  reconcileDirectPendingDeals,
  type DirectOutgoingTransaction,
  type DirectOutgoingWindow,
  type DirectPendingReconcileDependencies,
  type DirectPhysicalSnapshot,
} from "@/runtime/marketSaleDirectPending";

const BEFORE: DirectPhysicalSnapshot = {
  terminalResource: 72_047,
  terminalEnergy: 50_000,
  terminalCooldown: 0,
  credits: 2_000_000,
};

function window(
  tick: number,
  transactions: DirectOutgoingTransaction[] = [],
  coversAttemptAt = true,
): DirectOutgoingWindow {
  return {
    transactions,
    coversAttemptAt,
    observedAt: tick,
    oldestTime: transactions.length
      ? Math.min(...transactions.map((transaction) => transaction.time))
      : 0,
    newestTime: transactions.length
      ? Math.max(...transactions.map((transaction) => transaction.time))
      : tick,
  };
}

function transaction(
  overrides: Partial<DirectOutgoingTransaction> = {},
): DirectOutgoingTransaction {
  return {
    transactionId: "tx-100",
    time: 100,
    amount: 1,
    resourceType: RESOURCE_CATALYST,
    from: "E6N59",
    to: "E51S9",
    order: {
      id: "buy-x",
      type: ORDER_BUY,
      price: 665.8,
    },
    ...overrides,
  };
}

function dependencies(
  physical: DirectPhysicalSnapshot | undefined = BEFORE,
) {
  const releasePreparedClaims = jest.fn();
  const value: DirectPendingReconcileDependencies = {
    calculateTransactionEnergy: jest.fn((amount: number) =>
      amount === 1 ? 1 : 900,
    ),
    readPhysicalSnapshot: jest.fn(() => physical),
    releasePreparedClaims,
  };
  return { value, releasePreparedClaims };
}

function prepare(
  store = createEmptyDirectPendingStore(),
  baseline: DirectOutgoingTransaction[] = [],
) {
  const pending = prepareDirectPending(store, {
    requestId: "direct-100",
    configRevision: "x-direct-v1",
    directSafetyFingerprint: "fingerprint",
    canaryRoomName: "E6N59",
    resource: RESOURCE_CATALYST,
    orderId: "buy-x",
    orderRoomName: "E51S9",
    observedOrderPrice: 665.8,
    observedOrderAmount: 1_000,
    dealAmount: 1_000,
    transactionEnergy: 900,
    effectiveEnergyShadowPrice: 30,
    energyShadowComponents: {
      hardFloor: 20,
      historyFloor: 30,
      ratchetFloor: 30,
    },
    energyShadowObservedAt: 100,
    netCreditsMilli: 638_800_000,
    worstCaseNetCreditsMilli: 635_800,
    effectiveNetFloor: 600,
    protectionRevision: 100,
    physicalBefore: BEFORE,
    preparedAt: 100,
    attemptAt: 100,
    outgoingWindowBefore: window(100, baseline),
  });
  expect(pending).toBeDefined();
  return { store, pending: pending! };
}

describe("Direct pending WAL", () => {

  it("changed 首观测先于 gap marker 落盘的 CPU cut 恢复为 reconcile_gap", () => {
    const { pending } = prepare();
    const atCpuCut = {
      ...pending,
      status: "submitted",
      submittedAt: 100,
      resultCode: OK,
      firstPostAttemptObservation: {
        observedAt: 101,
        windowCoversAttemptAt: true,
        terminalResourceUnchanged: true,
        terminalEnergyUnchanged: true,
        terminalCooldownUnchanged: true,
        creditsUnchanged: false,
      },
    };

    const recovered = recoverPendingDirectDeal(
      JSON.parse(JSON.stringify(atCpuCut)),
      pending.requestId,
    );

    expect(recovered).toMatchObject({
      requestId: pending.requestId,
      status: "reconcile_gap",
      firstPostAttemptObservation: {
        observedAt: 101,
        creditsUnchanged: false,
      },
    });
  });

  it("confirmed outcome 已落盘但 finalize 中断时可恢复 count、paused、幂等键并最后删除 pending", () => {
    const { store, pending } = prepare();
    const pendingAtCrash = {
      ...pending,
      energyShadowComponents: { ...pending.energyShadowComponents },
      outgoingTransactionKeysBefore: [
        ...pending.outgoingTransactionKeysBefore,
      ],
      successfulMissingObservationTicks: [
        ...pending.successfulMissingObservationTicks,
      ],
    };
    markDirectSubmissionResult(store, "direct-100", {
      kind: "ok",
      tick: 100,
    });
    const deps = dependencies();
    reconcileDirectPendingDeals(
      store,
      { tick: 101, outgoingWindow: window(101, [transaction()]) },
      deps.value,
    );
    const outcome = store.directDealOutcomes[0];

    const recovered = normalizeDirectPendingStore({
      pendingDirectDeals: {
        "direct-100": pendingAtCrash,
      },
      directDealOutcomes: [outcome],
      processedDirectTransactionKeys: [],
      directConfirmedDealCount: 0,
      directPausedForReview: false,
    });

    expect(recovered.pendingDirectDeals).toEqual({});
    expect(recovered.directConfirmedDealCount).toBe(1);
    expect(recovered.directPausedForReview).toBe(true);
    expect(recovered.processedDirectTransactionKeys).toContain(
      "tx-100:buy-x",
    );
  });
});
