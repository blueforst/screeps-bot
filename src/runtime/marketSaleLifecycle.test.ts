import {
  attestPendingCreateOrder,
  createPendingCreateState,
  hashOrderIds,
  reconcilePendingCreate,
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
});
