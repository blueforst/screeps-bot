import {
  claimTerminalAmountOutsideMarketSaleExposure,
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

  it("Direct schema/pending migration blocker 阻断生产，纯 qualification blocker 不阻断", () => {
    expect(
      summarizeMarketSaleTerminalExposure(
        {
          managedOrders: {},
          directAutomation: {
            migrationBlockedReason:
              "direct_pending_store_state_invalid",
          },
        },
        "W1N1",
        RESOURCE_KEANIUM,
      ),
    ).toEqual({ reservedAmount: 0, blocked: true });
    expect(
      summarizeMarketSaleTerminalExposure(
        {
          managedOrders: {},
          directAutomation: {
            migrationBlockedReason:
              "direct_qualification_state_invalid",
          },
        },
        "W1N1",
        RESOURCE_KEANIUM,
      ),
    ).toEqual({ reservedAmount: 0, blocked: false });
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
});
