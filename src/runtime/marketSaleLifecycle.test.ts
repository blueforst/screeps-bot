import {
  attestPendingCreateOrder,
  canUseCanary,
  createPendingCreateState,
  createPendingMutation,
  hashOrderIds,
  lockCanary,
  markPendingCreateSubmitted,
  markPendingMutationSubmitted,
  reconcilePendingCreate,
  reconcilePendingMutation,
  updateDrainState,
  type MarketOrderSnapshot,
  type OrderMutationLease,
} from "@/runtime/marketSaleLifecycle";

function order(overrides: Partial<MarketOrderSnapshot> = {}): MarketOrderSnapshot {
  return {
    id: "manual-1",
    created: 1_000,
    type: ORDER_SELL,
    resourceType: RESOURCE_KEANIUM,
    roomName: "W1N1",
    price: 100,
    totalAmount: 5_000,
    remainingAmount: 5_000,
    amount: 5_000,
    active: true,
    ...overrides,
  };
}

function lease(baselineIds: string[], overrides: Partial<OrderMutationLease> = {}): OrderMutationLease {
  return {
    epoch: "lease-1",
    grantedAt: 100,
    expiresAt: 200,
    baselineHash: hashOrderIds(baselineIds),
    ...overrides,
  };
}

describe("marketSaleLifecycle", () => {
  it("只在排他租约与不可变 tuple 唯一匹配时认领新订单", () => {
    const baseline = [order()];
    const pending = createPendingCreateState({
      requestId: "req-1",
      gameTime: 120,
      liveOrders: baseline,
      lease: lease(["manual-1"]),
      tuple: {
        type: ORDER_SELL,
        resourceType: RESOURCE_KEANIUM,
        roomName: "W1N1",
        price: 100,
        totalAmount: 5_000,
        createdNotBefore: 1_001,
        createdNotAfter: 1_100,
      },
      feeMilli: 25_000,
      exposure: 5_000,
    });
    expect(pending).not.toBeNull();

    const result = reconcilePendingCreate({
      pending: markPendingCreateSubmitted(pending!),
      gameTime: 121,
      liveOrders: [
        ...baseline,
        order({
          id: "auto-1",
          created: 1_050,
          remainingAmount: 3_000,
          amount: 3_000,
        }),
      ],
      lease: lease(["manual-1"]),
    });

    expect(result.adoptedOrderId).toBe("auto-1");
  });

  it("租约失效时即使 tuple 唯一也要求 operator 明确认领", () => {
    const pending = createPendingCreateState({
      requestId: "req-2",
      gameTime: 120,
      liveOrders: [],
      lease: lease([]),
      tuple: {
        type: ORDER_SELL,
        resourceType: RESOURCE_KEANIUM,
        roomName: "W1N1",
        price: 100,
        totalAmount: 5_000,
        createdNotBefore: 1_001,
        createdNotAfter: 1_100,
      },
      feeMilli: 25_000,
      exposure: 5_000,
    })!;
    const candidate = order({ id: "candidate", created: 1_050 });
    const blocked = reconcilePendingCreate({
      pending,
      liveOrders: [candidate],
      lease: lease([], { revokedAt: 121 }),
      gameTime: 121,
    });
    expect(blocked.adoptedOrderId).toBeUndefined();
    expect(blocked.blockedReason).toBe("lease_invalid");

    const attested = attestPendingCreateOrder({
      pending,
      liveOrders: [candidate],
      orderId: "candidate",
      gameTime: 122,
    });
    expect(attested.adoptedOrderId).toBe("candidate");
  });

  it("零差集必须跨两个不同 tick 才能收敛", () => {
    const pending = createPendingCreateState({
      requestId: "req-3",
      gameTime: 120,
      liveOrders: [],
      lease: lease([]),
      tuple: {
        type: ORDER_SELL,
        resourceType: RESOURCE_KEANIUM,
        roomName: "W1N1",
        price: 100,
        totalAmount: 5_000,
        createdNotBefore: 1_001,
        createdNotAfter: 1_100,
      },
      feeMilli: 25_000,
      exposure: 5_000,
    })!;
    const first = reconcilePendingCreate({
      pending,
      liveOrders: [],
      lease: lease([]),
      gameTime: 121,
    });
    expect(first.resolvedAs).toBeUndefined();
    const sameTick = reconcilePendingCreate({
      pending: first.pending!,
      liveOrders: [],
      lease: lease([]),
      gameTime: 121,
    });
    expect(sameTick.resolvedAs).toBeUndefined();
    const second = reconcilePendingCreate({
      pending: sameTick.pending!,
      liveOrders: [],
      lease: lease([]),
      gameTime: 122,
    });
    expect(second.resolvedAs).toBe("filled_or_absent");
  });

  it("extend 使用 totalAmount 确认并计算并发 fill", () => {
    const pending = markPendingMutationSubmitted(
      createPendingMutation({
        kind: "extend",
        order: order({ totalAmount: 5_000, remainingAmount: 2_000 }),
        gameTime: 100,
        requested: { addAmount: 1_000 },
        prospectiveFeeMilli: 5_000,
        conservativeExposure: 3_000,
      }),
    );
    const result = reconcilePendingMutation({
      pending,
      liveOrder: order({ totalAmount: 6_000, remainingAmount: 2_500 }),
    });
    expect(result.confirmed).toBe(true);
    expect(result.observedFillAmount).toBe(500);
  });

  it("cancel 只有 ID 消失后才确认", () => {
    const pending = createPendingMutation({
      kind: "cancel",
      order: order(),
      gameTime: 100,
      conservativeExposure: 5_000,
    });
    expect(reconcilePendingMutation({ pending, liveOrder: order() }).confirmed).toBe(false);
    expect(reconcilePendingMutation({ pending }).confirmed).toBe(true);
  });

  it("canary lock 不允许跨对象静默改选", () => {
    const first = {
      roomName: "W1N1",
      resourceType: RESOURCE_KEANIUM,
      configRevision: "r1",
      lockedAt: 100,
    };
    expect(lockCanary(undefined, first)).toEqual(first);
    expect(
      lockCanary(first, {
        ...first,
        roomName: "W2N2",
      }),
    ).toBeNull();
    expect(canUseCanary(first, "W1N1", RESOURCE_KEANIUM, "r1")).toBe(true);
  });

  it("off 必须跨 tick 确认全部 pending 与 exposure 归零", () => {
    const initial = {
      phase: "maker" as const,
      zeroConfirmations: 0,
    };
    const requested = updateDrainState({
      state: initial,
      desiredMode: "off",
      gameTime: 100,
      knownManagedIdsPresent: 1,
      pendingCreateCount: 0,
      pendingMutationCount: 0,
      stagingAmount: 0,
      reservationAmount: 0,
      exposureAmount: 5_000,
      reconcileGapCount: 0,
    });
    expect(requested.phase).toBe("requested");

    const firstZero = updateDrainState({
      state: requested,
      desiredMode: "off",
      gameTime: 101,
      knownManagedIdsPresent: 0,
      pendingCreateCount: 0,
      pendingMutationCount: 0,
      stagingAmount: 0,
      reservationAmount: 0,
      exposureAmount: 0,
      reconcileGapCount: 0,
    });
    expect(firstZero.phase).toBe("draining");
    const sameTick = updateDrainState({
      state: firstZero,
      desiredMode: "off",
      gameTime: 101,
      knownManagedIdsPresent: 0,
      pendingCreateCount: 0,
      pendingMutationCount: 0,
      stagingAmount: 0,
      reservationAmount: 0,
      exposureAmount: 0,
      reconcileGapCount: 0,
    });
    expect(sameTick.phase).toBe("draining");
    const stopped = updateDrainState({
      state: sameTick,
      desiredMode: "off",
      gameTime: 102,
      knownManagedIdsPresent: 0,
      pendingCreateCount: 0,
      pendingMutationCount: 0,
      stagingAmount: 0,
      reservationAmount: 0,
      exposureAmount: 0,
      reconcileGapCount: 0,
    });
    expect(stopped.phase).toBe("off");
  });

  it("fee reconcile gap 即使订单已消失也阻止 drain 宣称 off", () => {
    const state = updateDrainState({
      state: { phase: "requested", zeroConfirmations: 0 },
      desiredMode: "off",
      gameTime: 100,
      knownManagedIdsPresent: 0,
      pendingCreateCount: 0,
      pendingMutationCount: 0,
      stagingAmount: 0,
      reservationAmount: 0,
      exposureAmount: 0,
      reconcileGapCount: 1,
    });

    expect(state.phase).toBe("draining");
    expect(state.zeroConfirmations).toBe(0);
  });

  it("Direct active 使用独立 phase，不得误归类为 Maker", () => {
    const state = updateDrainState({
      state: { phase: "shadow", zeroConfirmations: 0 },
      desiredMode: "direct",
      gameTime: 100,
      knownManagedIdsPresent: 0,
      pendingCreateCount: 0,
      pendingMutationCount: 0,
      stagingAmount: 0,
      reservationAmount: 0,
      exposureAmount: 0,
      reconcileGapCount: 0,
    });

    expect(state).toEqual({ phase: "direct", zeroConfirmations: 0 });
  });
});
