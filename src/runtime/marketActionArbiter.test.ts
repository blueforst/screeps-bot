import {
  clearMarketActionArbiterForTest,
  executeCancelOrder,
  executeChangeOrderPrice,
  executeCreateOrder,
  executeExtendOrder,
  executeMarketDeal,
  executeTerminalAction,
  executeTerminalSend,
  getTerminalActionClaim,
  getTerminalActionClaims,
  hasTerminalActionClaim,
} from "@/runtime/marketActionArbiter";
import {
  clearMarketSaleExposureReservationsForTest,
  getTerminalAmountOutsideMarketSaleExposure,
} from "@/runtime/marketSaleExposure";

interface WritableMarketMock {
  deal: jest.Mock;
  createOrder: jest.Mock;
  extendOrder: jest.Mock;
  changeOrderPrice: jest.Mock;
  cancelOrder: jest.Mock;
}

function installMarketMock(overrides: Partial<WritableMarketMock> = {}): WritableMarketMock {
  const market: WritableMarketMock = {
    deal: jest.fn(() => OK),
    createOrder: jest.fn(() => OK),
    extendOrder: jest.fn(() => OK),
    changeOrderPrice: jest.fn(() => OK),
    cancelOrder: jest.fn(() => OK),
    ...overrides,
  };
  (Game as unknown as { market: WritableMarketMock }).market = market;
  return market;
}

describe("market action arbiter", () => {
  beforeEach(() => {
    Game.time = 100;
    Memory.data = undefined;
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
  });

  it("成功 deal 后独占同房当 tick 的后续主动动作", () => {
    const market = installMarketMock();

    expect(executeMarketDeal("order-1", 1000, "W1N1", "factoryControl")).toBe(OK);
    expect(executeMarketDeal("order-2", 500, "W1N1", "boostControl")).toBe(ERR_BUSY);

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

    expect(executeMarketDeal("order-1", 1000, "W1N1", "factoryControl")).toBe(OK);
    expect(executeMarketDeal("order-2", 1000, "W2N2", "boostControl")).toBe(OK);

    expect(market.deal).toHaveBeenCalledTimes(2);
    expect(getTerminalActionClaims().map(claim => claim.roomName).sort()).toEqual(["W1N1", "W2N2"]);
  });

  it("失败动作不占用 terminal", () => {
    const market = installMarketMock({
      deal: jest.fn()
        .mockReturnValueOnce(ERR_NOT_ENOUGH_RESOURCES)
        .mockReturnValueOnce(OK),
    });

    expect(executeMarketDeal("order-1", 1000, "W1N1", "factoryControl"))
      .toBe(ERR_NOT_ENOUGH_RESOURCES);
    expect(hasTerminalActionClaim("W1N1")).toBe(false);
    expect(executeMarketDeal("order-2", 1000, "W1N1", "boostControl")).toBe(OK);
    expect(market.deal).toHaveBeenCalledTimes(2);
  });

  it("进入新 tick 后自动清空 claim", () => {
    const market = installMarketMock();

    expect(executeMarketDeal("order-1", 1000, "W1N1", "factoryControl")).toBe(OK);
    Game.time = 101;
    expect(hasTerminalActionClaim("W1N1")).toBe(false);
    expect(executeMarketDeal("order-2", 1000, "W1N1", "boostControl")).toBe(OK);
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
    expect(executeMarketDeal("order-1", 1000, "W1N1", "factoryControl")).toBe(ERR_BUSY);

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
      executeMarketDeal("nested-order", 100, "W1N1", "nested"),
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
});
