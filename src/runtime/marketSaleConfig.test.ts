import {
  directSafetyFingerprint,
  enforceLegacyMarketSafetyLatch,
  MARKET_DIRECT_CANARY_POLICY,
  MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION,
  MARKET_DIRECT_CONTINUOUS_RUNTIME_FINGERPRINT,
  marketDirectContinuousConfigMismatchReasons,
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

  it("旧 shadow 缺少策略时保持 Maker，Direct 字段使用首发安全默认", () => {
    const config = resolveMarketSaleAutomationConfig({
      mode: "shadow",
      configRevision: "maker-rev",
      sellResources: [RESOURCE_KEANIUM],
      hardFloor: { [RESOURCE_KEANIUM]: 1 },
      forecastBuffer: { [RESOURCE_KEANIUM]: 5_000 },
      creditReserve: 0,
    });

    expect(config.shadowStrategy).toBe("maker");
    expect(config.validForPlanning).toBe(true);
    expect(config.maxDirectDealAmount).toBe(
      MARKET_DIRECT_CANARY_POLICY.maxDealAmount,
    );
    expect(config.maxDirectDealsPerCycle).toBe(
      MARKET_DIRECT_CANARY_POLICY.maxDealsPerCycle,
    );
    expect(config.minDirectOrderAmount).toBe(
      MARKET_DIRECT_CANARY_POLICY.minOrderAmount,
    );
    expect(config.minDirectOrderNotional).toBe(
      MARKET_DIRECT_CANARY_POLICY.minOrderNotional,
    );
    expect(config.maxDirectRawOrdersScannedPerCycle).toBe(
      MARKET_DIRECT_CANARY_POLICY.maxRawOrdersScannedPerCycle,
    );
    expect(config.maxDirectEligibleOrdersPricedPerCycle).toBe(
      MARKET_DIRECT_CANARY_POLICY.maxEligibleOrdersPricedPerCycle,
    );
    expect(config.maxDirectTransactionEnergy).toBe(
      MARKET_DIRECT_CANARY_POLICY.maxTransactionEnergy,
    );
    expect(config.directCanaryMaxConfirmedDeals).toBe(
      MARKET_DIRECT_CANARY_POLICY.maxConfirmedDeals,
    );
    expect(config.energyShadowHardFloor).toBe(
      MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor,
    );
    expect(config.planningSnapshotMaxAgeTicks).toBe(
      MARKET_DIRECT_CANARY_POLICY.planningSnapshotMaxAgeTicks,
    );
  });

  function validDirectRaw(
    mode: "shadow" | "direct" = "shadow",
  ): Record<string, unknown> {
    return {
      mode,
      ...(mode === "shadow" ? { shadowStrategy: "direct" } : {}),
      configRevision: "x-direct-rev",
      sellResources: [RESOURCE_CATALYST],
      hardFloor: { [RESOURCE_CATALYST]: 600 },
      economicFloor: { [RESOURCE_CATALYST]: 600 },
      forecastBuffer: { [RESOURCE_CATALYST]: 100_000 },
      minDealAmount: 500,
      makerBatchAmount: 5_000,
      creditReserve: 0,
      terminalEnergyReserve: 25_000,
    };
  }

  function validContinuousRaw(): Record<string, unknown> {
    return {
      mode: "direct",
      directCapability: "continuous-v2",
      configRevision: MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION,
      sellResources: [
        RESOURCE_CATALYST,
        RESOURCE_HYDROGEN,
        RESOURCE_ZYNTHIUM,
      ],
      hardFloor: {
        [RESOURCE_CATALYST]: 600,
        [RESOURCE_HYDROGEN]: 428,
        [RESOURCE_ZYNTHIUM]: 43,
      },
      economicFloor: {
        [RESOURCE_CATALYST]: 600,
        [RESOURCE_HYDROGEN]: 451,
        [RESOURCE_ZYNTHIUM]: 45,
      },
      forecastBuffer: {
        [RESOURCE_CATALYST]: 100_000,
        [RESOURCE_HYDROGEN]: 100_000,
        [RESOURCE_ZYNTHIUM]: 100_000,
      },
      minDealAmount: 1_000,
      makerBatchAmount: 5_000,
      creditReserve: 0,
      terminalEnergyReserve: 25_000,
      maxDirectDealAmount: 1_000,
      maxDirectDealsPerCycle: 1,
      minDirectOrderAmount: 1_000,
      minDirectOrderNotional: 600_000,
      maxDirectRawOrdersScannedPerCycle: 1_000,
      maxDirectEligibleOrdersPricedPerCycle: 200,
      maxDirectTransactionEnergy: 1_000,
      directCanaryMaxConfirmedDeals: 1,
      energyShadowHardFloor: 20,
      planningSnapshotMaxAgeTicks: 10,
      minHistoryDays: 7,
      minHistoryTransactions: 100,
      minHistoryVolume: 100_000,
      historyFloorRatio: 0.95,
      historyMaxAgeDays: 2,
      canary: { enabled: true, allowExpansion: false },
    };
  }

  it("Direct Shadow 与 active Direct 接受同一首发安全合同", () => {
    const shadow = resolveMarketSaleAutomationConfig(validDirectRaw());
    const active = resolveMarketSaleAutomationConfig(validDirectRaw("direct"));

    expect(shadow.mode).toBe("shadow");
    expect(shadow.shadowStrategy).toBe("direct");
    expect(shadow.validForPlanning).toBe(true);
    expect(shadow.invalidReasons).toEqual([]);
    expect(active.mode).toBe("direct");
    expect(active.validForPlanning).toBe(true);
    expect(active.invalidReasons).toEqual([]);
  });

  it("Continuous v2 只接受完整 X/H/Z canonical 配置", () => {
    const config = resolveMarketSaleAutomationConfig(
      validContinuousRaw(),
    );

    expect(config.directCapability).toBe("continuous-v2");
    expect(config.validForPlanning).toBe(true);
    expect(config.invalidReasons).toEqual([]);
    expect(marketDirectContinuousConfigMismatchReasons(config)).toEqual(
      [],
    );
    expect(directSafetyFingerprint(config)).toContain(
      MARKET_DIRECT_CONTINUOUS_RUNTIME_FINGERPRINT,
    );
  });

  it.each([
    [
      "lower H floor",
      {
        hardFloor: {
          [RESOURCE_CATALYST]: 600,
          [RESOURCE_HYDROGEN]: 427,
          [RESOURCE_ZYNTHIUM]: 43,
        },
      },
      `continuous_direct_hard_floor_mismatch:${RESOURCE_HYDROGEN}`,
    ],
    [
      "lower Z reserve",
      {
        forecastBuffer: {
          [RESOURCE_CATALYST]: 100_000,
          [RESOURCE_HYDROGEN]: 100_000,
          [RESOURCE_ZYNTHIUM]: 99_999,
        },
      },
      `continuous_direct_lane_reserve_mismatch:${RESOURCE_ZYNTHIUM}`,
    ],
    [
      "fixed energy price",
      { energyShadowPrice: 0.001 },
      "continuous_direct_fixed_energy_shadow_forbidden",
    ],
  ])(
    "Continuous v2 对 %s fail-closed",
    (_label, override, expectedReason) => {
      const config = resolveMarketSaleAutomationConfig({
        ...validContinuousRaw(),
        ...override,
      });
      expect(config.validForPlanning).toBe(false);
      expect(config.invalidReasons).toContain(expectedReason);
    },
  );

  it("Direct 允许把资源、能量底线和生产缓冲调得更保守", () => {
    const config = resolveMarketSaleAutomationConfig({
      ...validDirectRaw(),
      hardFloor: { [RESOURCE_CATALYST]: 700 },
      economicFloor: { [RESOURCE_CATALYST]: 700 },
      forecastBuffer: { [RESOURCE_CATALYST]: 200_000 },
      terminalEnergyReserve: 30_000,
      energyShadowHardFloor: 30,
    });

    expect(config.validForPlanning).toBe(true);
    expect(config.invalidReasons).toEqual([]);
  });

  it("Direct 首发 allowlist 必须是原始配置中恰好一个 X", () => {
    for (const sellResources of [
      [],
      [RESOURCE_KEANIUM],
      [RESOURCE_CATALYST, RESOURCE_KEANIUM],
      [RESOURCE_CATALYST, RESOURCE_ENERGY],
      [RESOURCE_CATALYST, RESOURCE_CATALYST],
    ]) {
      const config = resolveMarketSaleAutomationConfig({
        ...validDirectRaw(),
        sellResources,
      });
      expect(config.validForPlanning).toBe(false);
      expect(config.invalidReasons).toContain(
        "direct_canary_allowlist_invalid",
      );
    }
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["canary disabled", { canary: { enabled: false } }, "direct_canary_disabled"],
    [
      "expansion enabled",
      { canary: { allowExpansion: true } },
      "direct_canary_expansion_enabled",
    ],
    [
      "min order below fixed policy",
      { minDirectOrderAmount: 999 },
      "direct_min_order_amount_invalid",
    ],
    [
      "min order above fixed policy",
      { minDirectOrderAmount: 1_001 },
      "direct_min_order_amount_invalid",
    ],
    [
      "notional below fixed policy",
      { minDirectOrderNotional: 599_999 },
      "direct_min_order_notional_invalid",
    ],
    [
      "notional above fixed policy",
      { minDirectOrderNotional: 600_001 },
      "direct_min_order_notional_invalid",
    ],
    [
      "deal amount below fixed policy",
      { maxDirectDealAmount: 999 },
      "direct_max_deal_amount_invalid",
    ],
    [
      "deal amount above fixed policy",
      { maxDirectDealAmount: 1_001 },
      "direct_max_deal_amount_invalid",
    ],
    [
      "deals per cycle above fixed policy",
      { maxDirectDealsPerCycle: 2 },
      "direct_max_deals_per_cycle_invalid",
    ],
    [
      "confirmed deals above fixed policy",
      { directCanaryMaxConfirmedDeals: 2 },
      "direct_max_confirmed_deals_invalid",
    ],
    [
      "raw scan differs from fixed policy",
      { maxDirectRawOrdersScannedPerCycle: 999 },
      "direct_raw_order_scan_limit_invalid",
    ],
    [
      "eligible pricing differs from fixed policy",
      { maxDirectEligibleOrdersPricedPerCycle: 201 },
      "direct_eligible_order_pricing_limit_invalid",
    ],
    [
      "transaction energy differs from fixed policy",
      { maxDirectTransactionEnergy: 1_001 },
      "direct_transaction_energy_limit_invalid",
    ],
    [
      "terminal reserve lowered",
      { terminalEnergyReserve: 24_999 },
      "direct_terminal_energy_reserve_below_minimum",
    ],
    [
      "energy hard floor lowered",
      { energyShadowHardFloor: 19.999 },
      "direct_energy_shadow_hard_floor_below_minimum",
    ],
    [
      "hard floor lowered",
      { hardFloor: { [RESOURCE_CATALYST]: 599.999 } },
      `direct_hard_floor_below_minimum:${RESOURCE_CATALYST}`,
    ],
    [
      "economic floor lowered",
      { economicFloor: { [RESOURCE_CATALYST]: 599.999 } },
      `direct_economic_floor_below_minimum:${RESOURCE_CATALYST}`,
    ],
    [
      "forecast buffer lowered",
      { forecastBuffer: { [RESOURCE_CATALYST]: 99_999 } },
      `direct_forecast_buffer_below_minimum:${RESOURCE_CATALYST}`,
    ],
    [
      "snapshot max age differs from planning interval",
      { planningSnapshotMaxAgeTicks: 11 },
      "direct_planning_snapshot_max_age_invalid",
    ],
  ])("Direct 首发配置对 %s fail closed", (_label, override, reason) => {
    const config = resolveMarketSaleAutomationConfig({
      ...validDirectRaw(),
      ...override,
    });

    expect(config.validForPlanning).toBe(false);
    expect(config.invalidReasons).toContain(reason);
  });

  it.each<[string, string]>([
    ["minDealAmount", "direct_min_deal_amount_invalid"],
    [
      "terminalEnergyReserve",
      "direct_terminal_energy_reserve_invalid",
    ],
    ["maxDirectDealAmount", "direct_max_deal_amount_invalid"],
    [
      "maxDirectDealsPerCycle",
      "direct_max_deals_per_cycle_invalid",
    ],
    ["minDirectOrderAmount", "direct_min_order_amount_invalid"],
    [
      "maxDirectRawOrdersScannedPerCycle",
      "direct_raw_order_scan_limit_invalid",
    ],
    [
      "maxDirectEligibleOrdersPricedPerCycle",
      "direct_eligible_order_pricing_limit_invalid",
    ],
    [
      "maxDirectTransactionEnergy",
      "direct_transaction_energy_limit_invalid",
    ],
    [
      "directCanaryMaxConfirmedDeals",
      "direct_max_confirmed_deals_invalid",
    ],
    [
      "planningSnapshotMaxAgeTicks",
      "direct_planning_snapshot_max_age_invalid",
    ],
    ["minHistoryDays", "direct_min_history_days_invalid"],
    [
      "minHistoryTransactions",
      "direct_min_history_transactions_invalid",
    ],
    ["minHistoryVolume", "direct_min_history_volume_invalid"],
    ["historyMaxAgeDays", "direct_history_max_age_days_invalid"],
  ])(
    "Direct 显式非法整数 %s 不得被夹取或回退为安全默认",
    (field, reason) => {
      for (const value of [0, -1, 1.5, "1", null, Number.NaN]) {
        const config = resolveMarketSaleAutomationConfig({
          ...validDirectRaw(),
          [field]: value,
        });

        expect(config.validForPlanning).toBe(false);
        expect(config.invalidReasons).toContain(reason);
      }
    },
  );

  it.each<[string, string]>([
    ["minDirectOrderNotional", "direct_min_order_notional_invalid"],
    [
      "energyShadowHardFloor",
      "direct_energy_shadow_hard_floor_invalid",
    ],
    ["energyShadowPrice", "direct_energy_shadow_price_invalid"],
    ["historyFloorRatio", "direct_history_floor_ratio_invalid"],
  ])(
    "Direct 显式非法数值 %s 不得被忽略或回退为默认",
    (field, reason) => {
      for (const value of [0, -1, "1", null, Number.NaN]) {
        const config = resolveMarketSaleAutomationConfig({
          ...validDirectRaw(),
          [field]: value,
        });

        expect(config.validForPlanning).toBe(false);
        expect(config.invalidReasons).toContain(reason);
      }
    },
  );

  it("Direct 合法的正小数安全参数保持有效", () => {
    const config = resolveMarketSaleAutomationConfig({
      ...validDirectRaw(),
      energyShadowHardFloor: 20.5,
      energyShadowPrice: 30.25,
      historyFloorRatio: 0.95,
    });

    expect(config.validForPlanning).toBe(true);
    expect(config.energyShadowHardFloor).toBe(20.5);
    expect(config.energyShadowPrice).toBe(30.25);
    expect(config.historyFloorRatio).toBe(0.95);
  });

  it.each([
    false,
    null,
    [],
    { enabled: "false" },
    { enabled: 0 },
    { allowExpansion: "false" },
  ])(
    "Direct 显式非法 canary 配置 %# 不得回退成默认开启",
    (canary) => {
      const config = resolveMarketSaleAutomationConfig({
        ...validDirectRaw(),
        canary,
      });

      expect(config.validForPlanning).toBe(false);
      expect(config.invalidReasons).toContain(
        "direct_canary_config_invalid",
      );
    },
  );

  it("Direct 单笔上限必须覆盖 minDeal 与 minDirectOrder", () => {
    const config = resolveMarketSaleAutomationConfig({
      ...validDirectRaw(),
      minDealAmount: 1_001,
    });

    expect(config.validForPlanning).toBe(false);
    expect(config.invalidReasons).toContain(
      "direct_max_deal_below_required_minimum",
    );
  });

  it("Direct 安全指纹排除 lifecycle mode，但隔离 Maker 和其他模式", () => {
    const shadowDirect = resolveMarketSaleAutomationConfig(validDirectRaw());
    const activeDirect = resolveMarketSaleAutomationConfig(
      validDirectRaw("direct"),
    );
    const directFingerprint = directSafetyFingerprint(shadowDirect);

    expect(directFingerprint).toBeDefined();
    expect(directSafetyFingerprint(activeDirect)).toBe(directFingerprint);
    expect(JSON.parse(directFingerprint!).configRevision).toBe(
      "x-direct-rev",
    );
    expect(
      directSafetyFingerprint(
        resolveMarketSaleAutomationConfig({
          ...validDirectRaw("direct"),
          configRevision: "x-direct-rev-2",
        }),
      ),
    ).not.toBe(directFingerprint);
    expect(
      directSafetyFingerprint(
        resolveMarketSaleAutomationConfig({
          ...validDirectRaw(),
          shadowStrategy: "maker",
        }),
      ),
    ).toBeUndefined();
    expect(
      directSafetyFingerprint(
        resolveMarketSaleAutomationConfig({
          ...validDirectRaw(),
          mode: "maker",
        }),
      ),
    ).toBeUndefined();
    expect(
      directSafetyFingerprint({
        ...activeDirect,
        terminalEnergyReserve: 30_000,
      }),
    ).not.toBe(directFingerprint);
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

  it("持久关闭 ResourceControl、Factory 旧市场入口与 Pixel 生成", () => {
    Memory.cfg = {
      resourceControl: { market: { enabled: true } },
      factoryControl: { market: { enabled: true } },
      pixelGenerator: { enabled: true },
    };
    enforceLegacyMarketSafetyLatch();
    expect(Memory.cfg.resourceControl?.market?.enabled).toBe(false);
    expect(Memory.cfg.factoryControl?.market?.enabled).toBe(false);
    expect(Memory.cfg.pixelGenerator?.enabled).toBe(false);
  });
});
