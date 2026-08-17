import {
  rankDirectCurrentBuyOrders,
} from "@/runtime/marketSaleDirectPricing";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";

function order(
  id: string,
  price: number,
  amount = 1_000,
  roomName = "E51S9",
  type: "buy" | "sell" = "buy",
  resourceType = "X",
): MarketOrderSnapshot {
  return {
    id,
    type,
    resourceType,
    price,
    amount,
    roomName,
  };
}

function rank(
  orders: readonly MarketOrderSnapshot[],
  overrides: Partial<Parameters<typeof rankDirectCurrentBuyOrders>[0]> = {},
) {
  return rankDirectCurrentBuyOrders({
    orders,
    resourceType: "X",
    ownOrderIds: [],
    sellableAmount: 72_047,
    terminalStock: 72_047,
    effectiveNetFloor: 600,
    effectiveEnergyShadowPrice: 26.8,
    maxTransactionEnergyAvailable: 1_000,
    calculateTransactionEnergy: (amount) => (amount === 1 ? 1 : 900),
    ...overrides,
  });
}


describe("Direct current BUY pricing", () => {

  it("排除超过 terminal reservation 外能量的高价远单，并选择可执行的次高净价单", () => {
    const result = rank([
      order("far-high", 700, 1_000, "W50N50"),
      order("near-safe", 665, 1_000, "E7N59"),
    ], {
      maxTransactionEnergyAvailable: 500,
      calculateTransactionEnergy: (amount, candidate) => {
        if (amount === 1) return 1;
        return candidate.id === "far-high" ? 900 : 100;
      },
    });

    expect(result.selected?.order.id).toBe("near-safe");
    expect(result.rejectedOrders).toContainEqual({
      orderId: "far-high",
      reason: "transaction_energy_exceeded",
    });
  });

  it("requires both planned-size and amount-one conservative totals to clear the floor", () => {
    const plannedUnsafe = rank([order("planned-unsafe", 630)], {
      effectiveEnergyShadowPrice: 31,
      calculateTransactionEnergy: (amount) => (amount === 1 ? 1 : 1_000),
    });
    expect(plannedUnsafe.candidates).toEqual([]);
    expect(plannedUnsafe.rejectedOrders).toContainEqual({
      orderId: "planned-unsafe",
      reason: "planned_net_below_floor",
    });

    const partialUnsafe = rank([order("partial-unsafe", 625)], {
      effectiveEnergyShadowPrice: 26,
      calculateTransactionEnergy: (amount) => (amount === 1 ? 1 : 1),
    });
    expect(partialUnsafe.candidates).toEqual([]);
    expect(partialUnsafe.rejectedOrders).toContainEqual({
      orderId: "partial-unsafe",
      reason: "worst_case_net_below_floor",
    });
  });
});
