import { createMockStore } from "@mock/powerBank";
import { buyBoostIfNeeded, DEFENSE_BOOST_COMPOUND } from "@/runtime/boostControl";
import {
  clearMarketActionArbiterForTest,
  executeTerminalAction,
  getMarketActionJournal,
  getTerminalActionClaim,
} from "@/runtime/marketActionArbiter";

function createRoom(): Room {
  const room = {
    name: "W1N1",
    storage: {
      store: createMockStore({}),
    } as StructureStorage,
    terminal: {
      cooldown: 0,
      store: createMockStore({
        [RESOURCE_ENERGY]: 25000,
        [DEFENSE_BOOST_COMPOUND]: 0,
      }, 300000),
    } as StructureTerminal,
  } as Room;
  room.terminal!.room = room;
  Game.rooms[room.name] = room;
  return room;
}

function createBoostOrder(): Order {
  return {
    id: "boost-sell-order",
    type: ORDER_SELL,
    resourceType: DEFENSE_BOOST_COMPOUND,
    price: 5,
    amount: 1000,
    remainingAmount: 1000,
    roomName: "W2N2",
    created: 1,
  };
}

describe("boost control market gateway", () => {
  beforeEach(() => {
    Game.time = 100;
    clearMarketActionArbiterForTest();
    (Memory as any).cfg = {};
    (Memory.cfg as any).homeDefense = {
      boostTarget: 1000,
      maxBoostBuyPrice: 10,
      maxBoostDealEnergyCostRatio: 1,
    };
    (Game as any).market = {
      getAllOrders: jest.fn(() => [createBoostOrder()]),
      calcTransactionCost: jest.fn(() => 100),
      deal: jest.fn(() => OK),
    };
  });

  it("通过 arbiter 购买并记录 terminal claim", () => {
    const room = createRoom();
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-boost-gap",
            status: "reconcile_gap",
            canaryRoomName: room.name,
            resource: DEFENSE_BOOST_COMPOUND,
            dealAmount: 1_000,
            transactionEnergy: 24_900,
          },
        },
      },
    } as unknown as Memory["data"];

    buyBoostIfNeeded(room);

    expect(Game.market.deal).toHaveBeenCalledWith("boost-sell-order", 1000, "W1N1");
    expect(getTerminalActionClaim("W1N1")).toMatchObject({
      actor: "boostControl",
      kind: "market_deal",
      tick: 100,
    });
    expect(getMarketActionJournal()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: "boostControl",
        outcome: "intent",
        roomName: room.name,
      }),
    ]));
  });

  it("已有内部发送 claim 时不执行市场购买", () => {
    const room = createRoom();
    expect(executeTerminalAction("W1N1", "resourceControl", "terminal_send", () => OK)).toBe(OK);

    buyBoostIfNeeded(room);

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getTerminalActionClaim("W1N1")?.actor).toBe("resourceControl");
  });

  it("没有可执行订单时不声明市场 intent", () => {
    const room = createRoom();
    (Game.market.getAllOrders as jest.Mock).mockReturnValue([]);

    buyBoostIfNeeded(room);

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getMarketActionJournal()).toEqual([]);
  });

  it("交易能量不足时不声明市场 intent", () => {
    const room = createRoom();
    room.terminal!.store = createMockStore({
      [RESOURCE_ENERGY]: 50,
      [DEFENSE_BOOST_COMPOUND]: 0,
    }, 300_000);

    buyBoostIfNeeded(room);

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getMarketActionJournal()).toEqual([]);
  });

  it("terminal 冷却时不扫描订单或声明市场 intent", () => {
    const room = createRoom();
    room.terminal!.cooldown = 1;

    buyBoostIfNeeded(room);

    expect(Game.market.getAllOrders).not.toHaveBeenCalled();
    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getMarketActionJournal()).toEqual([]);
  });
});
