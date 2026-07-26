import {
  canTerminalSendPreserveMarketSaleExposure,
  claimTerminalAmountOutsideMarketSaleExposure,
  claimTerminalSendOutsideMarketSaleExposure,
  clearMarketSaleExposureReservationsForTest,
  getTerminalAmountOutsideMarketSaleExposure,
  summarizeMarketSaleTerminalExposure,
} from "@/runtime/marketSaleExposure";

function terminal(
  roomName: string,
  resources: Partial<Record<ResourceConstant, number>>,
): StructureTerminal {
  const room = { name: roomName } as Room;
  return {
    room,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource ? resources[resource] || 0 : 0,
    },
  } as unknown as StructureTerminal;
}

describe("marketSaleExposure", () => {
  beforeEach(() => {
    Memory.data = undefined;
    clearMarketSaleExposureReservationsForTest();
  });

  it("汇总同一 room/resource 的 managed 与 pendingCreate exposure", () => {
    const result = summarizeMarketSaleTerminalExposure(
      {
        managedOrders: {
          first: {
            roomName: "W1N1",
            resourceType: RESOURCE_KEANIUM,
            remainingExposure: 400,
          },
          otherRoom: {
            roomName: "W2N2",
            resourceType: RESOURCE_KEANIUM,
            remainingExposure: 999,
          },
          otherResource: {
            roomName: "W1N1",
            resourceType: RESOURCE_OXYGEN,
            remainingExposure: 999,
          },
        },
        pendingCreate: {
          tuple: {
            type: ORDER_SELL,
            roomName: "W1N1",
            resourceType: RESOURCE_KEANIUM,
          },
          exposure: 600,
        },
      },
      "W1N1",
      RESOURCE_KEANIUM,
    );

    expect(result).toEqual({ reservedAmount: 1_000, blocked: false });
  });

  it("仅在精确匹配记录损坏时 fail-closed", () => {
    const data = {
      managedOrders: {
        brokenExact: {
          roomName: "W1N1",
          resourceType: RESOURCE_KEANIUM,
          remainingExposure: Number.NaN,
        },
        brokenElsewhere: {
          roomName: "W9N9",
          resourceType: RESOURCE_KEANIUM,
          remainingExposure: Number.NaN,
        },
      },
    };

    expect(
      summarizeMarketSaleTerminalExposure(
        data,
        "W1N1",
        RESOURCE_KEANIUM,
      ),
    ).toEqual({ reservedAmount: 0, blocked: true });
    expect(
      summarizeMarketSaleTerminalExposure(
        data,
        "W2N2",
        RESOURCE_KEANIUM,
      ),
    ).toEqual({ reservedAmount: 0, blocked: false });
  });

  it("无法定位的 managed/pending 结构损坏时对所有查询 fail-closed", () => {
    expect(
      summarizeMarketSaleTerminalExposure(
        { managedOrders: "corrupt" },
        "W1N1",
        RESOURCE_KEANIUM,
      ),
    ).toEqual({ reservedAmount: 0, blocked: true });
    expect(
      summarizeMarketSaleTerminalExposure(
        {
          managedOrders: {
            unknownOwner: {
              remainingExposure: 500,
            },
          },
        },
        "W9N9",
        RESOURCE_OXYGEN,
      ),
    ).toEqual({ reservedAmount: 0, blocked: true });
    expect(
      summarizeMarketSaleTerminalExposure(
        {
          managedOrders: {},
          pendingCreate: {
            exposure: 500,
            tuple: {
              type: ORDER_SELL,
              resourceType: RESOURCE_KEANIUM,
            },
          },
        },
        "W9N9",
        RESOURCE_OXYGEN,
      ),
    ).toEqual({ reservedAmount: 0, blocked: true });
  });

  it("删除已确认 managed 记录后自动释放，手工订单不影响", () => {
    const roomName = "W3N3";
    const resourceType = RESOURCE_ZYNTHIUM;
    const source = terminal(roomName, {
      [resourceType]: 1_000,
      [RESOURCE_ENERGY]: 500,
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {
          managed: {
            roomName,
            resourceType,
            remainingExposure: 800,
          },
        },
        pendingMutations: {},
        leases: {},
        feeLedger: {
          windowStartedAt: 0,
          feeEvents: [],
          sameTickReservations: [],
          carriedFeeDebtMilli: {},
          reconcileGap: [],
        },
      },
    } as unknown as Memory["data"];
    (Game as unknown as { market: Market }).market = {
      orders: {
        manual: {
          id: "manual",
          roomName,
          resourceType,
          type: ORDER_SELL,
          price: 1,
          amount: 999,
          remainingAmount: 999,
          totalAmount: 999,
          active: true,
          created: 1,
        },
      },
    } as unknown as Market;

    expect(
      getTerminalAmountOutsideMarketSaleExposure(source, resourceType),
    ).toBe(200);
    delete Memory.data!.marketSaleAutomation!.managedOrders.managed;
    expect(
      getTerminalAmountOutsideMarketSaleExposure(source, resourceType),
    ).toBe(1_000);
  });

  it("send 同时保护货物 exposure 与 energy exposure", () => {
    const source = terminal("W4N4", {
      [RESOURCE_KEANIUM]: 1_000,
      [RESOURCE_ENERGY]: 1_000,
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {
          mineral: {
            roomName: "W4N4",
            resourceType: RESOURCE_KEANIUM,
            remainingExposure: 800,
          },
          energy: {
            roomName: "W4N4",
            resourceType: RESOURCE_ENERGY,
            remainingExposure: 900,
          },
        },
        pendingMutations: {},
        leases: {},
        feeLedger: {
          windowStartedAt: 0,
          feeEvents: [],
          sameTickReservations: [],
          carriedFeeDebtMilli: {},
          reconcileGap: [],
        },
      },
    } as unknown as Memory["data"];

    expect(
      canTerminalSendPreserveMarketSaleExposure(
        source,
        RESOURCE_KEANIUM,
        200,
        100,
      ),
    ).toBe(true);
    expect(
      canTerminalSendPreserveMarketSaleExposure(
        source,
        RESOURCE_KEANIUM,
        201,
        100,
      ),
    ).toBe(false);
    expect(
      canTerminalSendPreserveMarketSaleExposure(
        source,
        RESOURCE_KEANIUM,
        200,
        101,
      ),
    ).toBe(false);
  });

  it("同 tick 多个 carrier claim 原子缩量，OK intent 的量保留到 tick 结束", () => {
    const source = terminal("W5N5", {
      [RESOURCE_KEANIUM]: 1_800,
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {
          managed: {
            roomName: "W5N5",
            resourceType: RESOURCE_KEANIUM,
            remainingExposure: 800,
          },
        },
      },
    } as unknown as Memory["data"];

    const first = claimTerminalAmountOutsideMarketSaleExposure(
      source,
      RESOURCE_KEANIUM,
      800,
    );
    const second = claimTerminalAmountOutsideMarketSaleExposure(
      source,
      RESOURCE_KEANIUM,
      800,
    );

    expect(first?.amount).toBe(800);
    expect(second?.amount).toBe(200);
    expect(
      claimTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_KEANIUM,
        1,
      ),
    ).toBeNull();
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_KEANIUM,
      ),
    ).toBe(0);
  });

  it("没有市场 exposure 时 claim 不改变既有同 tick 可用量", () => {
    const source = terminal("W5N6", {
      [RESOURCE_KEANIUM]: 1_000,
    });

    const claim = claimTerminalAmountOutsideMarketSaleExposure(
      source,
      RESOURCE_KEANIUM,
      800,
    );

    expect(claim?.amount).toBe(800);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_KEANIUM,
      ),
    ).toBe(1_000);
  });

  it("失败 intent 可释放 claim，且新 tick 与新 Game identity 自动清空", () => {
    const source = terminal("W6N6", {
      [RESOURCE_ZYNTHIUM]: 1_500,
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {
          managed: {
            roomName: "W6N6",
            resourceType: RESOURCE_ZYNTHIUM,
            remainingExposure: 500,
          },
        },
      },
    } as unknown as Memory["data"];

    const failed = claimTerminalAmountOutsideMarketSaleExposure(
      source,
      RESOURCE_ZYNTHIUM,
      600,
    );
    expect(failed?.amount).toBe(600);
    failed?.release();
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_ZYNTHIUM,
      ),
    ).toBe(1_000);

    const oldTickClaim = claimTerminalAmountOutsideMarketSaleExposure(
      source,
      RESOURCE_ZYNTHIUM,
      600,
    );
    expect(oldTickClaim?.amount).toBe(600);
    Game.time += 1;
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_ZYNTHIUM,
      ),
    ).toBe(1_000);

    const oldGameClaim = claimTerminalAmountOutsideMarketSaleExposure(
      source,
      RESOURCE_ZYNTHIUM,
      600,
    );
    expect(oldGameClaim?.amount).toBe(600);
    const previousGame = Game;
    Object.assign(global, {
      Game: {
        ...previousGame,
        time: previousGame.time,
      },
    });
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_ZYNTHIUM,
      ),
    ).toBe(1_000);

    // 旧 claim 的迟到 release 不能误删新 Game 的 reservation。
    const newGameClaim = claimTerminalAmountOutsideMarketSaleExposure(
      source,
      RESOURCE_ZYNTHIUM,
      400,
    );
    oldGameClaim?.release();
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_ZYNTHIUM,
      ),
    ).toBe(600);
    newGameClaim?.release();
  });

  it("send 对货物与 energy fee 做 all-or-none 原子 claim", () => {
    const source = terminal("W7N7", {
      [RESOURCE_KEANIUM]: 1_000,
      [RESOURCE_ENERGY]: 1_000,
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {
          mineral: {
            roomName: "W7N7",
            resourceType: RESOURCE_KEANIUM,
            remainingExposure: 800,
          },
          energy: {
            roomName: "W7N7",
            resourceType: RESOURCE_ENERGY,
            remainingExposure: 900,
          },
        },
      },
    } as unknown as Memory["data"];

    expect(
      claimTerminalSendOutsideMarketSaleExposure(
        source,
        RESOURCE_KEANIUM,
        200,
        101,
      ),
    ).toBeNull();
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_KEANIUM,
      ),
    ).toBe(200);

    const claim = claimTerminalSendOutsideMarketSaleExposure(
      source,
      RESOURCE_KEANIUM,
      200,
      100,
    );
    expect(claim).not.toBeNull();
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_KEANIUM,
      ),
    ).toBe(0);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_ENERGY,
      ),
    ).toBe(0);

    claim?.release();
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_KEANIUM,
      ),
    ).toBe(200);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        source,
        RESOURCE_ENERGY,
      ),
    ).toBe(100);
  });
});
