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

  it("成功 deal 后独占同房当 tick 的后续主动动作", () => {
    const market = installMarketMock();

    expect(executeProductionBuy("order-1", 1000, "W1N1", "factoryControl")).toBe(OK);
    expect(executeProductionBuy("order-2", 500, "W1N1", "boostControl")).toBe(ERR_BUSY);

    expect(market.deal).toHaveBeenCalledTimes(1);
    expect(market.deal).toHaveBeenCalledWith("order-1", 1000, "W1N1");
    expect(getTerminalActionClaim("W1N1")).toEqual({
      roomName: "W1N1",
      tick: 100,
      actor: "factoryControl",
      kind: "market_deal",
    });
  });

  it("不同房间可在同 tick 各执行一次主动动作", () => {
    const market = installMarketMock();

    expect(executeProductionBuy("order-1", 1000, "W1N1", "factoryControl")).toBe(OK);
    expect(executeProductionBuy("order-2", 1000, "W2N2", "boostControl")).toBe(OK);

    expect(market.deal).toHaveBeenCalledTimes(2);
    expect(getTerminalActionClaims().map(claim => claim.roomName).sort()).toEqual(["W1N1", "W2N2"]);
  });

  it("失败动作不占用 terminal", () => {
    const market = installMarketMock({
      deal: jest.fn()
        .mockReturnValueOnce(ERR_NOT_ENOUGH_RESOURCES)
        .mockReturnValueOnce(OK),
    });

    expect(executeProductionBuy("order-1", 1000, "W1N1", "factoryControl"))
      .toBe(ERR_NOT_ENOUGH_RESOURCES);
    expect(hasTerminalActionClaim("W1N1")).toBe(false);
    expect(executeProductionBuy("order-2", 1000, "W1N1", "boostControl")).toBe(OK);
    expect(market.deal).toHaveBeenCalledTimes(2);
  });

  it("进入新 tick 后自动清空 claim", () => {
    const market = installMarketMock();

    expect(executeProductionBuy("order-1", 1000, "W1N1", "factoryControl")).toBe(OK);
    Game.time = 101;
    expect(hasTerminalActionClaim("W1N1")).toBe(false);
    expect(executeProductionBuy("order-2", 1000, "W1N1", "boostControl")).toBe(OK);
    expect(market.deal).toHaveBeenCalledTimes(2);
  });

  it("内部 send 与市场 deal 共享同一 terminal claim", () => {
    const market = installMarketMock();
    const send = jest.fn(() => OK);
    const terminal = {
      room: { name: "W1N1" },
      store: {
        getUsedCapacity: () => 10_000,
      },
      send,
    } as unknown as StructureTerminal;

    expect(executeTerminalSend({
      terminal,
      resourceType: RESOURCE_ENERGY,
      amount: 1000,
      transactionCost: 100,
      destinationRoomName: "W2N2",
      actor: "resourceControl",
      description: "resourceControl:test",
    })).toBe(OK);
    expect(executeProductionBuy("order-1", 1000, "W1N1", "factoryControl")).toBe(ERR_BUSY);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      1000,
      "W2N2",
      "resourceControl:test",
    );
    expect(market.deal).not.toHaveBeenCalled();
    expect(getTerminalActionClaim("W1N1")).toMatchObject({
      actor: "resourceControl",
      kind: "terminal_send",
    });
  });

  it("执行回调重入同房时拒绝第二个主动动作", () => {
    const market = installMarketMock();
    const send = jest.fn(() =>
      executeProductionBuy("nested-order", 100, "W1N1", "nested"),
    );

    expect(executeTerminalAction("W1N1", "resourceControl", "terminal_send", send)).toBe(ERR_BUSY);
    expect(send).toHaveBeenCalledTimes(1);
    expect(market.deal).not.toHaveBeenCalled();
    expect(hasTerminalActionClaim("W1N1")).toBe(false);
  });

  it("send 成功保留 exposure claim，失败与异常会释放", () => {
    const room = { name: "W3N3" } as Room;
    const terminal = {
      id: "terminal-send-exposure",
      room,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_KEANIUM ? 1_000 : 10_000,
      },
      send: jest.fn()
        .mockReturnValueOnce(ERR_TIRED)
        .mockImplementationOnce(() => {
          throw new Error("send failed");
        })
        .mockReturnValueOnce(OK),
    } as unknown as StructureTerminal;
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {
          managed: {
            roomName: room.name,
            resourceType: RESOURCE_KEANIUM,
            remainingExposure: 800,
          },
        },
      },
    } as unknown as Memory["data"];
    const request = {
      terminal,
      resourceType: RESOURCE_KEANIUM,
      amount: 200,
      transactionCost: 100,
      destinationRoomName: "W4N4",
      actor: "resourceControl",
    };

    expect(executeTerminalSend(request)).toBe(ERR_TIRED);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_KEANIUM,
      ),
    ).toBe(200);

    expect(() => executeTerminalSend(request)).toThrow("send failed");
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_KEANIUM,
      ),
    ).toBe(200);

    expect(executeTerminalSend(request)).toBe(OK);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_KEANIUM,
      ),
    ).toBe(0);
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

  it("普通 deal 非 OK 或异常会释放生产 energy claim", () => {
    const terminal = installTerminal("W8N8", {
      [RESOURCE_ENERGY]: 1_200,
    });
    const market = installMarketMock({
      calcTransactionCost: jest.fn(() => 300),
      deal: jest.fn()
        .mockReturnValueOnce(ERR_TIRED)
        .mockImplementationOnce(() => {
          throw new Error("production deal failed");
        })
        .mockReturnValueOnce(OK),
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-gap-release",
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
        "production-buy-1",
        100,
        "W8N8",
        "boostControl",
      ),
    ).toBe(ERR_TIRED);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_ENERGY,
      ),
    ).toBe(300);

    expect(() =>
      executeProductionBuy(
        "production-buy-2",
        100,
        "W8N8",
        "boostControl",
      ),
    ).toThrow("production deal failed");
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_ENERGY,
      ),
    ).toBe(300);

    expect(
      executeProductionBuy(
        "production-buy-3",
        100,
        "W8N8",
        "boostControl",
      ),
    ).toBe(OK);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_ENERGY,
      ),
    ).toBe(0);
    expect(market.deal).toHaveBeenCalledTimes(3);
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

  it("统一转发订单生命周期写 API", () => {
    const market = installMarketMock();
    const createParams = {
      type: ORDER_SELL,
      resourceType: RESOURCE_HYDROGEN,
      price: 42,
      totalAmount: 1000,
      roomName: "W1N1",
    } as const;

    expect(executeCreateOrder(createParams)).toBe(OK);
    expect(executeExtendOrder("order-1", 500)).toBe(OK);
    expect(executeChangeOrderPrice("order-1", 43)).toBe(OK);
    expect(executeCancelOrder("order-1")).toBe(OK);

    expect(market.createOrder).toHaveBeenCalledWith(createParams);
    expect(market.extendOrder).toHaveBeenCalledWith("order-1", 500);
    expect(market.changeOrderPrice).toHaveBeenCalledWith("order-1", 43);
    expect(market.cancelOrder).toHaveBeenCalledWith("order-1");
  });

  it("prepared Direct 可在同 request claim 上提交，并持久阻断到下一 tick preflight", () => {
    const market = installMarketMock();
    const request = {
      requestId: "direct-100",
      orderId: "buy-order",
      amount: 1_000,
      roomName: "W8N8",
      actor: "marketSaleAutomation:direct",
      attemptAt: 100,
    };

    expect(claimPreparedDirectMarketClaims(request)).toBe(true);
    expect(executePreparedDirectMarketDeal(request)).toBe(OK);
    expect(market.deal).toHaveBeenCalledWith(
      "buy-order",
      1_000,
      "W8N8",
    );
    expect(getMarketAccountClaim()).toMatchObject({
      requestId: "direct-100",
      heldThroughTick: 101,
    });
    expect(getTerminalActionClaim("W8N8")).toMatchObject({
      requestId: "direct-100",
      actor: "marketSaleAutomation:direct",
    });
    expect(executeCancelOrder("manual-order")).toBe(ERR_BUSY);

    Game.time = 101;
    clearMarketActionArbiterForTest(true);
    expect(hasMarketAccountClaim()).toBe(true);
    expect(
      executeProductionBuy("production-buy", 100, "W9N9", "boostControl"),
    ).toBe(ERR_BUSY);

    expect(releasePreparedDirectMarketClaims("direct-100")).toBe(true);
    expect(releasePreparedDirectMarketClaims("direct-100")).toBe(true);
    expect(hasMarketAccountClaim()).toBe(false);
    expect(
      executeProductionBuy("production-buy", 100, "W9N9", "boostControl"),
    ).toBe(OK);
    expect(getMarketActionJournal()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requestId: "direct-100",
        kind: "direct_market_deal",
        outcome: "ok",
      }),
      expect.objectContaining({
        tick: 101,
        actor: "boostControl",
        outcome: "ok",
      }),
    ]));
  });

  it("prepared Direct 明确非 OK 才释放，随后生产动作可运行", () => {
    const market = installMarketMock({
      deal: jest.fn()
        .mockReturnValueOnce(ERR_NOT_ENOUGH_RESOURCES)
        .mockReturnValueOnce(OK),
    });
    const request = {
      requestId: "direct-non-ok",
      orderId: "buy-order",
      amount: 1_000,
      roomName: "W8N8",
      actor: "marketSaleAutomation:direct",
      attemptAt: 100,
    };

    expect(executePreparedDirectMarketDeal(request))
      .toBe(ERR_NOT_ENOUGH_RESOURCES);
    expect(hasMarketAccountClaim()).toBe(false);
    expect(hasTerminalActionClaim("W8N8")).toBe(false);
    expect(
      executeProductionBuy("production-buy", 100, "W8N8", "factoryControl"),
    ).toBe(OK);
    expect(market.deal).toHaveBeenCalledTimes(2);
  });

  it("prepared Direct 抛异常后保留持久 claim 且继续抛出", () => {
    installMarketMock({
      deal: jest.fn(() => {
        throw new Error("deal wrapper failed");
      }),
    });
    const request = {
      requestId: "direct-threw",
      orderId: "buy-order",
      amount: 1_000,
      roomName: "W8N8",
      actor: "marketSaleAutomation:direct",
      attemptAt: 100,
    };

    expect(() => executePreparedDirectMarketDeal(request))
      .toThrow("deal wrapper failed");
    expect(hasMarketAccountClaim()).toBe(true);
    expect(getTerminalActionClaim("W8N8")).toMatchObject({
      requestId: "direct-threw",
    });

    Game.time = 101;
    clearMarketActionArbiterForTest(true);
    expect(hasMarketAccountClaim()).toBe(true);
    expect(
      executeProductionBuy("production-buy", 100, "W9N9", "resourceControl"),
    ).toBe(ERR_BUSY);
  });

  it("超过 attemptAt+1 后不让 gap 的账户 claim 永久阻断生产", () => {
    const market = installMarketMock();
    expect(claimPreparedDirectMarketClaims({
      requestId: "direct-gap",
      roomName: "W8N8",
      actor: "marketSaleAutomation:direct",
      attemptAt: 100,
    })).toBe(true);

    Game.time = 102;
    clearMarketActionArbiterForTest(true);
    expect(hasMarketAccountClaim()).toBe(false);
    expect(
      executeProductionBuy("production-buy", 100, "W8N8", "resourceControl"),
    ).toBe(OK);
    expect(market.deal).toHaveBeenCalledWith(
      "production-buy",
      100,
      "W8N8",
    );
  });

  it("生产 intent 即使尚未成交也优先于后置 Direct", () => {
    installMarketMock();
    expect(
      declareMarketActionIntent(
        "resourceControl:emergency-buy",
        "market_deal",
        "W1N1",
      ),
    ).toBe(true);
    expect(hasMarketActionIntentThisTick()).toBe(true);
    expect(claimPreparedDirectMarketClaims({
      requestId: "direct-after-production-intent",
      roomName: "W8N8",
      actor: "marketSaleAutomation:direct",
      attemptAt: 100,
    })).toBe(false);
    expect(getMarketActionJournal()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: "resourceControl:emergency-buy",
        outcome: "intent",
      }),
    ]));
  });
});
