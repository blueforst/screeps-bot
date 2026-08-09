import {
  createEmptyDirectPendingStore,
  isRecoverableDirectDealOutcome,
  isRecoverableDirectPendingStoreShape,
  isRecoverablePendingDirectDeal,
  markDirectSubmissionResult,
  normalizeDirectPendingStore,
  prepareDirectPending,
  recoverPendingDirectDeal,
  reconcileDirectPendingDeals,
  resolveDirectPendingWithEvidence,
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

  it("submitted marker 先于 submittedAt 落盘的 CPU cut 恢复为 prepared", () => {
    const { pending } = prepare();
    const atCpuCut = {
      ...pending,
      status: "submitted",
      resultCode: OK,
    };

    const recovered = recoverPendingDirectDeal(
      JSON.parse(JSON.stringify(atCpuCut)),
      pending.requestId,
    );

    expect(recovered).toMatchObject({
      requestId: pending.requestId,
      status: "prepared",
      resultCode: OK,
    });
    expect(recovered?.submittedAt).toBeUndefined();
  });

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

  it("operator exact transaction 复用确认 finalize，重复 resolution 不重复计数", () => {
    const { store } = prepare();
    store.pendingDirectDeals["direct-100"].status = "reconcile_gap";
    const deps = dependencies();
    const evidence = {
      kind: "transaction" as const,
      requestId: "direct-100",
      orderId: "buy-x",
      operator: "forst",
      transaction: transaction(),
    };

    expect(
      resolveDirectPendingWithEvidence(
        store,
        evidence,
        103,
        deps.value,
      ),
    ).toEqual({ ok: true });
    expect(store.directConfirmedDealCount).toBe(1);
    expect(store.directPausedForReview).toBe(true);
    expect(deps.releasePreparedClaims).toHaveBeenCalledWith(
      "direct-100",
    );
    expect(
      resolveDirectPendingWithEvidence(
        store,
        evidence,
        104,
        deps.value,
      ),
    ).toEqual({ ok: true, duplicate: true });
    expect(store.directConfirmedDealCount).toBe(1);
  });

  it("operator no-fill 仅接受有界当前窗口，且 exact 重复 resolution 幂等", () => {
    const { store } = prepare();
    store.pendingDirectDeals["direct-100"].status = "reconcile_gap";
    const deps = dependencies();
    const evidence = {
      kind: "not_filled" as const,
      requestId: "direct-100",
      orderId: "buy-x",
      operator: "forst",
      window: window(103),
      physical: BEFORE,
    };

    expect(
      resolveDirectPendingWithEvidence(
        store,
        evidence,
        103,
        deps.value,
      ),
    ).toEqual({ ok: true });
    expect(store.pendingDirectDeals).toEqual({});
    expect(store.directDealOutcomes[0]).toMatchObject({
      status: "not_filled",
      resolvedAt: 103,
      evidenceSource: "operator",
      evidenceKey: "operator-window:103:0",
      operator: "forst",
    });
    expect(
      isRecoverableDirectDealOutcome(store.directDealOutcomes[0]),
    ).toBe(true);
    expect(
      resolveDirectPendingWithEvidence(
        store,
        evidence,
        104,
        deps.value,
      ),
    ).toEqual({ ok: true, duplicate: true });
  });

  it("operator no-fill 同时间同条数但内容或物理快照变化时必须冲突暂停", () => {
    const { store } = prepare();
    store.pendingDirectDeals["direct-100"].status = "reconcile_gap";
    const deps = dependencies();
    const unrelated = transaction({
      transactionId: "unrelated",
      time: 99,
      order: {
        id: "other-order",
        type: ORDER_BUY,
        price: 1,
      },
    });
    const evidence = {
      kind: "not_filled" as const,
      requestId: "direct-100",
      orderId: "buy-x",
      operator: "forst",
      window: window(103, [unrelated]),
      physical: BEFORE,
    };

    expect(
      resolveDirectPendingWithEvidence(
        store,
        evidence,
        103,
        deps.value,
      ),
    ).toEqual({ ok: true });
    expect(
      resolveDirectPendingWithEvidence(
        store,
        evidence,
        104,
        deps.value,
      ),
    ).toEqual({ ok: true, duplicate: true });

    expect(
      resolveDirectPendingWithEvidence(
        store,
        {
          ...evidence,
          window: window(103, [transaction()]),
        },
        104,
        deps.value,
      ),
    ).toEqual({
      ok: false,
      error: "direct_operator_evidence_conflict",
    });
    expect(store.directPausedForReview).toBe(true);
  });
});
