import {
  runMarketSaleAutomation,
  type MarketSalePlanCandidate,
} from "@/runtime/marketSaleAutomation";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import type { MarketProtectionEntry } from "@/runtime/marketSaleProtection";

function installDirectConfig(): void {
  Memory.cfg = {
    resourceControl: {
      market: {
        enabled: true,
        emergencyBuyEnabled: true,
      },
    },
    factoryControl: {
      market: {
        enabled: true,
        purchaseEnabled: true,
      },
    },
    marketSaleAutomation: {
      mode: "shadow",
      shadowStrategy: "direct",
      configRevision: "direct-x-entry-r1",
      sellResources: [RESOURCE_CATALYST],
      hardFloor: { [RESOURCE_CATALYST]: 600 },
      economicFloor: { [RESOURCE_CATALYST]: 600 },
      forecastBuffer: { [RESOURCE_CATALYST]: 100_000 },
      minDealAmount: 1_000,
      makerBatchAmount: 5_000,
      creditReserve: 10_000,
      terminalEnergyReserve: 25_000,
      energyShadowHardFloor: 20,
      canary: { enabled: true, allowExpansion: false },
    },
  };
}

function marketOrder(
  id: string,
  price: number,
  amount: number,
  roomName: string,
): Order {
  return {
    id,
    created: 1,
    type: ORDER_BUY,
    resourceType: RESOURCE_CATALYST,
    roomName,
    price,
    totalAmount: amount,
    remainingAmount: amount,
    amount,
    active: true,
  } as Order;
}

function installMarketAndRoom(): Market {
  const orders = [
    marketOrder("lower-large", 640, 5_000, "E1N1"),
    marketOrder("top-small", 665.8, 1_000, "E51S9"),
  ];
  const market = {
    orders: {},
    credits: 10_000_000,
    outgoingTransactions: [],
    incomingTransactions: [],
    getAllOrders: jest.fn(() => orders),
    getOrderById: jest.fn((id: string) =>
      orders.find((order) => order.id === id) || null),
    getHistory: jest.fn(() => []),
    calcTransactionCost: jest.fn(
      (amount: number, _from: string, to: string) =>
        amount === 1 ? (to === "E51S9" ? 1 : 0) : to === "E51S9" ? 900 : 100,
    ),
    deal: jest.fn(() => OK),
    createOrder: jest.fn(() => OK),
    cancelOrder: jest.fn(() => OK),
    extendOrder: jest.fn(() => OK),
    changeOrderPrice: jest.fn(() => OK),
  } as unknown as Market;
  (Game as unknown as { market: Market }).market = market;

  const amounts: Partial<Record<ResourceConstant, number>> = {
    [RESOURCE_CATALYST]: 72_047,
    [RESOURCE_ENERGY]: 50_000,
  };
  const terminal = {
    cooldown: 0,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource ? amounts[resource] || 0 : 122_047,
      getFreeCapacity: () => 177_953,
    },
  } as unknown as StructureTerminal;
  Game.rooms.E6N59 = {
    name: "E6N59",
    terminal,
    controller: { my: true },
  } as unknown as Room;
  return market;
}

function protection(tick: number): MarketProtectionEntry {
  return {
    roomName: "E6N59",
    resource: RESOURCE_CATALYST,
    revision: tick,
    observedAt: tick,
    expiresAt: tick,
    totalStock: 192_388,
    terminalStock: 72_047,
    hardReserve: 12_100,
    productionDemand: 0,
    forecastBuffer: 100_000,
    protectedOutgoing: 0,
    carrierOrInFlight: 0,
    protectedAmount: 112_100,
    grossSurplus: 80_288,
    managedExposure: 0,
    newExposureCapacity: 80_288,
    sellableAmount: 72_047,
    fresh: true,
    blocked: false,
    blockedReasons: [],
    issues: [],
    sourceContributions: [],
  };
}

function candidate(tick: number): MarketSalePlanCandidate {
  return {
    roomName: "E6N59",
    resourceType: RESOURCE_CATALYST,
    protectionEntry: protection(tick),
    effectiveNetFloor: 600,
    directHistoryTrusted: true,
    effectiveEnergyShadowPrice: 26.8,
    energyShadowObservedAt: tick,
    energyShadowComponents: {
      hardFloor: 20,
      historyFloor: 26.8,
      ratchetFloor: 25.46,
    },
    directAdditionalRejectionReasons: [],
    trustedPrice: false,
    trustedDepth: false,
    capacityState: "pressure",
    hasCriticalConflict: false,
    isHubRoom: false,
  };
}

describe("marketSaleAutomation Direct production entry", () => {
  beforeEach(() => {
    clearMarketActionArbiterForTest();
    Memory.cfg = {};
    Memory.data = {};
    Memory.runtime = {};
    for (const roomName of Object.keys(Game.rooms)) {
      delete Game.rooms[roomName];
    }
    Game.time = 10;
    installDirectConfig();
  });

  it("接入 Direct Shadow、绕过 Maker 深度，并在非规划 tick 保留快照", () => {
    const market = installMarketAndRoom();

    Memory.runtime!.resourceControl = {
      updatedAt: 10,
      rooms: {},
      lastActions: [],
      lastMarketActions: [],
    };
    expect(
      runMarketSaleAutomation({ candidates: [candidate(10)] }).phase,
    ).toBe("draining");

    Game.time = 11;
    Memory.runtime!.resourceControl!.updatedAt = 10;
    expect(runMarketSaleAutomation().phase).toBe("shadow");

    Game.time = 20;
    Memory.runtime!.resourceControl!.updatedAt = 20;
    const shadow = runMarketSaleAutomation({
      candidates: [candidate(20)],
    });
    expect(shadow.writes).toBe(0);
    expect(market.deal).not.toHaveBeenCalled();
    expect(Memory.runtime!.marketSaleAutomation!.direct).toMatchObject({
      strategyActive: true,
      shadowConsecutiveCycles: 1,
      pendingCount: 0,
      confirmedDealCount: 0,
      pausedForReview: false,
      snapshot: {
        observedAt: 20,
        age: 0,
        fresh: true,
        result: "safe_opportunity",
        buyBook: {
          selectedOrderId: "top-small",
        },
        opportunity: {
          orderId: "top-small",
          price: 665.8,
          dealAmount: 1_000,
        },
      },
    });
    const candidatesBefore =
      Memory.runtime!.marketSaleAutomation!.candidates;

    Game.time = 21;
    Memory.runtime!.resourceControl!.updatedAt = 20;
    runMarketSaleAutomation();

    expect(
      Memory.runtime!.marketSaleAutomation!.candidates,
    ).toBe(candidatesBefore);
    expect(
      Memory.runtime!.marketSaleAutomation!.direct?.snapshot,
    ).toMatchObject({
      observedAt: 20,
      age: 1,
      fresh: true,
      opportunity: { orderId: "top-small" },
    });
  });
});
