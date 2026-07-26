import {
  isExactMarketDirectContinuousSecondRead,
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

  it("second-read 只有所有相关字段与最佳 tuple 完全一致才为 true", () => {
    const baseInput = planningInput([
      entry("X", [order("x", "X", 700, 2_000)]),
    ]);
    const planned = planMarketDirectContinuous(baseInput);
    const exact = planMarketDirectContinuous(baseInput);
    expect(isExactMarketDirectContinuousSecondRead(planned, exact)).toBe(true);

    const variants: PlanMarketDirectContinuousInput[] = [];
    const make = (): PlanMarketDirectContinuousInput => {
      const nextEntry = entry("X", [order("x", "X", 700, 2_000)]);
      return planningInput([nextEntry]);
    };
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
  });
});
