import {
  enforceLegacyMarketSafetyLatch,
  resolveMarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";

describe("marketSaleConfig", () => {
  beforeEach(() => {
    Memory.cfg = {};
  });

  it("缺失配置默认 off 且空白名单不会回退", () => {
    const config = resolveMarketSaleAutomationConfig(undefined);
    expect(config.mode).toBe("off");
    expect(config.sellResources).toEqual([]);
    expect(config.validForPlanning).toBe(true);
  });

  it("shadow 缺 revision、credit reserve、hard floor 或 forecast buffer 时 fail closed", () => {
    const config = resolveMarketSaleAutomationConfig({
      mode: "shadow",
      sellResources: [RESOURCE_KEANIUM],
    });
    expect(config.validForPlanning).toBe(false);
    expect(config.invalidReasons).toEqual(
      expect.arrayContaining([
        "config_revision_missing",
        "credit_reserve_missing",
        `hard_floor_missing:${RESOURCE_KEANIUM}`,
        `forecast_buffer_missing:${RESOURCE_KEANIUM}`,
      ]),
    );
  });

  it("每个白名单资源都要求 forecast buffer 覆盖完整安全批次", () => {
    const invalidOrMissing = resolveMarketSaleAutomationConfig({
      mode: "maker",
      configRevision: "rev-1",
      sellResources: [
        RESOURCE_KEANIUM,
        RESOURCE_OXYGEN,
        RESOURCE_CATALYST,
        RESOURCE_ZYNTHIUM,
      ],
      hardFloor: {
        [RESOURCE_KEANIUM]: 1,
        [RESOURCE_OXYGEN]: 1,
        [RESOURCE_CATALYST]: 1,
        [RESOURCE_ZYNTHIUM]: 1,
      },
      forecastBuffer: {
        [RESOURCE_KEANIUM]: 0,
        [RESOURCE_CATALYST]: Number.POSITIVE_INFINITY,
        [RESOURCE_ZYNTHIUM]: Number.NaN,
      },
      minDealAmount: 500,
      makerBatchAmount: 1_000,
      creditReserve: 0,
    });
    expect(invalidOrMissing.validForPlanning).toBe(false);
    expect(invalidOrMissing.invalidReasons).toEqual(
      expect.arrayContaining([
        `forecast_buffer_missing:${RESOURCE_KEANIUM}`,
        `forecast_buffer_missing:${RESOURCE_OXYGEN}`,
        `forecast_buffer_missing:${RESOURCE_CATALYST}`,
        `forecast_buffer_missing:${RESOURCE_ZYNTHIUM}`,
      ]),
    );

    const belowMakerBatch = resolveMarketSaleAutomationConfig({
      mode: "shadow",
      configRevision: "rev-1",
      sellResources: [RESOURCE_KEANIUM],
      hardFloor: { [RESOURCE_KEANIUM]: 1 },
      forecastBuffer: { [RESOURCE_KEANIUM]: 999 },
      minDealAmount: 500,
      makerBatchAmount: 1_000,
      creditReserve: 0,
    });
    expect(belowMakerBatch.validForPlanning).toBe(false);
    expect(belowMakerBatch.invalidReasons).toContain(
      `forecast_buffer_below_safe_batch:${RESOURCE_KEANIUM}`,
    );

    const belowMinimumDeal = resolveMarketSaleAutomationConfig({
      mode: "shadow",
      configRevision: "rev-1",
      sellResources: [RESOURCE_KEANIUM],
      hardFloor: { [RESOURCE_KEANIUM]: 1 },
      forecastBuffer: { [RESOURCE_KEANIUM]: 999 },
      minDealAmount: 1_000,
      makerBatchAmount: 500,
      creditReserve: 0,
    });
    expect(belowMinimumDeal.validForPlanning).toBe(false);
    expect(belowMinimumDeal.invalidReasons).toContain(
      `forecast_buffer_below_safe_batch:${RESOURCE_KEANIUM}`,
    );

    const exactSafeBatch = resolveMarketSaleAutomationConfig({
      mode: "shadow",
      configRevision: "rev-1",
      sellResources: [RESOURCE_KEANIUM],
      hardFloor: { [RESOURCE_KEANIUM]: 1 },
      forecastBuffer: { [RESOURCE_KEANIUM]: 1_000 },
      minDealAmount: 500,
      makerBatchAmount: 1_000,
      creditReserve: 0,
    });
    expect(exactSafeBatch.validForPlanning).toBe(true);
    expect(exactSafeBatch.invalidReasons).toEqual([]);
  });

  it("只允许首版基础矿物白名单并保留显式空数组", () => {
    expect(
      resolveMarketSaleAutomationConfig({
        mode: "off",
        sellResources: [RESOURCE_KEANIUM, RESOURCE_ENERGY, RESOURCE_POWER],
      }).sellResources,
    ).toEqual([RESOURCE_KEANIUM]);
    expect(
      resolveMarketSaleAutomationConfig({
        mode: "off",
        sellResources: [],
      }).sellResources,
    ).toEqual([]);
  });

  it("盘口偏离、ask 保护和历史成交量比例使用保守默认并限制危险输入", () => {
    const defaults = resolveMarketSaleAutomationConfig();
    expect(defaults.maxHistoryAskDeviationRatio).toBe(0.5);
    expect(defaults.makerAskFloorRatio).toBe(0.98);
    expect(defaults.makerHistoryVolumeRatio).toBe(0.1);
    expect(defaults.minReferenceOrderNotional).toBe(100);
    expect(defaults.minReferenceDistinctRooms).toBe(3);

    const clamped = resolveMarketSaleAutomationConfig({
      maxHistoryAskDeviationRatio: 99,
      makerAskFloorRatio: 0.1,
      makerHistoryVolumeRatio: 99,
      minReferenceOrderNotional: 0,
      minReferenceDistinctRooms: 1,
    });
    expect(clamped.maxHistoryAskDeviationRatio).toBe(2);
    expect(clamped.makerAskFloorRatio).toBe(0.9);
    expect(clamped.makerHistoryVolumeRatio).toBe(1);
    expect(clamped.minReferenceOrderNotional).toBe(0.001);
    expect(clamped.minReferenceDistinctRooms).toBe(2);

    const decimals = resolveMarketSaleAutomationConfig({
      directDiscountRatio: 0.95,
      historyFloorRatio: 0.9,
      maxHistoryAskDeviationRatio: 0.35,
      makerAskFloorRatio: 0.97,
      makerHistoryVolumeRatio: 0.2,
      minReferenceOrderNotional: 12.5,
    });
    expect(decimals.directDiscountRatio).toBe(0.95);
    expect(decimals.historyFloorRatio).toBe(0.9);
    expect(decimals.maxHistoryAskDeviationRatio).toBe(0.35);
    expect(decimals.makerAskFloorRatio).toBe(0.97);
    expect(decimals.makerHistoryVolumeRatio).toBe(0.2);
    expect(decimals.minReferenceOrderNotional).toBe(12.5);
  });

  it("持久关闭 ResourceControl 与 Factory 旧市场入口", () => {
    Memory.cfg = {
      resourceControl: { market: { enabled: true } },
      factoryControl: { market: { enabled: true } },
    };
    enforceLegacyMarketSafetyLatch();
    expect(Memory.cfg.resourceControl?.market?.enabled).toBe(false);
    expect(Memory.cfg.factoryControl?.market?.enabled).toBe(false);
  });
});
