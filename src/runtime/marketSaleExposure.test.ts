import {
  claimTerminalAmountOutsideMarketSaleExposure,
  clearMarketSaleExposureReservationsForTest,
  compileLiveMarketSaleTerminalExposureIndex,
  compileMarketSaleTerminalExposureIndex,
  getTerminalAmountOutsideMarketSaleExposure,
  getTerminalAmountsOutsideMarketSaleExposure,
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
    Memory.cfg = undefined;
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

    let managedScanCount = 0;
    let directScanCount = 0;
    const managedOrders = new Proxy({
      maker: {
        roomName: "W1N1",
        resourceType: RESOURCE_KEANIUM,
        remainingExposure: 100,
      },
    }, {
      ownKeys(target) {
        managedScanCount += 1;
        return Reflect.ownKeys(target);
      },
    });
    const pendingDirectDeals = new Proxy({
      first: {
        canaryRoomName: "W1N1",
        resource: RESOURCE_KEANIUM,
        status: "prepared",
        dealAmount: 50,
        transactionEnergy: 20,
      },
      second: {
        canaryRoomName: "W2N2",
        resource: RESOURCE_HYDROGEN,
        status: "submitted",
        dealAmount: 30,
        transactionEnergy: 5,
      },
    }, {
      ownKeys(target) {
        directScanCount += 1;
        return Reflect.ownKeys(target);
      },
    });
    const compiledInput = {
      managedOrders,
      pendingCreate: {
        tuple: {
          roomName: "W2N2",
          resourceType: RESOURCE_HYDROGEN,
          type: ORDER_SELL,
        },
        exposure: 200,
      },
      pendingDirectDeals,
    };
    const compiled = compileMarketSaleTerminalExposureIndex(compiledInput);

    expect(Object.isFrozen(compiled)).toBe(true);
    expect(compiled.get("W1N1", RESOURCE_KEANIUM)).toEqual({
      reservedAmount: 150,
      blocked: false,
    });
    expect(compiled.get("W1N1", RESOURCE_ENERGY)).toEqual({
      reservedAmount: 20,
      blocked: false,
    });
    expect(compiled.get("W2N2", RESOURCE_HYDROGEN)).toEqual({
      reservedAmount: 230,
      blocked: false,
    });
    expect(compiled.get("W2N2", RESOURCE_ENERGY)).toEqual({
      reservedAmount: 5,
      blocked: false,
    });
    expect(managedScanCount).toBe(1);
    expect(directScanCount).toBe(1);
    expect(compiled.get("W1N1", RESOURCE_KEANIUM)).toEqual(
      summarizeMarketSaleTerminalExposure(
        compiledInput,
        "W1N1",
        RESOURCE_KEANIUM,
      ),
    );
    managedOrders.maker.remainingExposure = 999;
    pendingDirectDeals.first.dealAmount = 999;
    // 输入后续变化不会污染已冻结索引，重复、多 tuple 查询也不重新枚举账本。
    expect(compiled.get("W1N1", RESOURCE_KEANIUM).reservedAmount).toBe(150);

    const pendingCreateBlockedInput = {
      managedOrders: {
        maker: {
          roomName: "W3N3",
          resourceType: RESOURCE_KEANIUM,
          remainingExposure: 10,
        },
      },
      pendingCreate: {
        tuple: {
          roomName: "W3N3",
          resourceType: RESOURCE_KEANIUM,
          type: ORDER_BUY,
        },
        exposure: 999,
      },
      pendingDirectDeals: {
        direct: {
          canaryRoomName: "W3N3",
          resource: RESOURCE_KEANIUM,
          status: "reconcile_gap",
          dealAmount: 50,
          transactionEnergy: 20,
        },
      },
    };
    const pendingCreateBlocked = compileMarketSaleTerminalExposureIndex(
      pendingCreateBlockedInput,
    );
    // 非 sell pending create 只让精确 tuple 提前终止；Energy 仍读取 Direct fee。
    expect(pendingCreateBlocked.get("W3N3", RESOURCE_KEANIUM)).toEqual({
      reservedAmount: 10,
      blocked: true,
    });
    expect(pendingCreateBlocked.get("W3N3", RESOURCE_ENERGY)).toEqual({
      reservedAmount: 20,
      blocked: false,
    });
    expect(pendingCreateBlocked.get("W3N3", RESOURCE_KEANIUM)).toEqual(
      summarizeMarketSaleTerminalExposure(
        pendingCreateBlockedInput,
        "W3N3",
        RESOURCE_KEANIUM,
      ),
    );
    expect(pendingCreateBlocked.get("W3N3", RESOURCE_ENERGY)).toEqual(
      summarizeMarketSaleTerminalExposure(
        pendingCreateBlockedInput,
        "W3N3",
        RESOURCE_ENERGY,
      ),
    );

    const malformedAfterPrefixInput = {
      managedOrders: {
        validPrefix: {
          roomName: "W4N4",
          resourceType: RESOURCE_KEANIUM,
          remainingExposure: 7,
        },
        malformed: {
          roomName: "not-a-room",
          resourceType: RESOURCE_HYDROGEN,
          remainingExposure: 100,
        },
      },
    };
    const malformedAfterPrefix = compileMarketSaleTerminalExposureIndex(
      malformedAfterPrefixInput,
    );
    expect(malformedAfterPrefix.get("W4N4", RESOURCE_KEANIUM)).toEqual({
      reservedAmount: 7,
      blocked: true,
    });
    expect(malformedAfterPrefix.get("W2N2", RESOURCE_HYDROGEN)).toEqual({
      reservedAmount: 0,
      blocked: true,
    });
    expect(malformedAfterPrefix.get("W4N4", RESOURCE_KEANIUM)).toEqual(
      summarizeMarketSaleTerminalExposure(
        malformedAfterPrefixInput,
        "W4N4",
        RESOURCE_KEANIUM,
      ),
    );
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

    const compiled = compileLiveMarketSaleTerminalExposureIndex();
    const getUsedCapacitySpy = jest.spyOn(
      source.store as unknown as {
        getUsedCapacity(resource?: ResourceConstant): number;
      },
      "getUsedCapacity",
    );
    getUsedCapacitySpy.mockClear();
    const initialBatch = getTerminalAmountsOutsideMarketSaleExposure(
      source,
      [RESOURCE_KEANIUM, RESOURCE_ENERGY, RESOURCE_KEANIUM],
      compiled,
      {
        storedAmounts: {
          [RESOURCE_KEANIUM]: 1_800,
          [RESOURCE_ENERGY]: 0,
        },
      },
    );
    expect(initialBatch.size).toBe(2);
    expect(initialBatch.get(RESOURCE_KEANIUM)).toBe(1_000);
    expect(initialBatch.get(RESOURCE_ENERGY)).toBe(0);
    expect(getUsedCapacitySpy).not.toHaveBeenCalled();

    const first = claimTerminalAmountOutsideMarketSaleExposure(
      source,
      RESOURCE_KEANIUM,
      800,
    );
    getUsedCapacitySpy.mockClear();
    expect(
      getTerminalAmountsOutsideMarketSaleExposure(
        source,
        [RESOURCE_KEANIUM],
        compiled,
        {
          storedAmounts: { [RESOURCE_KEANIUM]: 1_800 },
        },
      ).get(RESOURCE_KEANIUM),
    ).toBe(200);
    expect(getUsedCapacitySpy).not.toHaveBeenCalled();

    const second = claimTerminalAmountOutsideMarketSaleExposure(
      source,
      RESOURCE_KEANIUM,
      800,
    );

    expect(first?.amount).toBe(800);
    expect(second?.amount).toBe(200);
    expect(
      getTerminalAmountsOutsideMarketSaleExposure(
        source,
        [RESOURCE_KEANIUM],
        compiled,
        {
          storedAmounts: { [RESOURCE_KEANIUM]: 1_800 },
        },
      ).get(RESOURCE_KEANIUM),
    ).toBe(0);
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
