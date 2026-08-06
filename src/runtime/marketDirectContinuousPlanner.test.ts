import {
  isExactMarketDirectContinuousSecondRead,
  MARKET_DIRECT_CONTINUOUS_MAX_DISTINCT_ORDER_ROOMS,
  MARKET_DIRECT_CONTINUOUS_MAX_SELLER_ROOMS,
  MARKET_DIRECT_CONTINUOUS_MAX_TRANSACTION_ENERGY_EVALUATIONS,
  MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
  planMarketDirectContinuous,
  type MarketDirectContinuousEntryInput,
  type PlanMarketDirectContinuousInput,
} from "@/runtime/marketDirectContinuousPlanner";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";

function order(
  id: string,
  resourceType: string,
  price: number,
  amount = 1_000,
  roomName = "E20S20",
): MarketOrderSnapshot {
  return {
    id,
    type: "buy",
    resourceType,
    price,
    amount,
    roomName,
  };
}

const ENTRY_DEFAULTS = {
  X: {
    roomName: "E6N59",
    hardNetFloor: 600,
    economicNetFloor: 600,
    minExecutableNotional: 600_000,
    cap: 8_000,
    requireNativeMineral: false,
  },
  H: {
    roomName: "E3N59",
    hardNetFloor: 428,
    economicNetFloor: 451,
    minExecutableNotional: 451_000,
    cap: 8_000,
    requireNativeMineral: true,
  },
  Z: {
    roomName: "E7N57",
    hardNetFloor: 43,
    economicNetFloor: 45,
    minExecutableNotional: 45_000,
    cap: 5_000,
    requireNativeMineral: true,
  },
} as const;

function entry(
  resourceType: keyof typeof ENTRY_DEFAULTS,
  orders: readonly MarketOrderSnapshot[],
  overrides: {
    roomName?: string;
    energy?: (amount: number, candidate: MarketOrderSnapshot, room: string) => number;
    confirmedAmount?: number;
    opportunityReserveSatisfied?: boolean;
    rawLimit?: number;
    eligibleLimit?: number;
  } = {},
): MarketDirectContinuousEntryInput {
  const defaults = ENTRY_DEFAULTS[resourceType];
  const roomName = overrides.roomName ?? defaults.roomName;
  return {
    policy: {
      entryId: `base-${resourceType.toLowerCase()}-${roomName.toLowerCase()}-v1`,
      revision: `${resourceType}-policy-v1`,
      resourceType,
      allowedRooms: [roomName],
      requireNativeMineral: defaults.requireNativeMineral,
      grant: "continuous",
      hardNetFloor: defaults.hardNetFloor,
      economicNetFloor: defaults.economicNetFloor,
      minExecutableNotional: defaults.minExecutableNotional,
      maxRawOrders: overrides.rawLimit ?? 1_000,
      maxEligibleOrders: overrides.eligibleLimit ?? 200,
      maxTransactionEnergy: 1_000,
      terminalEnergyReserve: 25_000,
      resourceRollingCap: defaults.cap,
      opportunityReserve: 1_000,
    },
    quota: {
      complete: true,
      revision: `${resourceType}-quota-v1`,
      resourceType,
      rollingCap: defaults.cap,
      confirmedAmount: overrides.confirmedAmount ?? 0,
      unmatchedPlannedAmount: 0,
      opportunityReserveSatisfied:
        overrides.opportunityReserveSatisfied ?? false,
    },
    lanes: [{
      lane: {
        roomName,
        resourceType,
        owned: true,
        hub: false,
        capacityEmergency: false,
        nativeMineralType: defaults.requireNativeMineral
          ? resourceType
          : "O",
      },
      protection: {
        complete: true,
        revision: `${resourceType}-protection-v1`,
        sellableAmount: 100_000,
      },
      terminal: {
        revision: `${resourceType}-terminal-v1`,
        normal: true,
        ready: true,
        claimed: false,
        cooldown: 0,
        resourceAmount: 50_000,
        energy: 50_000,
      },
      book: {
        complete: true,
        revision: `${resourceType}-book-v1`,
        orders,
        ownOrderIds: [],
      },
      calculateTransactionEnergy: overrides.energy ?? ((amount) =>
        amount === 1 ? 1 : 100),
    }],
  };
}

function planningInput(
  entries: readonly MarketDirectContinuousEntryInput[],
  globalOverrides: Partial<PlanMarketDirectContinuousInput["globalQuota"]> = {},
): PlanMarketDirectContinuousInput {
  return {
    entries,
    energyShadow: {
      complete: true,
      revision: "energy-shadow-v1",
      price: 32.06,
    },
    globalQuota: {
      complete: true,
      revision: "global-quota-v1",
      rollingCap: 12_000,
      confirmedAmount: 0,
      unmatchedPlannedAmount: 0,
      ...globalOverrides,
    },
    writeContext: {
      complete: true,
      revision: "write-v1",
      credits: 10_000_000,
      executorShard: "shard1",
      permitEpoch: 1,
      permitId: "permit-1",
      permitHead: "head-1",
      pendingState: "none",
      arbiterState: "available",
    },
  };
}

function v3Entry(
  resourceType: keyof typeof ENTRY_DEFAULTS,
  roomNames: readonly string[],
  orders: readonly MarketOrderSnapshot[],
  calculateTransactionEnergy:
    NonNullable<MarketDirectContinuousEntryInput["calculateTransactionEnergy"]> =
      (amount) => amount === 1 ? 1 : 100,
): MarketDirectContinuousEntryInput {
  const defaults = ENTRY_DEFAULTS[resourceType];
  return {
    policy: {
      entryId: `v3-${resourceType.toLowerCase()}`,
      revision: `${resourceType}-policy-v3`,
      resourceType,
      allowedRooms: roomNames,
      requireNativeMineral: true,
      grant: "continuous",
      hardNetFloor: defaults.hardNetFloor,
      economicNetFloor: defaults.economicNetFloor,
      minExecutableNotional: defaults.minExecutableNotional,
      maxRawOrders: 1_000,
      maxEligibleOrders: 200,
      maxTransactionEnergy: 1_000,
      terminalEnergyReserve: 25_000,
      resourceRollingCap: defaults.cap,
      opportunityReserve: 1_000,
      evaluatorVersion: 3,
    },
    quota: {
      complete: true,
      revision: `${resourceType}-quota-v3`,
      resourceType,
      rollingCap: defaults.cap,
      confirmedAmount: 0,
      unmatchedPlannedAmount: 0,
      opportunityReserveSatisfied: false,
    },
    book: {
      complete: true,
      revision: `${resourceType}-shared-book-v3`,
      orders,
      ownOrderIds: [],
    },
    calculateTransactionEnergy,
    lanes: roomNames.map((roomName) => ({
      lane: {
        roomName,
        resourceType,
        owned: true,
        hub: false,
        capacityEmergency: false,
        nativeMineralType: "O",
        authorization: "writable",
      },
      protection: {
        complete: true,
        revision: `${resourceType}-${roomName}-protection-v3`,
        sellableAmount: 100_000,
      },
      terminal: {
        revision: `${resourceType}-${roomName}-terminal-v3`,
        normal: true,
        ready: true,
        claimed: false,
        cooldown: 0,
        resourceAmount: 50_000,
        energy: 50_000,
        effectivePostDealEnergyReserve: 25_000,
      },
      quota: {
        complete: true,
        revision: `${resourceType}-${roomName}-quota-v3`,
        roomRollingCap: 5_000,
        roomConfirmedAmount: 0,
        roomUnmatchedPlannedAmount: 0,
        laneRollingCap: 3_000,
        laneConfirmedAmount: 0,
        laneUnmatchedPlannedAmount: 0,
      },
    })),
  };
}

describe("multi-resource full-book tuple planner", () => {
  it("固定计划 1,000，优先高价小单而不是低价大单", () => {
    const input = planningInput([
      entry("X", [
        order("lower-large", "X", 680, 50_000),
        order("higher-small", "X", 700, 1_000),
      ]),
    ]);

    const result = planMarketDirectContinuous(input);

    expect(result.complete).toBe(true);
    expect(result.selected).toMatchObject({
      order: { id: "higher-small" },
      plannedAmount: MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
      executableNotionalMilli: 700_000_000,
    });
    expect(result.admittedCandidates.map((candidate) => candidate.order.id))
      .toEqual(["higher-small", "lower-large"]);
  });

  it("千万级单价排序不做溢出的交叉乘法，仍稳定选择更高净价", () => {
    const input = planningInput([
      entry(
        "X",
        [
          order(
            "high-10m",
            "X",
            10_000_001,
          ),
          order(
            "lower-10m",
            "X",
            10_000_000,
          ),
        ],
        {
          energy: () => 0,
        },
      ),
    ]);

    expect(() =>
      planMarketDirectContinuous(input),
    ).not.toThrow();
    const result =
      planMarketDirectContinuous(input);
    expect(result.complete).toBe(true);
    expect(result.selected?.order.id).toBe(
      "high-10m",
    );
    expect(
      result.admittedCandidates.map(
        (candidate) =>
          candidate.order.id,
      ),
    ).toEqual([
      "high-10m",
      "lower-10m",
    ]);
  });

  it("跨资源和跨房按单位净价全局排序，不受输入顺序或 sellable 影响", () => {
    const x = entry("X", [order("x", "X", 700)], {
      energy: (amount) => amount === 1 ? 1 : 900,
    });
    x.lanes[0].protection.sellableAmount = 90_000;
    const h = entry("H", [order("h", "H", 690)], {
      energy: (amount) => amount === 1 ? 1 : 1,
    });
    h.lanes[0].protection.sellableAmount = 1_000;

    const result = planMarketDirectContinuous(planningInput([x, h]));

    expect(result.selected).toMatchObject({
      resourceType: "H",
      roomName: "E3N59",
      order: { id: "h" },
    });
    expect(result.admittedCandidates.map((candidate) =>
      `${candidate.resourceType}/${candidate.roomName}/${candidate.order.id}`))
      .toEqual(["H/E3N59/h", "X/E6N59/x"]);
  });

  it("较高 gross 扣除动态能量影子价后净价更低时选择较低 gross", () => {
    const result = planMarketDirectContinuous(planningInput([
      entry("X", [
        order("far-higher-gross", "X", 700, 1_000, "W50N50"),
        order("near-lower-gross", "X", 695, 1_000, "E7N59"),
      ], {
        energy: (amount, candidate) => {
          if (amount === 1) return 1;
          return candidate.id === "far-higher-gross" ? 1_000 : 10;
        },
      }),
    ]));

    expect(result.selected?.order.id).toBe("near-lower-gross");
    expect(result.selected?.energyShadowPriceMilli).toBe(32_060);
  });

  it("Z executable notional 只按计划 1,000 计算，3,000 订单没有排序加成", () => {
    const atBoundary = planMarketDirectContinuous(planningInput([
      entry("Z", [
        order("z-3000", "Z", 50, 3_000),
        order("z-1000", "Z", 50, 1_000),
      ], {
        energy: () => 0,
      }),
    ]));

    expect(atBoundary.safeCandidates).toHaveLength(2);
    expect(atBoundary.safeCandidates.map((candidate) => ({
      id: candidate.order.id,
      notional: candidate.executableNotionalMilli,
    }))).toEqual([
      { id: "z-1000", notional: 50_000_000 },
      { id: "z-3000", notional: 50_000_000 },
    ]);
    expect(atBoundary.selected?.order.id).toBe("z-1000");

    const belowBoundary = planMarketDirectContinuous(planningInput([
      entry("Z", [order("huge-low", "Z", 44.999, 50_000)], {
        energy: () => 0,
      }),
    ]));
    expect(belowBoundary.complete).toBe(true);
    expect(belowBoundary.selected).toBeUndefined();
    expect(belowBoundary.rejections).toContainEqual(expect.objectContaining({
      orderId: "huge-low",
      reason: "executable_notional_below_minimum",
    }));
  });

  it("计划净价安全但 amount=1 最坏净价穿 floor 时拒绝", () => {
    const result = planMarketDirectContinuous(planningInput([
      entry("Z", [order("partial-unsafe", "Z", 50)], {
        energy: (amount) => amount === 1 ? 1 : 100,
      }),
    ]));

    expect(result.complete).toBe(true);
    expect(result.selected).toBeUndefined();
    expect(result.rejections).toContainEqual(expect.objectContaining({
      orderId: "partial-unsafe",
      reason: "worst_case_net_below_floor",
    }));
  });

  it("高库存但全部低于安全线时完整 safe-no-op，不降价出售", () => {
    const result = planMarketDirectContinuous(planningInput([
      entry("X", [order("cheap", "X", 599, 100_000)], {
        energy: () => 0,
      }),
    ]));

    expect(result).toMatchObject({
      complete: true,
      safeCandidates: [],
      admittedCandidates: [],
    });
    expect(result.selected).toBeUndefined();
  });

  it("任一参与 book 不完整、raw 或 eligible 超限时全局零计划", () => {
    const incompleteH = entry("H", [order("h", "H", 700)]);
    incompleteH.lanes[0].book.complete = false;
    const incomplete = planMarketDirectContinuous(planningInput([
      entry("X", [order("x", "X", 700)]),
      incompleteH,
    ]));
    expect(incomplete).toMatchObject({
      complete: false,
      blocker: { reason: "book_incomplete", entryId: "base-h-e3n59-v1" },
      safeCandidates: [],
    });

    const rawOverflow = planMarketDirectContinuous(planningInput([
      entry("X", [
        order("x-1", "X", 700),
        order("x-2", "X", 699),
      ], { rawLimit: 1, eligibleLimit: 1 }),
    ]));
    expect(rawOverflow.blocker?.reason).toBe("raw_book_limit_exceeded");

    const eligibleOverflow = planMarketDirectContinuous(planningInput([
      entry("X", [
        order("x-1", "X", 700),
        order("x-2", "X", 699),
      ], { eligibleLimit: 1 }),
    ]));
    expect(eligibleOverflow.blocker?.reason)
      .toBe("eligible_book_limit_exceeded");
  });

  it("resource quota 先准入；global admission 为其它当前安全资源保留机会", () => {
    const xExhausted = entry("X", [order("x", "X", 700)], {
      confirmedAmount: 8_000,
    });
    const h = entry("H", [order("h", "H", 650)]);
    const resourceResult = planMarketDirectContinuous(planningInput([
      xExhausted,
      h,
    ]));
    expect(resourceResult.selected?.resourceType).toBe("H");
    expect(resourceResult.rejections).toContainEqual(expect.objectContaining({
      resourceType: "X",
      reason: "resource_quota_exhausted",
    }));

    const x = entry("X", [order("x", "X", 700)], {
      opportunityReserveSatisfied: true,
    });
    const unsatisfiedH = entry("H", [order("h", "H", 650)]);
    const opportunityResult = planMarketDirectContinuous(planningInput(
      [x, unsatisfiedH],
      { confirmedAmount: 11_000 },
    ));
    expect(opportunityResult.selected?.resourceType).toBe("H");
    expect(opportunityResult.rejections).toContainEqual(expect.objectContaining({
      resourceType: "X",
      reason: "global_quota_or_opportunity_reserve",
    }));
  });

  it("同资源多房共享一份 BUY book，并选择交易能耗更低的 seller lane", () => {
    const calculator = jest.fn((
      amount: number,
      _candidate: MarketOrderSnapshot,
      sellerRoomName: string,
    ) => sellerRoomName === "E1N1"
      ? (amount === 1 ? 1 : 900)
      : (amount === 1 ? 1 : 10));
    const shared = v3Entry(
      "X",
      ["E1N1", "E2N2"],
      [order("shared", "X", 700, 1_000, "E3N3")],
      calculator,
    );

    const result = planMarketDirectContinuous(planningInput([shared]));

    expect(result.complete).toBe(true);
    expect(result.selected).toMatchObject({
      roomName: "E2N2",
      order: { id: "shared" },
    });
    expect(result.safeCandidates).toHaveLength(2);
    expect(calculator).toHaveBeenCalledTimes(4);
    expect(result.budget).toEqual({
      sellerRooms: 2,
      distinctOrderRooms: 1,
      transactionEnergyEvaluations: 4,
    });
  });

  it("同 ID 同 canonical 内容只计一次；同 ID 冲突与跨资源复用均 fail closed", () => {
    const same = order("same", "X", 700, 1_000, "E3N3");
    const deduped = planMarketDirectContinuous(planningInput([
      v3Entry("X", ["E1N1"], [same, { ...same }], () => 0),
    ]));
    expect(deduped.complete).toBe(true);
    expect(deduped.safeCandidates).toHaveLength(1);

    const conflict = planMarketDirectContinuous(planningInput([
      v3Entry("X", ["E1N1"], [
        same,
        { ...same, price: 701 },
      ], () => 0),
    ]));
    expect(conflict).toMatchObject({
      complete: false,
      blocker: {
        reason: "duplicate_order_id",
        orderId: "same",
        detail: "same_resource_order_id_conflict",
      },
      safeCandidates: [],
    });

    const crossResource = planMarketDirectContinuous(planningInput([
      v3Entry("X", ["E1N1"], [
        order("cross", "X", 700, 1_000, "E3N3"),
      ], () => 0),
      v3Entry("H", ["E2N2"], [
        order("cross", "H", 700, 1_000, "E4N4"),
      ], () => 0),
    ]));
    expect(crossResource).toMatchObject({
      complete: false,
      blocker: {
        reason: "duplicate_order_id",
        orderId: "cross",
      },
      safeCandidates: [],
    });
  });

  it("订单排列变化保持逐字相同 planning evidence 与最佳 tuple", () => {
    const orders = [
      order("order-c", "X", 702, 1_000, "E3N3"),
      order("order-a", "X", 700, 1_000, "E1N1"),
      order("order-b", "X", 701, 1_000, "E2N2"),
    ];
    const forward = planMarketDirectContinuous(planningInput([
      v3Entry("X", ["W1N1"], orders, () => 0),
    ]));
    const reversed = planMarketDirectContinuous(planningInput([
      v3Entry("X", ["W1N1"], [...orders].reverse(), () => 0),
    ]));

    expect(forward.complete).toBe(true);
    expect(reversed.complete).toBe(true);
    expect(forward.selected?.order.id).toBe("order-c");
    expect(reversed.selected?.order.id).toBe("order-c");
    expect(reversed.planningFingerprint).toBe(forward.planningFingerprint);
    expect(reversed.planningEvidence).toBe(forward.planningEvidence);
  });

  it("自有 BUY order 在 tuple 前排除，外部高价单仍可成交", () => {
    const shared = v3Entry("X", ["E1N1"], [
      order("self", "X", 800),
      order("external", "X", 700),
    ], () => 0);
    shared.book!.ownOrderIds = ["self"];

    const result = planMarketDirectContinuous(planningInput([shared]));

    expect(result.selected?.order.id).toBe("external");
    expect(result.rejections).toContainEqual(expect.objectContaining({
      orderId: "self",
      reason: "self_order",
    }));
  });

  it("v3 允许 protection 完整的 Hub/emergency/non-native lane，v2 仍冻结旧拒绝", () => {
    const modern = v3Entry("H", ["E4N58"], [
      order("hub-buy", "H", 700),
    ], () => 0);
    modern.lanes[0].lane.hub = true;
    modern.lanes[0].lane.capacityEmergency = true;
    modern.lanes[0].lane.nativeMineralType = "Z";

    const modernResult = planMarketDirectContinuous(planningInput([modern]));
    expect(modernResult.selected).toMatchObject({
      resourceType: "H",
      roomName: "E4N58",
      order: { id: "hub-buy" },
    });

    const legacy = entry("H", [order("legacy-buy", "H", 700)]);
    legacy.lanes[0].lane.hub = true;
    legacy.lanes[0].lane.capacityEmergency = true;
    legacy.lanes[0].lane.nativeMineralType = "Z";
    const legacyResult = planMarketDirectContinuous(planningInput([legacy]));
    expect(legacyResult.blocker?.reason).toBe("lane_scope_invalid");
  });

  it("v3 cooldown lane 是完整但暂无机会，不阻断其它 writable lane", () => {
    const modern = v3Entry(
      "X",
      ["E1N1", "E2N2"],
      [order("x", "X", 700)],
      () => 0,
    );
    modern.lanes[0].terminal.cooldown = 1;

    const modernResult = planMarketDirectContinuous(planningInput([modern]));

    expect(modernResult.complete).toBe(true);
    expect(modernResult.selected).toMatchObject({
      roomName: "E2N2",
      order: { id: "x" },
    });
    expect(modernResult.safeCandidates).toHaveLength(1);

    const legacy = entry("X", [order("legacy-x", "X", 700)]);
    legacy.lanes[0].terminal.cooldown = 1;
    expect(
      planMarketDirectContinuous(planningInput([legacy])).blocker?.reason,
    ).toBe("lane_scope_invalid");
  });

  it("suspended Shadow 的局部保护缺失被隔离，writable lane 缺失则全局零写", () => {
    const isolated = v3Entry(
      "X",
      ["E1N1", "E2N2"],
      [order("x", "X", 700)],
      () => 0,
    );
    isolated.lanes[1].lane.authorization = "suspended_shadow";
    isolated.lanes[1].protection.complete = false;

    const isolatedResult = planMarketDirectContinuous(planningInput([isolated]));
    expect(isolatedResult.complete).toBe(true);
    expect(isolatedResult.selected?.roomName).toBe("E1N1");
    expect(isolatedResult.isolatedShadowLanes).toEqual([{
      entryId: "v3-x",
      roomName: "E2N2",
      reason: "protection_incomplete",
    }]);

    const writableBroken = v3Entry(
      "X",
      ["E1N1", "E2N2"],
      [order("x", "X", 700)],
      () => 0,
    );
    writableBroken.lanes[1].protection.complete = false;
    const blocked = planMarketDirectContinuous(planningInput([writableBroken]));
    expect(blocked).toMatchObject({
      complete: false,
      blocker: {
        reason: "protection_incomplete",
        roomName: "E2N2",
      },
      safeCandidates: [],
    });
  });

  it("129 个目的房在任何 transaction-cost evaluation 前整轮零写", () => {
    const calculator = jest.fn(() => 0);
    const orders = Array.from(
      { length: MARKET_DIRECT_CONTINUOUS_MAX_DISTINCT_ORDER_ROOMS + 1 },
      (_, index) =>
        order(`order-${index}`, "X", 700, 1_000, `E${index}N1`),
    );

    const result = planMarketDirectContinuous(planningInput([
      v3Entry("X", ["E1N1"], orders, calculator),
    ]));

    expect(result).toMatchObject({
      complete: false,
      blocker: {
        reason: "distinct_order_room_limit_exceeded",
      },
      safeCandidates: [],
      budget: {
        sellerRooms: 1,
        distinctOrderRooms:
          MARKET_DIRECT_CONTINUOUS_MAX_DISTINCT_ORDER_ROOMS + 1,
        transactionEnergyEvaluations: 0,
      },
    });
    expect(calculator).not.toHaveBeenCalled();
  });

  it("16 seller × 128 orderRoom × planned/worst 恰好闭合为 4,096 次 memo evaluation", () => {
    const calculator = jest.fn(() => 0);
    const sellerRooms = Array.from(
      { length: MARKET_DIRECT_CONTINUOUS_MAX_SELLER_ROOMS },
      (_, index) => `E${index + 1}N1`,
    );
    const orders = Array.from(
      { length: MARKET_DIRECT_CONTINUOUS_MAX_DISTINCT_ORDER_ROOMS },
      (_, index) =>
        order(`order-${index}`, "X", 700, 1_000, `W${index + 1}N1`),
    );

    const result = planMarketDirectContinuous(planningInput([
      v3Entry("X", sellerRooms, orders, calculator),
    ]));

    expect(result.complete).toBe(true);
    expect(result.budget).toEqual({
      sellerRooms: MARKET_DIRECT_CONTINUOUS_MAX_SELLER_ROOMS,
      distinctOrderRooms:
        MARKET_DIRECT_CONTINUOUS_MAX_DISTINCT_ORDER_ROOMS,
      transactionEnergyEvaluations:
        MARKET_DIRECT_CONTINUOUS_MAX_TRANSACTION_ENERGY_EVALUATIONS,
    });
    expect(calculator).toHaveBeenCalledTimes(
      MARKET_DIRECT_CONTINUOUS_MAX_TRANSACTION_ENERGY_EVALUATIONS,
    );
  });

  it("第 17 个 seller room 在 transaction-cost evaluation 前全局停写", () => {
    const calculator = jest.fn(() => 0);
    const sellerRooms = Array.from(
      { length: MARKET_DIRECT_CONTINUOUS_MAX_SELLER_ROOMS + 1 },
      (_, index) => `E${index + 1}N1`,
    );

    const result = planMarketDirectContinuous(planningInput([
      v3Entry("X", sellerRooms, [order("x", "X", 700)], calculator),
    ]));

    expect(result.blocker?.reason).toBe("seller_room_limit_exceeded");
    expect(result.safeCandidates).toEqual([]);
    expect(calculator).not.toHaveBeenCalled();
  });

  it("v3 room/lane quota 任一不足均拒绝，且 effective reserve 不可降穿", () => {
    const laneExhausted = v3Entry(
      "X",
      ["E1N1"],
      [order("x", "X", 700)],
      () => 0,
    );
    laneExhausted.lanes[0].quota!.laneConfirmedAmount = 3_000;
    const laneResult = planMarketDirectContinuous(planningInput([
      laneExhausted,
    ]));
    expect(laneResult.selected).toBeUndefined();
    expect(laneResult.rejections).toContainEqual(expect.objectContaining({
      reason: "lane_quota_exhausted",
      roomName: "E1N1",
    }));

    const roomExhausted = v3Entry(
      "X",
      ["E1N1"],
      [order("x", "X", 700)],
      () => 0,
    );
    roomExhausted.lanes[0].quota!.roomConfirmedAmount = 5_000;
    const roomResult = planMarketDirectContinuous(planningInput([
      roomExhausted,
    ]));
    expect(roomResult.rejections).toContainEqual(expect.objectContaining({
      reason: "room_quota_exhausted",
      roomName: "E1N1",
    }));

    const reserve = v3Entry(
      "X",
      ["E1N1"],
      [order("x", "X", 700)],
      (amount) => amount === 1 ? 1 : 1_000,
    );
    reserve.lanes[0].terminal.energy = 26_000;
    reserve.lanes[0].terminal.effectivePostDealEnergyReserve = 26_000;
    const reserveResult = planMarketDirectContinuous(planningInput([reserve]));
    expect(reserveResult.selected).toBeUndefined();
    expect(reserveResult.rejections).toContainEqual(expect.objectContaining({
      reason: "terminal_energy_reserve",
      roomName: "E1N1",
    }));
  });

  it("v3 缺少资源级 book 或与 lane adapter 漂移时均 fail closed", () => {
    const missing = v3Entry(
      "X",
      ["E1N1"],
      [order("x", "X", 700)],
      () => 0,
    );
    const laneOnlyBook = missing.book!;
    delete missing.book;
    missing.lanes[0].book = laneOnlyBook;

    expect(planMarketDirectContinuous(planningInput([missing]))).toMatchObject({
      complete: false,
      blocker: {
        reason: "book_incomplete",
        detail: "resource_book_not_shared",
      },
      safeCandidates: [],
    });

    const shared = v3Entry(
      "X",
      ["E1N1"],
      [order("x", "X", 700)],
      () => 0,
    );
    shared.lanes[0].book = {
      complete: true,
      revision: "stale-lane-book",
      orders: [order("x", "X", 699)],
      ownOrderIds: [],
    };

    const result = planMarketDirectContinuous(planningInput([shared]));

    expect(result).toMatchObject({
      complete: false,
      blocker: {
        reason: "book_incomplete",
        detail: "resource_book_not_shared",
      },
      safeCandidates: [],
    });
  });

  it("second-read 只有所有相关字段与最佳 tuple 完全一致才为 true", () => {
    const variants: PlanMarketDirectContinuousInput[] = [];
    const make = (): PlanMarketDirectContinuousInput => {
      const nextEntry = entry("X", [order("x", "X", 700, 2_000)]);
      return planningInput([nextEntry]);
    };
    const firstInput = make();
    const planned = planMarketDirectContinuous(firstInput);
    const exact = planMarketDirectContinuous(make());
    expect(isExactMarketDirectContinuousSecondRead(planned, exact)).toBe(true);
    const reusedBook = planMarketDirectContinuous(firstInput);
    expect(isExactMarketDirectContinuousSecondRead(planned, reusedBook))
      .toBe(false);
    const shallowBook = make();
    shallowBook.entries[0].lanes[0].book = {
      ...firstInput.entries[0].lanes[0].book,
    };
    expect(isExactMarketDirectContinuousSecondRead(
      planned,
      planMarketDirectContinuous(shallowBook),
    )).toBe(false);

    const orderChanged = make();
    orderChanged.entries[0].lanes[0].book.orders[0].amount = 1_999;
    variants.push(orderChanged);
    const terminalChanged = make();
    terminalChanged.entries[0].lanes[0].terminal.resourceAmount -= 1;
    variants.push(terminalChanged);
    const protectionChanged = make();
    protectionChanged.entries[0].lanes[0].protection.revision = "changed";
    variants.push(protectionChanged);
    const quotaChanged = make();
    quotaChanged.entries[0].quota.confirmedAmount = 1;
    variants.push(quotaChanged);
    const shadowChanged = make();
    shadowChanged.energyShadow.price = 32.061;
    variants.push(shadowChanged);
    const permitChanged = make();
    permitChanged.writeContext.permitHead = "head-2";
    variants.push(permitChanged);
    const pendingChanged = make();
    pendingChanged.writeContext.pendingState = "active";
    variants.push(pendingChanged);
    const energyChanged = make();
    energyChanged.entries[0].lanes[0].calculateTransactionEnergy = (amount) =>
      amount === 1 ? 1 : 101;
    variants.push(energyChanged);

    for (const variant of variants) {
      expect(isExactMarketDirectContinuousSecondRead(
        planned,
        planMarketDirectContinuous(variant),
      )).toBe(false);
    }

    const multiFirst = v3Entry(
      "X",
      ["E1N1", "E2N2"],
      [order("x", "X", 700, 2_000, "E3N3")],
      (amount, _candidate, roomName) =>
        roomName === "E1N1"
          ? (amount === 1 ? 1 : 10)
          : (amount === 1 ? 1 : 100),
    );
    const multiSecond = v3Entry(
      "X",
      ["E1N1", "E2N2"],
      [order("x", "X", 700, 2_000, "E3N3")],
      (amount, _candidate, roomName) =>
        roomName === "E1N1"
          ? (amount === 1 ? 1 : 10)
          : (amount === 1 ? 1 : 0),
    );
    const firstPlan = planMarketDirectContinuous(planningInput([multiFirst]));
    const changedPlan = planMarketDirectContinuous(planningInput([multiSecond]));
    expect(firstPlan.selected?.roomName).toBe("E1N1");
    expect(changedPlan.selected?.roomName).toBe("E2N2");
    expect(isExactMarketDirectContinuousSecondRead(firstPlan, changedPlan))
      .toBe(false);
  });
});
