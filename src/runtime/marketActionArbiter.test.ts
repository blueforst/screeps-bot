import {
  claimPreparedDirectMarketClaims,
  clearMarketActionArbiterForTest,
  declareMarketActionIntent,
  executeCancelOrder,
  executeChangeOrderPrice,
  executeCreateOrder,
  executeExtendOrder,
  executeMarketDeal,
  executePreparedDirectMarketDeal,
  executeTerminalAction,
  executeTerminalSend,
  getMarketAccountClaim,
  getMarketActionJournal,
  getTerminalActionClaim,
  getTerminalActionClaims,
  hasMarketAccountClaim,
  hasMarketActionIntentThisTick,
  hasTerminalActionClaim,
  releasePreparedDirectMarketClaims,
} from "@/runtime/marketActionArbiter";
import {
  clearMarketSaleExposureReservationsForTest,
  getTerminalAmountOutsideMarketSaleExposure,
} from "@/runtime/marketSaleExposure";

interface WritableMarketMock {
  deal: jest.Mock;
  calcTransactionCost: jest.Mock;
  createOrder: jest.Mock;
  extendOrder: jest.Mock;
  changeOrderPrice: jest.Mock;
  cancelOrder: jest.Mock;
}

function installMarketMock(overrides: Partial<WritableMarketMock> = {}): WritableMarketMock {
  const market: WritableMarketMock = {
    deal: jest.fn(() => OK),
    calcTransactionCost: jest.fn(() => 0),
    createOrder: jest.fn(() => OK),
    extendOrder: jest.fn(() => OK),
    changeOrderPrice: jest.fn(() => OK),
    cancelOrder: jest.fn(() => OK),
    ...overrides,
  };
  (Game as unknown as { market: WritableMarketMock }).market = market;
  return market;
}

function installTerminal(
  roomName: string,
  amounts: Partial<Record<ResourceConstant, number>> = {},
): StructureTerminal {
  const room = { name: roomName } as Room;
  const terminal = {
    id: `${roomName}-terminal`,
    room,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource ? (amounts[resource] || 0) : 0,
    },
  } as unknown as StructureTerminal;
  room.terminal = terminal;
  Game.rooms[roomName] = room;
  return terminal;
}

function executeProductionBuy(
  orderId: string,
  amount: number,
  roomName: string,
  actor: string,
): ScreepsReturnCode {
  return executeMarketDeal(
    orderId,
    amount,
    roomName,
    actor,
    {
      orderType: ORDER_SELL,
      resourceType: RESOURCE_KEANIUM,
      orderRoomName: "W7N7",
    },
  );
}

describe("market action arbiter", () => {
  beforeEach(() => {
    Game.time = 100;
    Memory.data = undefined;
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    for (const roomName of ["W1N1", "W2N2", "W8N8", "W9N9"]) {
      installTerminal(roomName, {
        [RESOURCE_ENERGY]: 100_000,
        [RESOURCE_KEANIUM]: 100_000,
      });
    }
  });

  it("Direct gap 后生产购买不能消耗 transaction-energy exposure", () => {
    const terminal = installTerminal("W8N8", {
      [RESOURCE_ENERGY]: 1_000,
    });
    const market = installMarketMock({
      calcTransactionCost: jest.fn(() => 200),
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-gap-energy",
            status: "reconcile_gap",
            canaryRoomName: "W8N8",
            resource: RESOURCE_KEANIUM,
            dealAmount: 1_000,
            transactionEnergy: 900,
          },
        },
      },
    } as unknown as Memory["data"];

    expect(
      executeProductionBuy(
        "production-buy",
        100,
        "W8N8",
        "resourceControl:legacy-mineral-buy",
      ),
    ).toBe(ERR_NOT_ENOUGH_RESOURCES);
    expect(market.deal).not.toHaveBeenCalled();
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_ENERGY,
      ),
    ).toBe(100);
    expect(getMarketActionJournal()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: "resourceControl:legacy-mineral-buy",
        outcome: "non_ok",
        resultCode: ERR_NOT_ENOUGH_RESOURCES,
      }),
    ]));
  });

  it("生产购买只领取 reservation 外能量，成功后保留到 tick 结束", () => {
    const terminal = installTerminal("W8N8", {
      [RESOURCE_ENERGY]: 1_200,
    });
    const market = installMarketMock({
      calcTransactionCost: jest.fn(() => 300),
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-gap-exact-energy",
            status: "reconcile_gap",
            canaryRoomName: "W8N8",
            resource: RESOURCE_KEANIUM,
            dealAmount: 1_000,
            transactionEnergy: 900,
          },
        },
      },
    } as unknown as Memory["data"];

    expect(
      executeProductionBuy(
        "production-buy",
        100,
        "W8N8",
        "factoryControl:purchase",
      ),
    ).toBe(OK);
    expect(market.calcTransactionCost).toHaveBeenCalledWith(
      100,
      "W8N8",
      "W7N7",
    );
    expect(market.deal).toHaveBeenCalledWith(
      "production-buy",
      100,
      "W8N8",
    );
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_ENERGY,
      ),
    ).toBe(0);
  });

  it("普通生产卖出同时原子保护待售资源和 transaction energy", () => {
    const amounts: Partial<Record<ResourceConstant, number>> = {
      [RESOURCE_KEANIUM]: 1_099,
      [RESOURCE_ENERGY]: 2_000,
    };
    const terminal = installTerminal("W8N8", amounts);
    const market = installMarketMock({
      calcTransactionCost: jest.fn(() => 200),
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-gap-resource-and-energy",
            status: "reconcile_gap",
            canaryRoomName: "W8N8",
            resource: RESOURCE_KEANIUM,
            dealAmount: 800,
            transactionEnergy: 900,
          },
        },
      },
    } as unknown as Memory["data"];
    const sell = () => executeMarketDeal(
      "production-sell",
      300,
      "W8N8",
      "resourceControl:legacy-sell",
      {
        orderType: ORDER_BUY,
        resourceType: RESOURCE_KEANIUM,
        orderRoomName: "W7N7",
      },
    );

    expect(sell()).toBe(ERR_NOT_ENOUGH_RESOURCES);
    amounts[RESOURCE_KEANIUM] = 1_200;
    amounts[RESOURCE_ENERGY] = 1_099;
    expect(sell()).toBe(ERR_NOT_ENOUGH_RESOURCES);
    expect(market.deal).not.toHaveBeenCalled();

    amounts[RESOURCE_ENERGY] = 1_100;
    expect(sell()).toBe(OK);
    expect(market.deal).toHaveBeenCalledTimes(1);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_KEANIUM,
      ),
    ).toBe(100);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_ENERGY,
      ),
    ).toBe(0);
  });
});
