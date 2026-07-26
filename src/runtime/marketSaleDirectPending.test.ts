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
  it("持久 pending 的缺失观测 tick 必须唯一递增且晚于 attempt", () => {
    const { store, pending } = prepare();
    markDirectSubmissionResult(store, pending.requestId, {
      kind: "ok",
      tick: 100,
      resultCode: OK,
    });
    reconcileDirectPendingDeals(
      store,
      { tick: 101, outgoingWindow: window(101) },
      dependencies().value,
    );
    expect(isRecoverablePendingDirectDeal(pending, pending.requestId)).toBe(
      true,
    );

    expect(
      isRecoverablePendingDirectDeal(
        {
          ...pending,
          successfulMissingObservationTicks: [100],
        },
        pending.requestId,
      ),
    ).toBe(false);
    expect(
      isRecoverablePendingDirectDeal(
        {
          ...pending,
          successfulMissingObservationTicks: [101, 101],
        },
        pending.requestId,
      ),
    ).toBe(false);
    expect(
      isRecoverablePendingDirectDeal(
        {
          ...pending,
          firstPostAttemptObservation: undefined,
          successfulMissingObservationTicks: [101],
        },
        pending.requestId,
      ),
    ).toBe(false);
  });

  it("首物理观测写入后 CPU 中断也不能把已变化状态恢复成 not-filled", () => {
    const { store, pending } = prepare();
    markDirectSubmissionResult(store, pending.requestId, {
      kind: "ok",
      tick: 100,
      resultCode: OK,
    });
    pending.firstPostAttemptObservation = {
      observedAt: 101,
      windowCoversAttemptAt: true,
      terminalResourceUnchanged: true,
      terminalEnergyUnchanged: true,
      terminalCooldownUnchanged: true,
      creditsUnchanged: false,
    };
    expect(isRecoverablePendingDirectDeal(pending, pending.requestId)).toBe(
      false,
    );

    const result = reconcileDirectPendingDeals(
      store,
      { tick: 102, outgoingWindow: window(102) },
      dependencies().value,
    );
    expect(result.rejectedByReason).toHaveProperty(
      "direct_first_physical_state_changed",
    );
    expect(pending.status).toBe("reconcile_gap");
    expect(pending.successfulMissingObservationTicks).toEqual([]);
    expect(store.directDealOutcomes).toEqual([]);
  });

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

  it("unchanged 首观测落盘但 missing tick 未落盘时可恢复原 tick 证据", () => {
    const { store, pending } = prepare();
    markDirectSubmissionResult(store, pending.requestId, {
      kind: "ok",
      tick: 100,
      resultCode: OK,
    });
    pending.firstPostAttemptObservation = {
      observedAt: 101,
      windowCoversAttemptAt: true,
      terminalResourceUnchanged: true,
      terminalEnergyUnchanged: true,
      terminalCooldownUnchanged: true,
      creditsUnchanged: true,
    };
    const recoveredStore = normalizeDirectPendingStore(
      JSON.parse(JSON.stringify(store)),
    );

    const result = reconcileDirectPendingDeals(
      recoveredStore,
      { tick: 102, outgoingWindow: window(102) },
      dependencies().value,
    );

    expect(result.resolved).toBe(1);
    expect(recoveredStore.pendingDirectDeals).toEqual({});
    expect(recoveredStore.directDealOutcomes[0]).toMatchObject({
      status: "not_filled",
      evidenceKey: "missing:101,102",
    });
  });

  it("提交 1000 实际成交 1 时只确认一次并释放整笔 exposure", () => {
    const { store } = prepare();
    markDirectSubmissionResult(store, "direct-100", {
      kind: "ok",
      tick: 100,
      resultCode: OK,
    });
    const deps = dependencies();

    const result = reconcileDirectPendingDeals(
      store,
      { tick: 101, outgoingWindow: window(101, [transaction()]) },
      deps.value,
    );

    expect(result.confirmed).toBe(1);
    expect(store.pendingDirectDeals).toEqual({});
    expect(store.directConfirmedDealCount).toBe(1);
    expect(store.directPausedForReview).toBe(true);
    expect(store.directDealOutcomes).toEqual([
      expect.objectContaining({
        status: "confirmed",
        configRevision: "x-direct-v1",
        canaryRoomName: "E6N59",
        resource: RESOURCE_CATALYST,
        orderRoomName: "E51S9",
        observedOrderPrice: 665.8,
        submittedDealAmount: 1_000,
        effectiveEnergyShadowPrice: 30,
        effectiveNetFloor: 600,
        transactionId: "tx-100",
        transactionTime: 100,
        actualOrderType: ORDER_BUY,
        actualOrderPrice: 665.8,
        actualResource: RESOURCE_CATALYST,
        actualFrom: "E6N59",
        actualTo: "E51S9",
        actualAmount: 1,
        actualTransactionEnergy: 1,
        actualNetCreditsMilli: 635_800,
        evidenceSource: "automatic",
        evidenceKey: "tx-100:buy-x",
      }),
    ]);
    expect(deps.releasePreparedClaims).toHaveBeenCalledWith("direct-100");

    reconcileDirectPendingDeals(
      store,
      { tick: 102, outgoingWindow: window(102, [transaction()]) },
      deps.value,
    );
    expect(store.directConfirmedDealCount).toBe(1);
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

  it("outcome 只有与完整冻结 pending 指纹一致时才可恢复并删除 WAL", () => {
    const confirmedPrepared = prepare();
    const confirmedPending = {
      ...confirmedPrepared.pending,
      energyShadowComponents: {
        ...confirmedPrepared.pending.energyShadowComponents,
      },
      outgoingTransactionKeysBefore: [
        ...confirmedPrepared.pending.outgoingTransactionKeysBefore,
      ],
      successfulMissingObservationTicks: [],
    };
    markDirectSubmissionResult(
      confirmedPrepared.store,
      confirmedPrepared.pending.requestId,
      { kind: "ok", tick: 100, resultCode: OK },
    );
    reconcileDirectPendingDeals(
      confirmedPrepared.store,
      { tick: 101, outgoingWindow: window(101, [transaction()]) },
      dependencies().value,
    );

    const failedPrepared = prepare();
    const failedPending = {
      ...failedPrepared.pending,
      energyShadowComponents: {
        ...failedPrepared.pending.energyShadowComponents,
      },
      outgoingTransactionKeysBefore: [
        ...failedPrepared.pending.outgoingTransactionKeysBefore,
      ],
      successfulMissingObservationTicks: [],
    };
    markDirectSubmissionResult(
      failedPrepared.store,
      failedPrepared.pending.requestId,
      {
        kind: "non_ok",
        tick: 100,
        resultCode: ERR_INVALID_ARGS,
      },
    );

    const notFilledPrepared = prepare();
    markDirectSubmissionResult(
      notFilledPrepared.store,
      notFilledPrepared.pending.requestId,
      { kind: "ok", tick: 100, resultCode: OK },
    );
    reconcileDirectPendingDeals(
      notFilledPrepared.store,
      { tick: 101, outgoingWindow: window(101) },
      dependencies().value,
    );
    const notFilledPending = {
      ...notFilledPrepared.pending,
      energyShadowComponents: {
        ...notFilledPrepared.pending.energyShadowComponents,
      },
      outgoingTransactionKeysBefore: [
        ...notFilledPrepared.pending.outgoingTransactionKeysBefore,
      ],
      successfulMissingObservationTicks: [
        ...notFilledPrepared.pending.successfulMissingObservationTicks,
      ],
      firstPostAttemptObservation: {
        ...notFilledPrepared.pending.firstPostAttemptObservation!,
      },
    };
    reconcileDirectPendingDeals(
      notFilledPrepared.store,
      { tick: 102, outgoingWindow: window(102) },
      dependencies().value,
    );

    const cases = [
      {
        name: "confirmed",
        pending: confirmedPending,
        outcome: {
          ...confirmedPrepared.store.directDealOutcomes[0],
          observedOrderAmount: 1_001,
        },
      },
      {
        name: "failed",
        pending: failedPending,
        outcome: {
          ...failedPrepared.store.directDealOutcomes[0],
          configRevision: "forged-revision",
        },
      },
      {
        name: "not-filled",
        pending: notFilledPending,
        outcome: {
          ...notFilledPrepared.store.directDealOutcomes[0],
          orderRoomName: "E50S9",
        },
      },
    ];
    for (const sample of cases) {
      expect(
        isRecoverableDirectDealOutcome(sample.outcome),
      ).toBe(true);
      const raw = {
        pendingDirectDeals: {
          [sample.pending.requestId]: sample.pending,
        },
        directDealOutcomes: [sample.outcome],
        processedDirectTransactionKeys: [],
        directConfirmedDealCount: 0,
        directPausedForReview: false,
      };
      expect(isRecoverableDirectPendingStoreShape(raw)).toBe(false);
      expect(
        normalizeDirectPendingStore(raw).pendingDirectDeals[
          sample.pending.requestId
        ],
      ).toBeDefined();
    }
  });

  it("confirmed、failed、not-filled 的完整 outcome 均可通过恢复形状校验", () => {
    const outcomes = [
      (() => {
        const sample = prepare();
        const pending = {
          ...sample.pending,
          energyShadowComponents: {
            ...sample.pending.energyShadowComponents,
          },
          outgoingTransactionKeysBefore: [
            ...sample.pending.outgoingTransactionKeysBefore,
          ],
          successfulMissingObservationTicks: [],
        };
        markDirectSubmissionResult(sample.store, pending.requestId, {
          kind: "ok",
          tick: 100,
          resultCode: OK,
        });
        reconcileDirectPendingDeals(
          sample.store,
          { tick: 101, outgoingWindow: window(101, [transaction()]) },
          dependencies().value,
        );
        return { pending, outcome: sample.store.directDealOutcomes[0] };
      })(),
      (() => {
        const sample = prepare();
        const pending = {
          ...sample.pending,
          energyShadowComponents: {
            ...sample.pending.energyShadowComponents,
          },
          outgoingTransactionKeysBefore: [
            ...sample.pending.outgoingTransactionKeysBefore,
          ],
          successfulMissingObservationTicks: [],
        };
        markDirectSubmissionResult(sample.store, pending.requestId, {
          kind: "non_ok",
          tick: 100,
          resultCode: ERR_INVALID_ARGS,
        });
        return { pending, outcome: sample.store.directDealOutcomes[0] };
      })(),
      (() => {
        const sample = prepare();
        markDirectSubmissionResult(sample.store, sample.pending.requestId, {
          kind: "ok",
          tick: 100,
          resultCode: OK,
        });
        reconcileDirectPendingDeals(
          sample.store,
          { tick: 101, outgoingWindow: window(101) },
          dependencies().value,
        );
        const pending = {
          ...sample.pending,
          energyShadowComponents: {
            ...sample.pending.energyShadowComponents,
          },
          outgoingTransactionKeysBefore: [
            ...sample.pending.outgoingTransactionKeysBefore,
          ],
          successfulMissingObservationTicks: [
            ...sample.pending.successfulMissingObservationTicks,
          ],
          firstPostAttemptObservation: {
            ...sample.pending.firstPostAttemptObservation!,
          },
        };
        reconcileDirectPendingDeals(
          sample.store,
          { tick: 102, outgoingWindow: window(102) },
          dependencies().value,
        );
        return { pending, outcome: sample.store.directDealOutcomes[0] };
      })(),
    ];

    for (const sample of outcomes) {
      const raw = {
        pendingDirectDeals: {
          [sample.pending.requestId]: sample.pending,
        },
        directDealOutcomes: [sample.outcome],
        processedDirectTransactionKeys: [],
        directConfirmedDealCount: 0,
        directPausedForReview: false,
      };
      expect(isRecoverableDirectDealOutcome(sample.outcome)).toBe(true);
      expect(isRecoverableDirectPendingStoreShape(raw)).toBe(true);
      expect(normalizeDirectPendingStore(raw).pendingDirectDeals).toEqual(
        {},
      );
    }
  });

  it("恢复形状拒绝状态冲突字段、重复 request 和超界审计数组", () => {
    const failedSample = prepare();
    markDirectSubmissionResult(
      failedSample.store,
      failedSample.pending.requestId,
      {
        kind: "non_ok",
        tick: 100,
        resultCode: ERR_INVALID_ARGS,
      },
    );
    const failedOutcome =
      failedSample.store.directDealOutcomes[0];
    expect(
      isRecoverableDirectDealOutcome({
        ...failedOutcome,
        transactionId: "forged-transaction",
      }),
    ).toBe(false);

    const notFilledSample = prepare();
    markDirectSubmissionResult(
      notFilledSample.store,
      notFilledSample.pending.requestId,
      { kind: "ok", tick: 100, resultCode: OK },
    );
    reconcileDirectPendingDeals(
      notFilledSample.store,
      { tick: 101, outgoingWindow: window(101) },
      dependencies().value,
    );
    reconcileDirectPendingDeals(
      notFilledSample.store,
      { tick: 102, outgoingWindow: window(102) },
      dependencies().value,
    );
    const notFilledOutcome =
      notFilledSample.store.directDealOutcomes[0];
    expect(
      isRecoverableDirectDealOutcome({
        ...notFilledOutcome,
        actualAmount: 1,
      }),
    ).toBe(false);

    const base = {
      pendingDirectDeals: {},
      processedDirectTransactionKeys: [],
      directConfirmedDealCount: 0,
      directPausedForReview: false,
    };
    expect(
      isRecoverableDirectPendingStoreShape({
        ...base,
        directDealOutcomes: [failedOutcome, failedOutcome],
      }),
    ).toBe(false);
    expect(
      isRecoverableDirectPendingStoreShape({
        ...base,
        directDealOutcomes: Array.from(
          { length: 51 },
          (_, index) => ({
            ...failedOutcome,
            requestId: `direct-${index}`,
          }),
        ),
      }),
    ).toBe(false);
    expect(
      isRecoverableDirectPendingStoreShape({
        ...base,
        directDealOutcomes: [],
        processedDirectTransactionKeys: Array.from(
          { length: 201 },
          (_, index) => `tx-${index}:buy-x`,
        ),
      }),
    ).toBe(false);
  });

  it("null、primitive 或 array outcome 必须稳定 fail-closed 且归一化不抛错", () => {
    for (const invalidOutcome of [null, undefined, 7, "bad", []]) {
      const raw = {
        pendingDirectDeals: {},
        directDealOutcomes: [invalidOutcome],
        processedDirectTransactionKeys: [],
        directConfirmedDealCount: 0,
        directPausedForReview: false,
      };
      expect(() =>
        isRecoverableDirectPendingStoreShape(raw),
      ).not.toThrow();
      expect(isRecoverableDirectPendingStoreShape(raw)).toBe(false);
      expect(() =>
        normalizeDirectPendingStore(raw as never),
      ).not.toThrow();
      expect(
        normalizeDirectPendingStore(raw as never)
          .directPausedForReview,
      ).toBe(false);
    }
  });

  it("缺失或损坏的 pending/quarantine 容器必须持久隔离 sentinel", () => {
    const base = {
      directDealOutcomes: [],
      processedDirectTransactionKeys: [],
      directConfirmedDealCount: 0,
      directPausedForReview: false,
    };
    const missingPending = normalizeDirectPendingStore(
      base as never,
    );
    expect(
      missingPending.quarantinedPendingDirectDeals,
    ).toEqual({
      __pending_direct_deals_container__:
        "missing_pending_direct_deals_container",
    });

    const corruptContainers = normalizeDirectPendingStore({
      ...base,
      pendingDirectDeals: null,
      quarantinedPendingDirectDeals: [],
    } as never);
    expect(
      corruptContainers.quarantinedPendingDirectDeals,
    ).toEqual({
      __pending_direct_deals_container__: null,
      __quarantine_container__: [],
    });
  });

  it("第二个 missing tick 落盘后 CPU 中断可按原两次证据恢复，不替换首 tick", () => {
    const { store, pending } = prepare();
    markDirectSubmissionResult(store, pending.requestId, {
      kind: "ok",
      tick: 100,
      resultCode: OK,
    });
    reconcileDirectPendingDeals(
      store,
      { tick: 101, outgoingWindow: window(101) },
      dependencies().value,
    );
    pending.successfulMissingObservationTicks.push(102);
    expect(isRecoverablePendingDirectDeal(pending, pending.requestId)).toBe(
      true,
    );

    const result = reconcileDirectPendingDeals(
      store,
      { tick: 103, outgoingWindow: window(103) },
      dependencies().value,
    );

    expect(result.resolved).toBe(1);
    expect(store.pendingDirectDeals).toEqual({});
    expect(store.directDealOutcomes[0]).toMatchObject({
      status: "not_filled",
      resolvedAt: 102,
      evidenceSource: "automatic",
      evidenceKey: "missing:101,102",
    });
    expect(
      isRecoverableDirectDealOutcome(store.directDealOutcomes[0]),
    ).toBe(true);
  });

  it("baseline 中的旧同 tuple 交易不能确认新 intent", () => {
    const old = transaction({ transactionId: "old", time: 100 });
    const { store } = prepare(createEmptyDirectPendingStore(), [old]);
    markDirectSubmissionResult(store, "direct-100", {
      kind: "ok",
      tick: 100,
    });
    const deps = dependencies();

    reconcileDirectPendingDeals(
      store,
      { tick: 101, outgoingWindow: window(101, [old]) },
      deps.value,
    );
    expect(store.pendingDirectDeals["direct-100"]).toMatchObject({
      successfulMissingObservationTicks: [101],
    });
    reconcileDirectPendingDeals(
      store,
      { tick: 102, outgoingWindow: window(102, [old]) },
      deps.value,
    );
    expect(store.directDealOutcomes[0]).toMatchObject({
      status: "not_filled",
    });
    expect(store.directConfirmedDealCount).toBe(0);
  });

  it("同 attempt/order 出现多条记录进入 reconcile gap", () => {
    const { store } = prepare();
    markDirectSubmissionResult(store, "direct-100", {
      kind: "ok",
      tick: 100,
    });
    const deps = dependencies();
    const result = reconcileDirectPendingDeals(
      store,
      {
        tick: 101,
        outgoingWindow: window(101, [
          transaction({ transactionId: "tx-a" }),
          transaction({ transactionId: "tx-b" }),
        ]),
      },
      deps.value,
    );

    expect(result.gaps).toBe(1);
    expect(store.pendingDirectDeals["direct-100"].status).toBe(
      "reconcile_gap",
    );
  });

  it("跳过 attemptAt+1 首个物理观测时不得猜测 not-filled", () => {
    const { store } = prepare();
    markDirectSubmissionResult(store, "direct-100", {
      kind: "ok",
      tick: 100,
    });
    const deps = dependencies();

    const result = reconcileDirectPendingDeals(
      store,
      { tick: 102, outgoingWindow: window(102) },
      deps.value,
    );

    expect(result.rejectedByReason).toHaveProperty(
      "direct_first_observation_tick_missed",
    );
    expect(store.pendingDirectDeals["direct-100"].status).toBe(
      "reconcile_gap",
    );
  });

  it("缓存的 outgoing window 即使内容完整也不能作为当前 tick 对账证据", () => {
    const { store } = prepare();
    markDirectSubmissionResult(store, "direct-100", {
      kind: "ok",
      tick: 100,
    });
    const result = reconcileDirectPendingDeals(
      store,
      {
        tick: 101,
        outgoingWindow: window(100, [transaction()]),
      },
      dependencies().value,
    );

    expect(result.rejectedByReason).toHaveProperty(
      "direct_outgoing_window_stale",
    );
    expect(store.pendingDirectDeals["direct-100"].status).toBe(
      "reconcile_gap",
    );
  });

  it("窗口未严格覆盖 attempt tick 时不得判定 not-filled", () => {
    const { store } = prepare();
    markDirectSubmissionResult(store, "direct-100", {
      kind: "ok",
      tick: 100,
    });
    const result = reconcileDirectPendingDeals(
      store,
      {
        tick: 101,
        outgoingWindow: window(101, [], false),
      },
      dependencies().value,
    );

    expect(result.rejectedByReason).toHaveProperty(
      "direct_outgoing_window_truncated",
    );
    expect(store.pendingDirectDeals["direct-100"].status).toBe(
      "reconcile_gap",
    );
  });

  it("首 tick 四项前态任一变化都进入 gap", () => {
    const { store } = prepare();
    markDirectSubmissionResult(store, "direct-100", {
      kind: "ok",
      tick: 100,
    });
    const deps = dependencies({ ...BEFORE, credits: BEFORE.credits + 1 });

    reconcileDirectPendingDeals(
      store,
      { tick: 101, outgoingWindow: window(101) },
      deps.value,
    );

    expect(store.pendingDirectDeals["direct-100"].status).toBe(
      "reconcile_gap",
    );
  });

  it("deal 抛错后保留 prepared，跨 tick 只对账不重提", () => {
    const { store } = prepare();
    markDirectSubmissionResult(store, "direct-100", {
      kind: "threw",
      tick: 100,
    });
    expect(store.pendingDirectDeals["direct-100"].status).toBe("prepared");
    const deps = dependencies();

    reconcileDirectPendingDeals(
      store,
      { tick: 101, outgoingWindow: window(101, [transaction()]) },
      deps.value,
    );

    expect(store.directDealOutcomes[0]).toMatchObject({
      status: "confirmed",
      actualAmount: 1,
    });
  });

  it("明确 non-OK 记录 failed 并立即删除 active pending", () => {
    const { store } = prepare();
    markDirectSubmissionResult(store, "direct-100", {
      kind: "non_ok",
      tick: 100,
      resultCode: ERR_INVALID_ARGS,
    });

    expect(store.pendingDirectDeals).toEqual({});
    expect(store.directDealOutcomes[0]).toMatchObject({
      status: "failed",
      resultCode: ERR_INVALID_ARGS,
    });
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

  it("operator no-fill 的未来、超界、损坏窗口不得删除 pending 或释放 exposure", () => {
    const { store } = prepare();
    store.pendingDirectDeals["direct-100"].status = "reconcile_gap";
    const deps = dependencies();
    const base = {
      kind: "not_filled" as const,
      requestId: "direct-100",
      orderId: "buy-x",
      operator: "forst",
      physical: BEFORE,
    };
    const invalidCases = [
      {
        ...base,
        window: window(999),
      },
      {
        ...base,
        window: {
          ...window(103),
          observedAt: Number.NaN,
        },
      },
      {
        ...base,
        window: window(
          103,
          Array.from({ length: 101 }, (_, index) =>
            transaction({
              transactionId: `other-${index}`,
              time: 99,
              order: undefined,
            }),
          ),
        ),
      },
      {
        ...base,
        window: {
          ...window(103),
          transactions: [null],
        },
      },
    ];

    for (const evidence of invalidCases) {
      expect(() =>
        resolveDirectPendingWithEvidence(
          store,
          evidence as never,
          103,
          deps.value,
        ),
      ).not.toThrow();
      expect(
        resolveDirectPendingWithEvidence(
          store,
          evidence as never,
          103,
          deps.value,
        ),
      ).toEqual({
        ok: false,
        error: "direct_operator_evidence_invalid",
      });
      expect(store.pendingDirectDeals["direct-100"]).toBeDefined();
      expect(store.directDealOutcomes).toEqual([]);
    }
    expect(deps.releasePreparedClaims).not.toHaveBeenCalled();
  });

  it("resolved outcome 只把相同证据视为幂等，迟到或冲突证据会不可逆暂停", () => {
    const confirmed = prepare();
    confirmed.store.pendingDirectDeals["direct-100"].status =
      "reconcile_gap";
    const confirmedDeps = dependencies();
    const firstTransactionEvidence = {
      kind: "transaction" as const,
      requestId: "direct-100",
      orderId: "buy-x",
      operator: "forst",
      transaction: transaction(),
    };
    expect(
      resolveDirectPendingWithEvidence(
        confirmed.store,
        firstTransactionEvidence,
        103,
        confirmedDeps.value,
      ),
    ).toEqual({ ok: true });
    expect(
      resolveDirectPendingWithEvidence(
        confirmed.store,
        {
          ...firstTransactionEvidence,
          transaction: transaction({
            transactionId: "tx-conflict",
          }),
        },
        104,
        confirmedDeps.value,
      ),
    ).toEqual({
      ok: false,
      error: "direct_operator_evidence_conflict",
    });
    expect(confirmed.store.directPausedForReview).toBe(true);

    const notFilled = prepare();
    markDirectSubmissionResult(notFilled.store, "direct-100", {
      kind: "ok",
      tick: 100,
      resultCode: OK,
    });
    reconcileDirectPendingDeals(
      notFilled.store,
      { tick: 101, outgoingWindow: window(101) },
      dependencies().value,
    );
    reconcileDirectPendingDeals(
      notFilled.store,
      { tick: 102, outgoingWindow: window(102) },
      dependencies().value,
    );
    expect(notFilled.store.directPausedForReview).toBe(false);
    expect(
      resolveDirectPendingWithEvidence(
        notFilled.store,
        firstTransactionEvidence,
        103,
        dependencies().value,
      ),
    ).toEqual({
      ok: false,
      error: "direct_operator_evidence_conflict",
    });
    expect(notFilled.store.directPausedForReview).toBe(true);

    const failed = prepare();
    markDirectSubmissionResult(failed.store, "direct-100", {
      kind: "non_ok",
      tick: 100,
      resultCode: ERR_INVALID_ARGS,
    });
    expect(
      resolveDirectPendingWithEvidence(
        failed.store,
        firstTransactionEvidence,
        103,
        dependencies().value,
      ),
    ).toEqual({
      ok: false,
      error: "direct_operator_evidence_conflict",
    });
    expect(failed.store.directPausedForReview).toBe(true);
  });

  it("operator malformed evidence 默认拒绝且不会抛错或释放 exposure", () => {
    const { store } = prepare();
    store.pendingDirectDeals["direct-100"].status = "reconcile_gap";
    const deps = dependencies();

    expect(
      resolveDirectPendingWithEvidence(
        store,
        {
          kind: "not_filled",
          requestId: "direct-100",
          orderId: "buy-x",
          operator: "forst",
        } as never,
        103,
        deps.value,
      ),
    ).toEqual({
      ok: false,
      error: "direct_operator_evidence_invalid",
    });
    expect(store.pendingDirectDeals["direct-100"]).toBeDefined();
    expect(store.directDealOutcomes).toEqual([]);
  });
});
