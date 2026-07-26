import {
  acceptMarketDirectContinuousPermit,
  attestMarketSalePendingCreate,
  emergencyStopMarketSaleAutomation,
  grantMarketSaleMutationLease,
  marketDirectContinuousStatus,
  proposeMarketDirectContinuousPermit,
  resolveMarketSaleExternalOrderMutation,
  resolveMarketSaleOrderDisappearance,
  resolveMarketSalePendingCreateAbsence,
  runMarketSaleAutomation,
  runMarketSalePreflight,
  type MarketSalePlanCandidate,
} from "@/runtime/marketSaleAutomation";
import {
  clearMarketActionArbiterForTest,
  executeTerminalSend,
} from "@/runtime/marketActionArbiter";
import { createDirectAutomationState } from "@/runtime/marketSaleDirectAutomation";
import { LEGACY_X_V1_OUTCOME_GOLDEN } from "@/runtime/marketDirectContinuousAutomation";
import type {
  MarketProtectionContribution,
  MarketProtectionEntry,
} from "@/runtime/marketSaleProtection";

type MutableMarket = Partial<Market> & {
  orders: Record<string, Order>;
  credits: number;
  outgoingTransactions: Transaction[];
};

function installMarket(overrides: Partial<MutableMarket> = {}): MutableMarket {
  const market: MutableMarket = {
    orders: {},
    credits: 1_000_000,
    outgoingTransactions: [],
    incomingTransactions: [],
    createOrder: jest.fn(() => OK),
    cancelOrder: jest.fn(() => OK),
    extendOrder: jest.fn(() => OK),
    changeOrderPrice: jest.fn(() => OK),
    deal: jest.fn(() => OK),
    getAllOrders: jest.fn(() => []),
    getHistory: jest.fn(() => []),
    calcTransactionCost: jest.fn(() => 0),
    ...overrides,
  };
  (Game as unknown as { market: MutableMarket }).market = market;
  return market;
}

function installRoom(
  roomName = "W1N1",
  resource: ResourceConstant = RESOURCE_KEANIUM,
): StructureTerminal {
  const amounts: Partial<Record<ResourceConstant, number>> = {
    [RESOURCE_ENERGY]: 100_000,
    [resource]: 20_000,
  };
  const terminal = {
    cooldown: 0,
    send: jest.fn(() => OK),
    store: {
      getUsedCapacity: (requested?: ResourceConstant) =>
        requested ? amounts[requested] || 0 : 120_000,
      getFreeCapacity: () => 180_000,
    },
  } as unknown as StructureTerminal;
  const room = {
    name: roomName,
    controller: { my: true },
    terminal,
  } as unknown as Room;
  (terminal as unknown as { room: Room }).room = room;
  Game.rooms[roomName] = room;
  return terminal;
}

function validConfig(
  mode: "off" | "shadow" | "maker" | "hybrid" | "emergencyStop",
  revision = "rev-1",
): void {
  Memory.cfg = {
    resourceControl: { market: { enabled: true } },
    factoryControl: { market: { enabled: true } },
    marketSaleAutomation: {
      mode,
      configRevision: revision,
      sellResources: [RESOURCE_KEANIUM],
      hardFloor: { [RESOURCE_KEANIUM]: 1 },
      economicFloor: { [RESOURCE_KEANIUM]: 1.1 },
      forecastBuffer: { [RESOURCE_KEANIUM]: 1_000 },
      minDealAmount: 100,
      maxDealAmount: 5_000,
      makerBatchAmount: 1_000,
      maxManagedOrders: 3,
      minFreeOrderSlots: 5,
      creditReserve: 10_000,
      rollingFeeBudget: 1_000_000,
      feeWindowTicks: 20_000,
      terminalEnergyReserve: 25_000,
      orderPolicyTtl: 20_000,
      mutationBackoffTicks: 10,
      canary: { enabled: true, allowExpansion: false },
    },
  };
}

function order(
  id: string,
  overrides: Partial<Order> = {},
): Order {
  return {
    id,
    created: Game.time,
    type: ORDER_SELL,
    resourceType: RESOURCE_KEANIUM,
    roomName: "W1N1",
    price: 2,
    totalAmount: 1_000,
    remainingAmount: 1_000,
    amount: 1_000,
    active: true,
    ...overrides,
  } as Order;
}

function protectionEntry(
  overrides: Partial<MarketProtectionEntry> = {},
): MarketProtectionEntry {
  return {
    roomName: "W1N1",
    resource: RESOURCE_KEANIUM,
    revision: Game.time,
    observedAt: Game.time,
    expiresAt: Game.time,
    totalStock: 20_000,
    terminalStock: 20_000,
    hardReserve: 5_000,
    productionDemand: 0,
    forecastBuffer: 1_000,
    protectedOutgoing: 0,
    carrierOrInFlight: 0,
    protectedAmount: 6_000,
    grossSurplus: 14_000,
    managedExposure: 0,
    newExposureCapacity: 14_000,
    sellableAmount: 14_000,
    fresh: true,
    blocked: false,
    blockedReasons: [],
    issues: [],
    sourceContributions: [],
    ...overrides,
  };
}

function managedExposureContribution(
  orderId: string,
  amount: number,
): MarketProtectionContribution {
  return {
    dedupeKey: `managed:${orderId}`,
    stableKey: `managed:${orderId}`,
    anonymous: false,
    bucket: "managedExposure",
    amount,
    sourceKinds: ["managedExposure"],
    managedOrderId: orderId,
    observedAt: Game.time,
    expiresAt: Game.time,
  };
}

function candidate(
  overrides: Partial<MarketSalePlanCandidate> = {},
): MarketSalePlanCandidate {
  return {
    roomName: "W1N1",
    resourceType: RESOURCE_KEANIUM,
    protectionEntry: protectionEntry(),
    effectiveNetFloor: 1.1,
    makerPrice: 2,
    trustedPrice: true,
    trustedDepth: true,
    capacityState: "normal",
    hasCriticalConflict: false,
    isHubRoom: false,
    minimumTerminalFreeCapacity: 0,
    ...overrides,
  };
}

function installManagedOrder(orderId: string): void {
  (Memory as unknown as { data: unknown }).data = {
    marketSaleAutomation: {
      managedOrders: {
        [orderId]: {
          orderId,
          roomName: "W1N1",
          resourceType: RESOURCE_KEANIUM,
          price: 2,
          originalAmount: 1_000,
          lastRemainingAmount: 1_000,
          remainingExposure: 1_000,
          feeDebtMilli: 100_000,
          createdAt: Game.time - 10,
          lastSeenAt: Game.time - 1,
          policyCancelAtTick: Game.time + 1_000,
          serverCreatedTick: Game.time - 10,
        },
      },
      pendingMutations: {},
      feeEvents: [],
      carriedFeeDebtMilli: {},
      trustedFloors: {},
      processedTransactionKeys: [],
      operatorAudit: [],
      drain: { phase: "maker", zeroConfirmations: 0 },
    },
  };
}

function qualifyMaker(revision = "rev-1"): void {
  validConfig("shadow", revision);
  Memory.runtime = {
    resourceControl: {
      updatedAt: Game.time,
      rooms: {},
      lastActions: [],
      lastMarketActions: [],
    },
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    const result = runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    if (result.phase === "shadow") break;
    Game.time += 1;
  }
  expect(Memory.runtime!.marketSaleAutomation!.phase).toBe("shadow");
  Memory.runtime!.marketSaleAutomation!.shadowConsecutiveCycles = 100;
  Memory.cfg!.marketSaleAutomation!.mode = "maker";
}

function installContinuousDirectConfig(): void {
  Memory.cfg = {
    resourceControl: { market: { enabled: true } },
    factoryControl: { market: { enabled: true } },
    marketSaleAutomation: {
      mode: "direct",
      directCapability: "continuous-v2",
      configRevision: "market-direct-continuous-v2-r1",
      sellResources: [
        RESOURCE_CATALYST,
        RESOURCE_HYDROGEN,
        RESOURCE_ZYNTHIUM,
      ],
      hardFloor: {
        [RESOURCE_CATALYST]: 600,
        [RESOURCE_HYDROGEN]: 428,
        [RESOURCE_ZYNTHIUM]: 43,
      },
      economicFloor: {
        [RESOURCE_CATALYST]: 600,
        [RESOURCE_HYDROGEN]: 451,
        [RESOURCE_ZYNTHIUM]: 45,
      },
      forecastBuffer: {
        [RESOURCE_CATALYST]: 100_000,
        [RESOURCE_HYDROGEN]: 100_000,
        [RESOURCE_ZYNTHIUM]: 100_000,
      },
      minDealAmount: 1_000,
      makerBatchAmount: 5_000,
      creditReserve: 0,
      terminalEnergyReserve: 25_000,
      maxDirectDealAmount: 1_000,
      maxDirectDealsPerCycle: 1,
      minDirectOrderAmount: 1_000,
      minDirectOrderNotional: 600_000,
      maxDirectRawOrdersScannedPerCycle: 1_000,
      maxDirectEligibleOrdersPricedPerCycle: 200,
      maxDirectTransactionEnergy: 1_000,
      directCanaryMaxConfirmedDeals: 1,
      energyShadowHardFloor: 20,
      planningSnapshotMaxAgeTicks: 10,
      minHistoryDays: 7,
      minHistoryTransactions: 100,
      minHistoryVolume: 100_000,
      historyFloorRatio: 0.95,
      historyMaxAgeDays: 2,
      canary: { enabled: true, allowExpansion: false },
    },
  };
}

function installExactReviewedLegacyDirectState(): void {
  const direct = createDirectAutomationState();
  direct.directDealOutcomes = [
    JSON.parse(
      JSON.stringify(LEGACY_X_V1_OUTCOME_GOLDEN),
    ),
  ];
  direct.processedDirectTransactionKeys = [
    LEGACY_X_V1_OUTCOME_GOLDEN.evidenceKey!,
  ];
  direct.directConfirmedDealCount = 1;
  direct.directPausedForReview = true;
  Memory.data = {
    marketSaleAutomation: {
      directAutomation: direct,
      pendingDirectDeals: direct.pendingDirectDeals,
    },
  } as Memory["data"];
}

describe("marketSaleAutomation 编排", () => {
  beforeEach(() => {
    clearMarketActionArbiterForTest();
    installMarket();
    installRoom();
    Game.time = 100;
  });

  it("preflight 每 tick 强制双旧闩并幂等注册 operator 入口", () => {
    validConfig("off");

    runMarketSalePreflight();

    expect(Memory.cfg?.resourceControl?.market?.enabled).toBe(false);
    expect(Memory.cfg?.factoryControl?.market?.enabled).toBe(false);
    expect(typeof (global as any).grantMarketSaleMutationLease).toBe("function");
    expect(typeof (global as any).attestMarketSalePendingCreate).toBe("function");
    expect(typeof (global as any).resolveMarketSalePendingCreateAbsence).toBe(
      "function",
    );
    expect(
      typeof (global as any).resolveMarketSaleExternalOrderMutation,
    ).toBe("function");
    expect(
      typeof (global as any).resolveMarketSaleOrderDisappearance,
    ).toBe("function");
    expect(typeof (global as any).expandMarketSaleCanary).toBe("function");
    expect(typeof (global as any).emergencyStopMarketSaleAutomation).toBe(
      "function",
    );
    expect(typeof (global as any).marketSaleAutomationStatus).toBe("function");
  });

  it("off 排空只撤销 known managed order，保留手工订单与 exposure 直到 live ID 消失", () => {
    validConfig("off");
    const market = installMarket({
      orders: {
        managed: order("managed"),
        manual: order("manual", { roomName: "W2N2" }),
      },
    });
    installManagedOrder("managed");

    const first = runMarketSalePreflight();

    expect(first.phase).toMatch(/requested|draining/);
    expect(market.cancelOrder).toHaveBeenCalledTimes(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(Memory.data?.marketSaleAutomation?.managedOrders.managed).toBeDefined();
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toMatchObject({ kind: "cancel", status: "submitted" });

    Game.time += 1;
    market.orders = { manual: market.orders.manual };
    runMarketSalePreflight();

    expect(Memory.data?.marketSaleAutomation?.managedOrders.managed).toBeUndefined();
    expect(Memory.data?.marketSaleAutomation?.pendingMutations.managed).toBeUndefined();
    expect(market.cancelOrder).toHaveBeenCalledTimes(1);
    expect(market.orders.manual).toBeDefined();
  });

  it("Shadow 只按新鲜 ResourceControl 周期计数，重复 tick 不累加且 revision 变化清零", () => {
    validConfig("shadow", "rev-1");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };
    const market = Game.market as MutableMarket;

    runMarketSaleAutomation({ candidates: [candidate()] });
    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(Memory.runtime?.marketSaleAutomation?.phase).toBe("shadow");
    expect(
      Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles,
    ).toBe(0);

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(
      Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles,
    ).toBe(1);

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    Memory.cfg!.marketSaleAutomation!.minReferenceOrderNotional = 125;
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(
      Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles,
    ).toBe(0);

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(
      Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles,
    ).toBe(1);

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    Memory.cfg!.marketSaleAutomation!.minReferenceDistinctRooms = 2;
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(
      Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles,
    ).toBe(0);

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    Memory.cfg!.marketSaleAutomation!.configRevision = "rev-2";
    runMarketSaleAutomation({
      candidates: [candidate({ protectionEntry: protectionEntry() })],
    });
    expect(
      Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles,
    ).toBe(0);
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(market.cancelOrder).not.toHaveBeenCalled();
    expect(market.deal).not.toHaveBeenCalled();
  });

  it("有界投影历史证据、托管订单、slot、credit 与全部 active backoff", () => {
    validConfig("maker");
    Memory.cfg!.marketSaleAutomation!.maxManagedOrders = 1;
    installManagedOrder("managed-00");
    const data = Memory.data!.marketSaleAutomation!;
    const first = data.managedOrders["managed-00"];
    const orders: Record<string, Order> = {};
    for (let index = 0; index < 22; index += 1) {
      const orderId = `managed-${String(index).padStart(2, "0")}`;
      data.managedOrders[orderId] = {
        ...first,
        orderId,
        backoffUntil:
          index === 0 ? Game.time + 10 : index === 21 ? Game.time + 20 : undefined,
      };
      orders[orderId] = order(orderId);
    }
    orders.manual = order("manual", { roomName: "W9N9" });
    installMarket({ orders });
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    runMarketSaleAutomation({
      candidates: [
        candidate({
          historyTrusted: true,
          historyCompleteDayCount: 7,
          historyAcceptedDayCount: 6,
          historyFloor: 1.2,
          ratchetFloor: 1.25,
          makerNetPrice: 1.9,
        }),
      ],
    });

    const runtime = Memory.runtime!.marketSaleAutomation!;
    expect(runtime.candidates["W1N1:K"]).toMatchObject({
      historyTrusted: true,
      historyCompleteDayCount: 7,
      historyAcceptedDayCount: 6,
      historyFloor: 1.2,
      ratchetFloor: 1.25,
      makerNetPrice: 1.9,
    });
    expect(runtime.managedOrderCount).toBe(22);
    expect(runtime.managedOrders).toHaveLength(20);
    expect(runtime.managedOrders?.[0]).toMatchObject({
      orderId: "managed-00",
      roomName: "W1N1",
      resourceType: RESOURCE_KEANIUM,
      remainingExposure: 1_000,
      liveRemainingAmount: 1_000,
      backoffUntil: Game.time + 10,
    });
    expect(runtime.managedOrders?.some((entry) => entry.orderId === "manual")).toBe(
      false,
    );
    expect(runtime.managedOrderSummaryTruncated).toBe(true);
    expect(runtime.backoffSummary).toEqual({
      activeCount: 2,
      nextUntil: Game.time + 10,
    });
    expect(runtime.orderSlots).toEqual({
      total: 300,
      current: 23,
      free: 277,
      reserved: 0,
      minFree: 5,
    });
    expect(runtime.creditSummary).toEqual({
      credits: 1_000_000,
      reserve: 10_000,
      reservedFeesThisTick: 0,
      availableAfterReserve: 990_000,
    });
  });

  it("空候选不能累计 Shadow 资格，Maker 也不能首次锁定未观察候选", () => {
    validConfig("shadow", "rev-empty");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };
    const market = Game.market as MutableMarket;

    for (let cycle = 0; cycle < 105; cycle += 1) {
      Memory.runtime!.resourceControl!.updatedAt = Game.time;
      runMarketSaleAutomation({ candidates: [] });
      Game.time += 1;
    }

    expect(
      Memory.runtime?.marketSaleAutomation?.shadowConsecutiveCycles,
    ).toBe(0);
    expect(Memory.data?.marketSaleAutomation?.canaryLock).toBeUndefined();

    Memory.cfg!.marketSaleAutomation!.mode = "maker";
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    grantMarketSaleMutationLease("empty-shadow", Game.time + 10);
    const result = runMarketSaleAutomation({ candidates: [candidate()] });

    expect(result.rejectedByReason.canary_lock_missing).toBeGreaterThan(0);
    expect(market.createOrder).not.toHaveBeenCalled();
  });

  it("Hybrid 未实现时 fail-closed 为 off/draining，不能静默执行 Maker", () => {
    validConfig("hybrid", "rev-hybrid");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };
    const market = Game.market as MutableMarket;

    const result = runMarketSaleAutomation({ candidates: [candidate()] });

    expect(result.effectiveMode).toBe("off");
    expect(result.phase).toMatch(/draining|off/);
    expect(result.rejectedByReason.hybrid_not_implemented).toBe(1);
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(market.deal).not.toHaveBeenCalled();
  });

  it("每个新鲜规划周期都按当前底线复验托管订单，净价不足时安全撤单", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed", { price: 1 }),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.managedOrders.managed.price = 1;
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const result = runMarketSaleAutomation({
      candidates: [candidate({ effectiveNetFloor: 1.1 })],
    });

    expect(result.rejectedByReason.managed_order_floor_violation).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toMatchObject({ kind: "cancel", status: "submitted" });
  });

  it("非 ResourceControl tick 提高 hard floor 时立即按 live 净价撤单", () => {
    validConfig("maker");
    Memory.cfg!.marketSaleAutomation!.hardFloor![RESOURCE_KEANIUM] = 1.95;
    const market = installMarket({
      orders: { managed: order("managed", { price: 2 }) },
    });
    installManagedOrder("managed");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time - 1,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          effectiveNetFloor: 1.1,
          protectionEntry: protectionEntry({
            managedExposure: 1_000,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(result.rejectedByReason.current_tick_floor_violation).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toMatchObject({ kind: "cancel", status: "submitted" });
  });

  it("非 ResourceControl tick 无法证明当前价格底线时安全撤单", () => {
    validConfig("maker");
    const market = installMarket({
      orders: { managed: order("managed", { price: 2 }) },
    });
    installManagedOrder("managed");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time - 1,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          effectiveNetFloor: 0,
          protectionEntry: protectionEntry({
            managedExposure: 1_000,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(result.rejectedByReason.current_tick_floor_unknown).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
  });

  it("非 ResourceControl tick 有效底价缓存且 live 净价满足不变量时保持订单", () => {
    validConfig("maker");
    const market = installMarket({
      orders: { managed: order("managed", { price: 2 }) },
    });
    installManagedOrder("managed");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time - 1,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          effectiveNetFloor: 1.1,
          protectionEntry: protectionEntry({
            managedExposure: 1_000,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(result.rejectedByReason.current_tick_floor_violation).toBeUndefined();
    expect(result.rejectedByReason.current_tick_floor_unknown).toBeUndefined();
    expect(market.cancelOrder).not.toHaveBeenCalled();
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toBeUndefined();
  });

  it("economicFloor 为零时视为无额外底线，非 ResourceControl tick 不反复撤单", () => {
    validConfig("maker");
    Memory.cfg!.marketSaleAutomation!.economicFloor![RESOURCE_KEANIUM] = 0;
    const market = installMarket({
      orders: { managed: order("managed", { price: 2 }) },
    });
    installManagedOrder("managed");
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time - 1,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
      },
    };

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          effectiveNetFloor: 1.1,
          protectionEntry: protectionEntry({
            managedExposure: 1_000,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(result.rejectedByReason.current_tick_floor_unknown).toBeUndefined();
    expect(result.rejectedByReason.current_tick_floor_violation).toBeUndefined();
    expect(market.cancelOrder).not.toHaveBeenCalled();
  });

  it("维护托管单时只排除自身暴露，现有剩余量仍安全则不误撤单", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed"),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          protectionEntry: protectionEntry({
            totalStock: 7_000,
            terminalStock: 1_000,
            grossSurplus: 1_000,
            managedExposure: 1_000,
            newExposureCapacity: 0,
            sellableAmount: 0,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(
      result.rejectedByReason.managed_order_candidate_rejected,
    ).toBeUndefined();
    expect(market.cancelOrder).not.toHaveBeenCalled();
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toBeUndefined();
  });

  it("生产需求抢占后自排除可售量不足 live remaining，立即撤销托管单", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed"),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          protectionEntry: protectionEntry({
            totalStock: 7_000,
            terminalStock: 1_000,
            productionDemand: 100,
            protectedAmount: 6_100,
            grossSurplus: 900,
            managedExposure: 1_000,
            newExposureCapacity: 0,
            sellableAmount: 0,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
            ],
          }),
        }),
      ],
    });

    expect(
      result.rejectedByReason.managed_order_candidate_rejected,
    ).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toMatchObject({ kind: "cancel", status: "submitted" });
  });

  it("自排除不会释放其他 managed 暴露，其他订单占用导致不足时撤单", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed"),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const result = runMarketSaleAutomation({
      candidates: [
        candidate({
          protectionEntry: protectionEntry({
            totalStock: 7_100,
            terminalStock: 1_100,
            grossSurplus: 1_100,
            managedExposure: 1_200,
            newExposureCapacity: 0,
            sellableAmount: 0,
            sourceContributions: [
              managedExposureContribution("managed", 1_000),
              managedExposureContribution("other-managed", 200),
            ],
          }),
        }),
      ],
    });

    expect(
      result.rejectedByReason.managed_order_candidate_rejected,
    ).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
  });

  it("锁定候选从新鲜规划输入消失时撤销已有托管暴露", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed", { price: 2 }),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const result = runMarketSaleAutomation({ candidates: [] });

    expect(
      result.rejectedByReason.managed_order_locked_candidate_missing,
    ).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
  });

  it("policy TTL 到期只撤销对应 managed ID，不影响手工订单", () => {
    validConfig("maker");
    const market = installMarket({
      orders: {
        managed: order("managed"),
        manual: order("manual", { roomName: "W2N2" }),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.managedOrders.managed
      .policyCancelAtTick = Game.time;

    const result = runMarketSalePreflight();

    expect(result.rejectedByReason.managed_order_policy_ttl_expired).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledTimes(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(market.cancelOrder).not.toHaveBeenCalledWith("manual");
    expect(market.orders.manual).toBeDefined();
  });

  it("外部扩量即使被并发成交掩盖 remaining 增长，也撤单并持续阻断到 operator 对账", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed", {
          totalAmount: 1_500,
          remainingAmount: 900,
          amount: 900,
        }),
        manual: order("manual", { roomName: "W2N2" }),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;

    const detected = runMarketSaleAutomation({
      candidates: [candidate()],
    });

    expect(detected.rejectedByReason.managed_order_external_mutation).toBe(1);
    expect(market.cancelOrder).toHaveBeenCalledTimes(1);
    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(market.cancelOrder).not.toHaveBeenCalledWith("manual");
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed
        .externalMutationGap,
    ).toMatchObject({
      expectedTotalAmount: 1_000,
      observedTotalAmount: 1_500,
      conservativeExposure: 1_000,
    });
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toMatchObject({
      reason: "external_order_mutation",
      orderId: "managed",
    });

    Memory.cfg!.marketSaleAutomation!.mode = "off";
    market.orders = { manual: market.orders.manual };
    Game.time += 1;
    const cancelled = runMarketSalePreflight();

    expect(cancelled.phase).toMatch(/requested|draining/);
    expect(
      Memory.data?.marketSaleAutomation?.pendingMutations.managed,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed,
    ).toBeDefined();
    expect(Memory.runtime?.marketSaleAutomation?.exposureAmount).toBe(1_000);
    expect(
      resolveMarketSaleExternalOrderMutation("managed", 99_999),
    ).toMatchObject({
      ok: false,
      error: "verified_fee_debt_below_known_debt",
    });

    expect(
      resolveMarketSaleExternalOrderMutation("managed", 125_000),
    ).toMatchObject({
      ok: true,
      orderId: "managed",
      carriedFeeDebtMilli: 125_000,
    });
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBe(125_000);
    expect(market.orders.manual).toBeDefined();
  });

  it("多个 external mutation gap 逐个 exact-ID 解决并保持单一 carried debt 权威", () => {
    validConfig("maker");
    const market = installMarket({
      orders: {
        first: order("first", { price: 2.5 }),
        second: order("second", { price: 2.5 }),
      },
    });
    installManagedOrder("first");
    const first =
      Memory.data!.marketSaleAutomation!.managedOrders.first;
    Memory.data!.marketSaleAutomation!.managedOrders.second = {
      ...first,
      orderId: "second",
    };

    runMarketSalePreflight();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toMatchObject({ orderId: "first" });

    market.orders = {};
    Game.time += 1;
    runMarketSalePreflight();

    expect(
      resolveMarketSaleExternalOrderMutation("first", 110_000),
    ).toMatchObject({ ok: true });
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toMatchObject({
      reason: "external_order_mutation",
      orderId: "second",
    });
    expect(
      resolveMarketSaleExternalOrderMutation("second", 120_000),
    ).toMatchObject({ ok: true });
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBe(230_000);
  });

  it("unknown disappearance 只能由 exact-ID operator 分类收敛，server expiry 必须核验退款", () => {
    validConfig("maker");
    const market = installMarket({
      orders: {
        manual: order("manual", { roomName: "W2N2" }),
      },
    });
    installManagedOrder("managed");

    runMarketSalePreflight();

    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed
        .disappearanceGap,
    ).toMatchObject({ reason: "unknown_disappearance" });
    expect(
      (resolveMarketSaleOrderDisappearance as any)(
        "managed",
        "unknown",
      ),
    ).toMatchObject({
      ok: false,
      error: "disappearance_classification_invalid",
    });
    expect(
      resolveMarketSaleOrderDisappearance(
        "managed",
        "server_expired",
      ),
    ).toMatchObject({
      ok: false,
      error: "verified_refund_milli_required",
    });
    expect(
      resolveMarketSaleOrderDisappearance(
        "managed",
        "server_expired",
        40_000,
      ),
    ).toMatchObject({
      ok: true,
      refundedFeeDebtMilli: 40_000,
      carriedFeeDebtMilli: 60_000,
    });
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.reconcileGap,
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBe(60_000);
    expect(market.orders.manual).toBeDefined();
  });

  it("operator 确认 policy cancellation 时不假设退款并 carry 全部剩余费用", () => {
    validConfig("maker");
    installMarket();
    installManagedOrder("managed");
    runMarketSalePreflight();

    expect(
      resolveMarketSaleOrderDisappearance(
        "managed",
        "policy_cancelled",
      ),
    ).toMatchObject({
      ok: true,
      refundedFeeDebtMilli: 0,
      carriedFeeDebtMilli: 100_000,
    });
    expect(
      Memory.data?.marketSaleAutomation?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBe(100_000);
  });

  it("无 pending mutation 的外部调价不会被吸收到托管账本", () => {
    qualifyMaker();
    const canaryLock = Memory.data!.marketSaleAutomation!.canaryLock!;
    const market = installMarket({
      orders: {
        managed: order("managed", { price: 2.5 }),
      },
    });
    installManagedOrder("managed");
    Memory.data!.marketSaleAutomation!.canaryLock = canaryLock;

    runMarketSalePreflight();

    expect(market.cancelOrder).toHaveBeenCalledWith("managed");
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed
        .externalMutationGap,
    ).toMatchObject({
      expectedPrice: 2,
      observedPrice: 2.5,
    });
    expect(
      Memory.data?.marketSaleAutomation?.managedOrders.managed.price,
    ).toBe(2);
  });

  it("maker 在 createOrder 前先持久化 pendingCreate，并在 lease 下锁定唯一 canary", () => {
    qualifyMaker();
    const market = installMarket();
    const observedStatuses: unknown[] = [];
    market.createOrder = jest.fn(() => {
      observedStatuses.push(
        Memory.data?.marketSaleAutomation?.pendingCreate?.status,
      );
      return OK;
    });
    const lease = grantMarketSaleMutationLease("lease-1", Game.time + 10);
    expect(lease.ok).toBe(true);

    const result = runMarketSaleAutomation({ candidates: [candidate()] });

    expect(result.phase).toBe("maker");
    expect(result.writes).toBe(1);
    expect(observedStatuses).toEqual(["prepared"]);
    expect(market.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ORDER_SELL,
        resourceType: RESOURCE_KEANIUM,
        roomName: "W1N1",
        totalAmount: 1_000,
      }),
    );
    expect(Memory.data?.marketSaleAutomation?.pendingCreate?.status).toBe(
      "submitted",
    );
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.feeEvents,
    ).toEqual([
      expect.objectContaining({
        action: "create",
        tick: Game.time,
      }),
    ]);
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.sameTickReservations,
    ).toEqual([
      expect.objectContaining({
        status: "committed",
        tick: Game.time,
      }),
    ]);
    expect(
      Memory.data?.marketSaleAutomation?.pendingCreate?.tuple,
    ).toMatchObject({
      createdNotBefore: Game.time,
      createdNotAfter: Game.time + 2,
    });
    expect(Memory.data?.marketSaleAutomation?.canaryLock).toMatchObject({
      roomName: "W1N1",
      resourceType: RESOURCE_KEANIUM,
      configRevision: "rev-1",
    });
    expect(Memory.data?.marketSaleAutomation?.managedOrders).toEqual({});
  });

  it("ResourceControl send claim 阻止同 tick maker，下一 tick 重算后才允许创建", () => {
    qualifyMaker();
    const market = Game.market as MutableMarket;
    const terminal = Game.rooms.W1N1.terminal!;
    expect(
      executeTerminalSend({
        terminal,
        resourceType: RESOURCE_KEANIUM,
        amount: 500,
        transactionCost: 100,
        destinationRoomName: "W2N2",
        actor: "resourceControl:test-send",
      }),
    ).toBe(OK);
    expect(grantMarketSaleMutationLease("lease-claim", Game.time + 10).ok).toBe(
      true,
    );

    const claimed = runMarketSaleAutomation({ candidates: [candidate()] });

    expect(claimed.rejectedByReason.terminal_claimed).toBeGreaterThan(0);
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.feeLedger?.sameTickReservations || [],
    ).toEqual([]);

    Game.time += 1;
    Memory.runtime!.resourceControl!.updatedAt = Game.time;
    const nextTick = runMarketSaleAutomation({
      candidates: [
        candidate({ protectionEntry: protectionEntry() }),
      ],
    });

    expect(nextTick.writes).toBe(1);
    expect(market.createOrder).toHaveBeenCalledTimes(1);
    expect(Memory.data?.marketSaleAutomation?.pendingCreate?.status).toBe(
      "submitted",
    );
  });

  it("maker 最终写前重读 Terminal 资源并拒绝账本无法覆盖的数量", () => {
    qualifyMaker();
    const market = Game.market as MutableMarket;
    const terminal = Game.rooms.W1N1.terminal!;
    const originalGetUsedCapacity =
      terminal.store.getUsedCapacity.bind(terminal.store);
    (terminal.store as unknown as {
      getUsedCapacity: (resource?: ResourceConstant) => number;
    }).getUsedCapacity = (resource?: ResourceConstant) =>
      resource === RESOURCE_KEANIUM
        ? 500
        : originalGetUsedCapacity(resource);
    expect(grantMarketSaleMutationLease("lease-resource", Game.time + 10).ok).toBe(
      true,
    );

    const result = runMarketSaleAutomation({ candidates: [candidate()] });

    expect(
      result.rejectedByReason.maker_amount_no_longer_sellable,
    ).toBeGreaterThan(0);
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toBeUndefined();
  });

  it("maker 最终写前在资源快照后重读 Terminal energy", () => {
    qualifyMaker();
    const market = Game.market as MutableMarket;
    const terminal = Game.rooms.W1N1.terminal!;
    const originalGetUsedCapacity =
      terminal.store.getUsedCapacity.bind(terminal.store);
    let finalResourceRead = false;
    (terminal.store as unknown as {
      getUsedCapacity: (resource?: ResourceConstant) => number;
    }).getUsedCapacity = (resource?: ResourceConstant) => {
      if (resource === RESOURCE_KEANIUM) {
        finalResourceRead = true;
        return originalGetUsedCapacity(resource);
      }
      if (resource === RESOURCE_ENERGY && finalResourceRead) return 10_000;
      return originalGetUsedCapacity(resource);
    };
    expect(grantMarketSaleMutationLease("lease-energy", Game.time + 10).ok).toBe(
      true,
    );

    const result = runMarketSaleAutomation({ candidates: [candidate()] });

    expect(result.rejectedByReason.terminal_energy).toBeGreaterThan(0);
    expect(market.createOrder).not.toHaveBeenCalled();
    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toBeUndefined();
  });

  it("下一 tick 仅在完整 tuple 唯一匹配且 lease 有效时认领订单", () => {
    qualifyMaker();
    const market = installMarket();
    grantMarketSaleMutationLease("lease-1", Game.time + 10);
    runMarketSaleAutomation({ candidates: [candidate()] });
    const pending = Memory.data!.marketSaleAutomation!.pendingCreate!;

    Game.time += 1;
    market.orders = {
      auto: order("auto", {
        created: pending.tuple.createdNotBefore,
        price: pending.tuple.price,
        totalAmount: pending.tuple.totalAmount,
        remainingAmount: pending.tuple.totalAmount,
        amount: pending.tuple.totalAmount,
      }),
    };
    runMarketSalePreflight();

    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toBeUndefined();
    expect(Memory.data?.marketSaleAutomation?.managedOrders.auto).toMatchObject({
      orderId: "auto",
      remainingExposure: 1_000,
      resourceType: RESOURCE_KEANIUM,
      serverCreatedTick: pending.tuple.createdNotBefore,
    });
  });

  it("Pending Create 两次零差集但账本证据不足时保持围栏，operator 可继续收敛", () => {
    qualifyMaker();
    const market = installMarket();
    grantMarketSaleMutationLease("lease-evidence", Game.time + 20);
    runMarketSaleAutomation({ candidates: [candidate()] });

    Game.time += 1;
    runMarketSalePreflight();
    Game.time += 1;
    const unresolved = runMarketSalePreflight();

    expect(
      unresolved.rejectedByReason[
        "pending_create:zero_delta_evidence_incomplete"
      ],
    ).toBe(1);
    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toMatchObject({
      status: "ambiguous",
      exposure: 1_000,
    });
    expect(market.orders).toEqual({});

    Memory.data = JSON.parse(JSON.stringify(Memory.data));
    expect(resolveMarketSalePendingCreateAbsence([])).toMatchObject({
      ok: true,
      confirmationsRequired: 2,
    });
    Game.time += 1;
    runMarketSalePreflight();
    Game.time += 1;
    runMarketSalePreflight();

    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBeGreaterThan(0);
  });

  it("Pending Create 只有 credit、terminal 与 outgoing 后证据闭合才自动确认 absent", () => {
    qualifyMaker();
    const market = installMarket();
    grantMarketSaleMutationLease("lease-absent", Game.time + 20);
    runMarketSaleAutomation({ candidates: [candidate()] });
    const pending = Memory.data!.marketSaleAutomation!.pendingCreate!;
    market.credits =
      pending.creditsBefore! - pending.feeMilli / 1_000;

    Game.time += 1;
    runMarketSalePreflight();
    Game.time += 1;
    runMarketSalePreflight();

    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toBeUndefined();
    expect(
      Memory.data?.marketSaleAutomation?.carriedFeeDebtMilli[
        RESOURCE_KEANIUM
      ],
    ).toBe(pending.feeMilli);
  });

  it("lease 失效后即使 tuple 唯一也不自动认领，只接受 operator exact-ID attestation", () => {
    qualifyMaker();
    const market = installMarket();
    grantMarketSaleMutationLease("lease-short", Game.time + 1);
    runMarketSaleAutomation({ candidates: [candidate()] });
    const pending = Memory.data!.marketSaleAutomation!.pendingCreate!;

    Game.time += 2;
    market.orders = {
      exact: order("exact", {
        created: pending.tuple.createdNotBefore,
        price: pending.tuple.price,
        totalAmount: pending.tuple.totalAmount,
        remainingAmount: pending.tuple.totalAmount,
        amount: pending.tuple.totalAmount,
      }),
    };
    runMarketSalePreflight();

    expect(Memory.data?.marketSaleAutomation?.pendingCreate?.status).toBe(
      "ambiguous",
    );
    expect(Memory.data?.marketSaleAutomation?.managedOrders.exact).toBeUndefined();

    const attested = attestMarketSalePendingCreate("exact");
    expect(attested).toMatchObject({ ok: true, orderId: "exact" });
    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toBeUndefined();
    expect(Memory.data?.marketSaleAutomation?.managedOrders.exact).toBeDefined();
  });

  it("operator absence resolution 不会删除仍存候选，且紧停入口只请求状态机排空", () => {
    qualifyMaker();
    const market = installMarket();
    grantMarketSaleMutationLease("lease-1", Game.time + 10);
    runMarketSaleAutomation({ candidates: [candidate()] });
    market.orders = { suspicious: order("suspicious") };

    const refused = resolveMarketSalePendingCreateAbsence(["suspicious"]);
    expect(refused).toMatchObject({
      ok: false,
      error: "candidate_still_present",
    });
    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toBeDefined();

    const stopped = emergencyStopMarketSaleAutomation("test");
    expect(stopped.ok).toBe(true);
    expect(Memory.cfg?.marketSaleAutomation?.mode).toBe("emergencyStop");
    expect(Memory.data?.marketSaleAutomation?.pendingCreate).toBeDefined();
  });

  it("emergencyStop 仅在 live ID、pending 与 exposure 归零后跨两个 tick 进入 stopped", () => {
    validConfig("emergencyStop");
    const market = installMarket({ orders: { managed: order("managed") } });
    installManagedOrder("managed");

    expect(runMarketSalePreflight().phase).toMatch(/requested|draining/);
    market.orders = {};
    Game.time += 1;
    expect(runMarketSalePreflight().phase).toBe("draining");
    Game.time += 1;
    expect(runMarketSalePreflight().phase).toBe("stopped");
    expect(Memory.data?.marketSaleAutomation?.managedOrders).toEqual({});
    expect(Memory.data?.marketSaleAutomation?.pendingMutations).toEqual({});
    expect(Memory.runtime?.marketSaleAutomation?.exposureAmount).toBe(0);
  });

  it("preflight 从 canonical stores 读取 staging/reservation，非空或损坏时阻断 stopped", () => {
    validConfig("emergencyStop");
    runMarketSalePreflight();
    Memory.data!.marketSaleAutomation!.marketStaging = {
      "stage:x": { amount: 1_000 },
    };
    Memory.data!.marketSaleAutomation!.marketReservations = {
      "reservation:x": { amount: 250 },
    };
    Game.time += 1;

    expect(runMarketSalePreflight().phase).toMatch(/requested|draining/);
    expect(Memory.runtime!.marketSaleAutomation).toMatchObject({
      stagingAmount: 1_000,
      reservationAmount: 250,
      zeroConfirmations: 0,
    });

    (
      Memory.data!.marketSaleAutomation as unknown as {
        marketStaging: unknown;
      }
    ).marketStaging = [];
    Game.time += 1;
    const malformed = runMarketSalePreflight();
    expect(malformed.phase).toMatch(/requested|draining/);
    expect(malformed.rejectedByReason).toHaveProperty(
      "market_domain_activity_invalid",
    );
    expect(Memory.runtime!.marketSaleAutomation!.stagingAmount).toBe(1);

    Memory.data!.marketSaleAutomation!.marketStaging = {
      ghost: { amount: 0 },
    };
    Game.time += 1;
    const zeroRecord = runMarketSalePreflight();
    expect(zeroRecord.phase).toMatch(/requested|draining/);
    expect(zeroRecord.rejectedByReason).toHaveProperty(
      "market_domain_activity_invalid",
    );
    expect(Memory.runtime!.marketSaleAutomation!.stagingAmount).toBe(1);

    Memory.data!.marketSaleAutomation!.marketStaging = {};
    Memory.data!.marketSaleAutomation!.marketReservations = {};
    Game.time += 1;
    expect(runMarketSalePreflight().phase).toBe("draining");
    Game.time += 1;
    expect(runMarketSalePreflight().phase).toBe("stopped");
  });

  it("精确 reviewed v1 证据通过编排层确定性迁移为 readyForPermit，且部署本身零写", () => {
    installContinuousDirectConfig();
    installExactReviewedLegacyDirectState();

    const result = runMarketSalePreflight();
    const direct = Memory.data!.marketSaleAutomation!
      .directAutomation as unknown as Record<string, unknown>;

    expect(result.writes).toBe(0);
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(direct).toMatchObject({
      schemaVersion: 2,
      capability: "market-direct-continuous",
      migrationStatus: "readyForPermit",
    });
    expect(direct.migrationBlockedReason).toBeUndefined();
    expect(marketDirectContinuousStatus()).toMatchObject({
      migrationStatus: "readyForPermit",
      lifecycleByEntry: {
        "base-x-e6n59-v1": {
          stage: "review_paused",
          canaryConfirmedCount: 1,
        },
        "base-h-e3n59-v1": { stage: "shadow" },
        "base-z-e7n57-v1": { stage: "shadow" },
      },
    });
  });

  it("Direct capability 缺失 canonical 状态时全程零写并进入 emergencyStop", () => {
    installContinuousDirectConfig();
    Memory.data = {};

    const result = runMarketSalePreflight();

    expect(result.writes).toBe(0);
    expect(result.effectiveMode).toBe("emergencyStop");
    expect(result.rejectedByReason).toHaveProperty(
      "direct_state_missing",
    );
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(Game.market.createOrder).not.toHaveBeenCalled();
    expect(Game.market.cancelOrder).not.toHaveBeenCalled();
  });

  it("编排层 permit 入口只在精确迁移后签发 epoch1，并保持 H/Z 为 Shadow", () => {
    installContinuousDirectConfig();
    installExactReviewedLegacyDirectState();
    const terminal = installRoom(
      "E6N59",
      RESOURCE_CATALYST,
    );
    (
      Game.rooms.E6N59.controller as StructureController & {
        owner?: Owner;
      }
    ).owner = { username: "forst" };
    (
      terminal as StructureTerminal & { owner?: Owner }
    ).owner = { username: "forst" };
    (
      Game as unknown as {
        shard: { name: string; type: string; ptr: boolean };
      }
    ).shard = {
      name: "shard1",
      type: "normal",
      ptr: false,
    };
    runMarketSalePreflight();

    const proposal = proposeMarketDirectContinuousPermit({
      operatorAuthorizationFingerprint:
        "operator:codex:test-reviewed-epoch1",
    }) as {
      ok: boolean;
      permit?: {
        permitId: string;
        entryGrants: Array<{
          entryId: string;
          stage: string;
          newDealGrant: string;
        }>;
      };
      error?: string;
    };

    expect(proposal.ok).toBe(true);
    expect(proposal.permit?.entryGrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryId: "base-x-e6n59-v1",
          stage: "continuous",
          newDealGrant: "enabled",
        }),
        expect.objectContaining({
          entryId: "base-h-e3n59-v1",
          stage: "shadow",
          newDealGrant: "suspended",
        }),
        expect.objectContaining({
          entryId: "base-z-e7n57-v1",
          stage: "shadow",
          newDealGrant: "suspended",
        }),
      ]),
    );

    const accepted = acceptMarketDirectContinuousPermit(
      proposal.permit!.permitId,
    );
    expect(accepted).toMatchObject({
      ok: true,
      permitId: proposal.permit!.permitId,
    });
    expect(marketDirectContinuousStatus()).toMatchObject({
      migrationStatus: "active",
      permit: { epoch: 1 },
      lifecycleByEntry: {
        "base-x-e6n59-v1": { stage: "continuous" },
        "base-h-e3n59-v1": { stage: "shadow" },
        "base-z-e7n57-v1": { stage: "shadow" },
      },
    });
  });

  it("损坏的 market-sale 容器在 Continuous Direct 下保留证据并全局零写", () => {
    installContinuousDirectConfig();
    Memory.data = {
      marketSaleAutomation: null,
    } as unknown as Memory["data"];

    const result = runMarketSalePreflight();
    const direct = Memory.data!.marketSaleAutomation!
      .directAutomation as unknown as {
        migrationBlockedReason?: string;
        quarantinedPendingDirectDeals: Record<string, unknown>;
      };

    expect(result.writes).toBe(0);
    expect(result.effectiveMode).toBe("emergencyStop");
    expect(direct.migrationBlockedReason).toBeDefined();
    expect(
      Object.keys(direct.quarantinedPendingDirectDeals).length,
    ).toBeGreaterThan(0);
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(Game.market.createOrder).not.toHaveBeenCalled();
    expect(Game.market.cancelOrder).not.toHaveBeenCalled();
    expect(Game.market.extendOrder).not.toHaveBeenCalled();
    expect(Game.market.changeOrderPrice).not.toHaveBeenCalled();
  });
});
