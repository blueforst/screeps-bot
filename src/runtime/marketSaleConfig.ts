import { normalizeBoolean, normalizeNumber } from "@/runtime/configNormalize";
import type { MarketSaleMode } from "@/runtime/marketSaleLifecycle";
import { DIRECT_ENGINE_ASSUMPTIONS } from "@/runtime/marketSaleDirectEngineAssumptions";

export type MarketSaleThresholdMap = Partial<Record<ResourceConstant, number>>;
export type MarketSaleStrategy = "maker" | "direct";
export type MarketSaleAutomationMode = MarketSaleMode | "direct";

export const MARKET_DIRECT_CANARY_POLICY = {
  resource: RESOURCE_CATALYST,
  minOrderAmount: 1_000,
  minOrderNotional: 600_000,
  maxDealAmount: 1_000,
  maxDealsPerCycle: 1,
  maxConfirmedDeals: 1,
  maxRawOrdersScannedPerCycle: 1_000,
  maxEligibleOrdersPricedPerCycle: 200,
  maxTransactionEnergy: 1_000,
  minTerminalEnergyReserve: 25_000,
  minEnergyShadowHardFloor: 20,
  minResourceFloor: 600,
  minForecastBuffer: 100_000,
  planningSnapshotMaxAgeTicks: 10,
} as const;

export interface MarketSaleAutomationConfig {
  mode: MarketSaleAutomationMode;
  /**
   * 旧 Shadow 未配置策略时仍表示 Maker Shadow。Direct active 则由 mode
   * 单独授权，不依赖该字段隐式升级。
   */
  shadowStrategy?: MarketSaleStrategy;
  configRevision?: string;
  sellResources: ResourceConstant[];
  hardFloor: MarketSaleThresholdMap;
  economicFloor: MarketSaleThresholdMap;
  forecastBuffer: MarketSaleThresholdMap;
  minDealAmount: number;
  maxDealAmount: number;
  makerBatchAmount: number;
  maxManagedOrders: number;
  minFreeOrderSlots: number;
  creditReserve?: number;
  rollingFeeBudget: number;
  feeWindowTicks: number;
  terminalEnergyReserve: number;
  energyShadowPrice?: number;
  directDiscountRatio: number;
  minHistoryDays: number;
  minHistoryTransactions: number;
  minHistoryVolume: number;
  historyFloorRatio: number;
  historyMaxAgeDays: number;
  minReferenceOrderAmount: number;
  /** 单个参考订单必须达到的最小名义金额（credits）。 */
  minReferenceOrderNotional: number;
  minReferenceOrderCount: number;
  /** 可信参考盘口至少覆盖的不同房间数，首版不得低于 2。 */
  minReferenceDistinctRooms: number;
  referenceDepthMultiplier: number;
  /** 可信 ask 与历史参考价允许的最大对称相对偏离。 */
  maxHistoryAskDeviationRatio?: number;
  /** maker 报价不得低于稳健 ask 参考价的该比例。 */
  makerAskFloorRatio?: number;
  /** maker 单批不得超过可信完整日成交量的该比例。 */
  makerHistoryVolumeRatio?: number;
  orderPolicyTtl: number;
  mutationBackoffTicks: number;
  canaryEnabled: boolean;
  canaryAllowExpansion: boolean;
  maxDirectDealAmount?: number;
  maxDirectDealsPerCycle?: number;
  minDirectOrderAmount?: number;
  minDirectOrderNotional?: number;
  maxDirectRawOrdersScannedPerCycle?: number;
  maxDirectEligibleOrdersPricedPerCycle?: number;
  maxDirectTransactionEnergy?: number;
  directCanaryMaxConfirmedDeals?: number;
  energyShadowHardFloor?: number;
  planningSnapshotMaxAgeTicks?: number;
  validForPlanning: boolean;
  invalidReasons: string[];
}

export type ResolvedMarketSaleAutomationConfig = MarketSaleAutomationConfig &
  Required<
    Pick<
      MarketSaleAutomationConfig,
      | "shadowStrategy"
      | "maxDirectDealAmount"
      | "maxDirectDealsPerCycle"
      | "minDirectOrderAmount"
      | "minDirectOrderNotional"
      | "maxDirectRawOrdersScannedPerCycle"
      | "maxDirectEligibleOrdersPricedPerCycle"
      | "maxDirectTransactionEnergy"
      | "directCanaryMaxConfirmedDeals"
      | "energyShadowHardFloor"
      | "planningSnapshotMaxAgeTicks"
    >
  >;

const BASE_MINERALS = new Set<ResourceConstant>([
  RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN,
  RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM,
  RESOURCE_KEANIUM,
  RESOURCE_ZYNTHIUM,
  RESOURCE_CATALYST,
]);

const VALID_MODES = new Set<MarketSaleAutomationMode>([
  "off",
  "shadow",
  "maker",
  "direct",
  "hybrid",
  "emergencyStop",
]);

function normalizeMode(value: unknown): MarketSaleAutomationMode {
  return typeof value === "string" &&
    VALID_MODES.has(value as MarketSaleAutomationMode)
    ? (value as MarketSaleAutomationMode)
    : "off";
}

function normalizeShadowStrategy(value: unknown): MarketSaleStrategy {
  return value === "direct" ? "direct" : "maker";
}

function normalizeResourceList(value: unknown): ResourceConstant[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<ResourceConstant>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const resource = item as ResourceConstant;
    if (!BASE_MINERALS.has(resource)) continue;
    unique.add(resource);
  }
  return [...unique];
}

function normalizeThresholdMap(value: unknown, min = 0, max = 1_000_000): MarketSaleThresholdMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: MarketSaleThresholdMap = {};
  for (const [key, raw] of Object.entries(value)) {
    const resource = key as ResourceConstant;
    if (!BASE_MINERALS.has(resource)) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    result[resource] = Math.max(min, Math.min(max, raw));
  }
  return result;
}

function normalizeDecimalNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function addInvalidReason(invalidReasons: string[], reason: string): void {
  if (!invalidReasons.includes(reason)) invalidReasons.push(reason);
}

function explicitNumberIsValid(
  raw: Record<string, unknown>,
  key: string,
  options: {
    min: number;
    max: number;
    integer?: boolean;
  },
): boolean {
  const value = raw[key];
  // Direct 字段缺失时允许使用代码级首发默认；显式 undefined 与缺失等价。
  if (value === undefined) return true;
  return Boolean(
    typeof value === "number" &&
      Number.isFinite(value) &&
      (!options.integer || Number.isSafeInteger(value)) &&
      value >= options.min &&
      value <= options.max,
  );
}

/**
 * 通用 normalizer 会夹取越界值或为错误类型回退默认值；这适合普通配置，
 * 但 Direct 安全合同必须区分“字段缺失”和“显式非法”。后者一律 fail-closed。
 */
function validateExplicitDirectNumericFields(
  raw: Record<string, unknown>,
  invalidReasons: string[],
): void {
  const integerRules = [
    ["minDealAmount", 100, 20_000, "direct_min_deal_amount_invalid"],
    [
      "terminalEnergyReserve",
      1,
      300_000,
      "direct_terminal_energy_reserve_invalid",
    ],
    [
      "maxDirectDealAmount",
      1,
      50_000,
      "direct_max_deal_amount_invalid",
    ],
    [
      "maxDirectDealsPerCycle",
      1,
      100,
      "direct_max_deals_per_cycle_invalid",
    ],
    [
      "minDirectOrderAmount",
      1,
      1_000_000,
      "direct_min_order_amount_invalid",
    ],
    [
      "maxDirectRawOrdersScannedPerCycle",
      1,
      100_000,
      "direct_raw_order_scan_limit_invalid",
    ],
    [
      "maxDirectEligibleOrdersPricedPerCycle",
      1,
      100_000,
      "direct_eligible_order_pricing_limit_invalid",
    ],
    [
      "maxDirectTransactionEnergy",
      1,
      1_000_000,
      "direct_transaction_energy_limit_invalid",
    ],
    [
      "directCanaryMaxConfirmedDeals",
      1,
      100,
      "direct_max_confirmed_deals_invalid",
    ],
    [
      "planningSnapshotMaxAgeTicks",
      1,
      1_000_000,
      "direct_planning_snapshot_max_age_invalid",
    ],
    ["minHistoryDays", 3, 14, "direct_min_history_days_invalid"],
    [
      "minHistoryTransactions",
      1,
      1_000_000,
      "direct_min_history_transactions_invalid",
    ],
    [
      "minHistoryVolume",
      1,
      1_000_000_000,
      "direct_min_history_volume_invalid",
    ],
    [
      "historyMaxAgeDays",
      1,
      14,
      "direct_history_max_age_days_invalid",
    ],
  ] as const;
  for (const [key, min, max, reason] of integerRules) {
    if (!explicitNumberIsValid(raw, key, { min, max, integer: true })) {
      addInvalidReason(invalidReasons, reason);
    }
  }

  const decimalRules = [
    [
      "minDirectOrderNotional",
      0.001,
      1_000_000_000,
      "direct_min_order_notional_invalid",
    ],
    [
      "energyShadowHardFloor",
      0.001,
      1_000_000,
      "direct_energy_shadow_hard_floor_invalid",
    ],
    [
      "energyShadowPrice",
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      "direct_energy_shadow_price_invalid",
    ],
    [
      "historyFloorRatio",
      0.5,
      1,
      "direct_history_floor_ratio_invalid",
    ],
  ] as const;
  for (const [key, min, max, reason] of decimalRules) {
    if (!explicitNumberIsValid(raw, key, { min, max })) {
      addInvalidReason(invalidReasons, reason);
    }
  }
}

function sortedThresholdMap(
  value: MarketSaleThresholdMap,
): Array<[string, number]> {
  return Object.entries(value)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right));
}

function directConfigValue<K extends keyof ResolvedMarketSaleAutomationConfig>(
  config: MarketSaleAutomationConfig,
  key: K,
  fallback: ResolvedMarketSaleAutomationConfig[K],
): ResolvedMarketSaleAutomationConfig[K] {
  const value = config[key];
  return (value === undefined
    ? fallback
    : value) as ResolvedMarketSaleAutomationConfig[K];
}

/**
 * Direct Shadow 与 active Direct 必须在不依赖生命周期 mode 的同一安全策略下
 * 得到相同指纹。Maker Shadow 及其他模式不产生 Direct 指纹，因此无法误继承
 * Direct 资格。
 */
export function directSafetyFingerprint(
  config: MarketSaleAutomationConfig,
): string | undefined {
  const strategy =
    config.mode === "direct"
      ? "direct"
      : config.mode === "shadow"
        ? config.shadowStrategy ?? "maker"
        : undefined;
  if (strategy !== "direct") return undefined;

  return JSON.stringify({
    strategy: "direct",
    engineAssumptionCommit: DIRECT_ENGINE_ASSUMPTIONS.commit,
    configRevision:
      typeof config.configRevision === "string"
        ? config.configRevision.trim()
        : null,
    sellResources: [...config.sellResources].sort(),
    hardFloor: sortedThresholdMap(config.hardFloor),
    economicFloor: sortedThresholdMap(config.economicFloor),
    forecastBuffer: sortedThresholdMap(config.forecastBuffer),
    minDealAmount: config.minDealAmount,
    terminalEnergyReserve: config.terminalEnergyReserve,
    energyShadowPrice: config.energyShadowPrice,
    energyShadowHardFloor: directConfigValue(
      config,
      "energyShadowHardFloor",
      MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor,
    ),
    minHistoryDays: config.minHistoryDays,
    minHistoryTransactions: config.minHistoryTransactions,
    minHistoryVolume: config.minHistoryVolume,
    historyFloorRatio: config.historyFloorRatio,
    historyMaxAgeDays: config.historyMaxAgeDays,
    maxDirectDealAmount: directConfigValue(
      config,
      "maxDirectDealAmount",
      MARKET_DIRECT_CANARY_POLICY.maxDealAmount,
    ),
    maxDirectDealsPerCycle: directConfigValue(
      config,
      "maxDirectDealsPerCycle",
      MARKET_DIRECT_CANARY_POLICY.maxDealsPerCycle,
    ),
    minDirectOrderAmount: directConfigValue(
      config,
      "minDirectOrderAmount",
      MARKET_DIRECT_CANARY_POLICY.minOrderAmount,
    ),
    minDirectOrderNotional: directConfigValue(
      config,
      "minDirectOrderNotional",
      MARKET_DIRECT_CANARY_POLICY.minOrderNotional,
    ),
    maxDirectRawOrdersScannedPerCycle: directConfigValue(
      config,
      "maxDirectRawOrdersScannedPerCycle",
      MARKET_DIRECT_CANARY_POLICY.maxRawOrdersScannedPerCycle,
    ),
    maxDirectEligibleOrdersPricedPerCycle: directConfigValue(
      config,
      "maxDirectEligibleOrdersPricedPerCycle",
      MARKET_DIRECT_CANARY_POLICY.maxEligibleOrdersPricedPerCycle,
    ),
    maxDirectTransactionEnergy: directConfigValue(
      config,
      "maxDirectTransactionEnergy",
      MARKET_DIRECT_CANARY_POLICY.maxTransactionEnergy,
    ),
    directCanaryMaxConfirmedDeals: directConfigValue(
      config,
      "directCanaryMaxConfirmedDeals",
      MARKET_DIRECT_CANARY_POLICY.maxConfirmedDeals,
    ),
    planningSnapshotMaxAgeTicks: directConfigValue(
      config,
      "planningSnapshotMaxAgeTicks",
      MARKET_DIRECT_CANARY_POLICY.planningSnapshotMaxAgeTicks,
    ),
    canaryEnabled: config.canaryEnabled,
    canaryAllowExpansion: config.canaryAllowExpansion,
  });
}

export function resolveMarketSaleAutomationConfig(
  rawValue: unknown = Memory.cfg?.marketSaleAutomation,
): ResolvedMarketSaleAutomationConfig {
  const raw =
    rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? (rawValue as Record<string, unknown>)
      : {};
  const mode = normalizeMode(raw.mode);
  const shadowStrategy = normalizeShadowStrategy(raw.shadowStrategy);
  const sellResources = normalizeResourceList(raw.sellResources);
  const hardFloor = normalizeThresholdMap(raw.hardFloor, 0, 1_000_000);
  const economicFloor = normalizeThresholdMap(raw.economicFloor, 0, 1_000_000);
  const forecastBuffer = normalizeThresholdMap(raw.forecastBuffer, 0, 1_000_000);
  const minDealAmount = normalizeNumber(raw.minDealAmount, 500, 100, 20_000);
  const makerBatchAmount = normalizeNumber(
    raw.makerBatchAmount,
    5_000,
    100,
    20_000,
  );
  const minimumForecastBuffer = Math.max(
    minDealAmount,
    makerBatchAmount,
  );
  const configRevision =
    typeof raw.configRevision === "string" && raw.configRevision.trim().length > 0
      ? raw.configRevision.trim()
      : undefined;
  const creditReserve =
    typeof raw.creditReserve === "number" &&
    Number.isFinite(raw.creditReserve) &&
    raw.creditReserve >= 0
      ? raw.creditReserve
      : undefined;
  const canary =
    raw.canary && typeof raw.canary === "object" && !Array.isArray(raw.canary)
      ? (raw.canary as Record<string, unknown>)
      : {};
  const rawCanaryShapeValid =
    raw.canary === undefined ||
    (raw.canary !== null &&
      typeof raw.canary === "object" &&
      !Array.isArray(raw.canary) &&
      (!Object.prototype.hasOwnProperty.call(raw.canary, "enabled") ||
        typeof (raw.canary as Record<string, unknown>).enabled ===
          "boolean") &&
      (!Object.prototype.hasOwnProperty.call(
        raw.canary,
        "allowExpansion",
      ) ||
        typeof (raw.canary as Record<string, unknown>).allowExpansion ===
          "boolean"));
  const canaryEnabled = normalizeBoolean(canary.enabled, true);
  const canaryAllowExpansion = normalizeBoolean(canary.allowExpansion, false);
  const terminalEnergyReserve = normalizeNumber(
    raw.terminalEnergyReserve,
    25_000,
    0,
    300_000,
  );
  const maxDirectDealAmount = normalizeNumber(
    raw.maxDirectDealAmount,
    MARKET_DIRECT_CANARY_POLICY.maxDealAmount,
    1,
    50_000,
  );
  const maxDirectDealsPerCycle = normalizeNumber(
    raw.maxDirectDealsPerCycle,
    MARKET_DIRECT_CANARY_POLICY.maxDealsPerCycle,
    1,
    100,
  );
  const minDirectOrderAmount = normalizeNumber(
    raw.minDirectOrderAmount,
    MARKET_DIRECT_CANARY_POLICY.minOrderAmount,
    1,
    1_000_000,
  );
  const minDirectOrderNotional = normalizeDecimalNumber(
    raw.minDirectOrderNotional,
    MARKET_DIRECT_CANARY_POLICY.minOrderNotional,
    0.001,
    1_000_000_000,
  );
  const maxDirectRawOrdersScannedPerCycle = normalizeNumber(
    raw.maxDirectRawOrdersScannedPerCycle,
    MARKET_DIRECT_CANARY_POLICY.maxRawOrdersScannedPerCycle,
    1,
    100_000,
  );
  const maxDirectEligibleOrdersPricedPerCycle = normalizeNumber(
    raw.maxDirectEligibleOrdersPricedPerCycle,
    MARKET_DIRECT_CANARY_POLICY.maxEligibleOrdersPricedPerCycle,
    1,
    100_000,
  );
  const maxDirectTransactionEnergy = normalizeNumber(
    raw.maxDirectTransactionEnergy,
    MARKET_DIRECT_CANARY_POLICY.maxTransactionEnergy,
    0,
    1_000_000,
  );
  const directCanaryMaxConfirmedDeals = normalizeNumber(
    raw.directCanaryMaxConfirmedDeals,
    MARKET_DIRECT_CANARY_POLICY.maxConfirmedDeals,
    1,
    100,
  );
  const energyShadowHardFloor = normalizeDecimalNumber(
    raw.energyShadowHardFloor,
    MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor,
    0.001,
    1_000_000,
  );
  const planningSnapshotMaxAgeTicks = normalizeNumber(
    raw.planningSnapshotMaxAgeTicks,
    MARKET_DIRECT_CANARY_POLICY.planningSnapshotMaxAgeTicks,
    1,
    1_000_000,
  );

  const invalidReasons: string[] = [];
  const requiresPlanningConfig =
    mode === "shadow" ||
    mode === "maker" ||
    mode === "direct" ||
    mode === "hybrid";
  if (requiresPlanningConfig) {
    if (!configRevision) invalidReasons.push("config_revision_missing");
    if (sellResources.length === 0) invalidReasons.push("sell_resources_empty");
    if (creditReserve === undefined) invalidReasons.push("credit_reserve_missing");
    for (const resource of sellResources) {
      const floor = hardFloor[resource];
      if (typeof floor !== "number" || !Number.isFinite(floor) || floor <= 0) {
        invalidReasons.push(`hard_floor_missing:${resource}`);
      }
      const buffer = forecastBuffer[resource];
      if (
        typeof buffer !== "number" ||
        !Number.isFinite(buffer) ||
        buffer <= 0
      ) {
        invalidReasons.push(`forecast_buffer_missing:${resource}`);
      } else if (buffer < minimumForecastBuffer) {
        invalidReasons.push(`forecast_buffer_below_safe_batch:${resource}`);
      }
    }
  }

  const usesDirectStrategy =
    mode === "direct" || (mode === "shadow" && shadowStrategy === "direct");
  if (usesDirectStrategy) {
    if (!rawCanaryShapeValid) {
      invalidReasons.push("direct_canary_config_invalid");
    }
    const rawAllowlistIsExactlyX =
      Array.isArray(raw.sellResources) &&
      raw.sellResources.length === 1 &&
      raw.sellResources[0] === MARKET_DIRECT_CANARY_POLICY.resource;
    if (!rawAllowlistIsExactlyX) {
      invalidReasons.push("direct_canary_allowlist_invalid");
    }
    if (!canaryEnabled) {
      invalidReasons.push("direct_canary_disabled");
    }
    if (canaryAllowExpansion) {
      invalidReasons.push("direct_canary_expansion_enabled");
    }
    if (
      minDirectOrderAmount !== MARKET_DIRECT_CANARY_POLICY.minOrderAmount
    ) {
      invalidReasons.push("direct_min_order_amount_invalid");
    }
    if (
      minDirectOrderNotional !==
      MARKET_DIRECT_CANARY_POLICY.minOrderNotional
    ) {
      invalidReasons.push("direct_min_order_notional_invalid");
    }
    if (
      maxDirectDealAmount !== MARKET_DIRECT_CANARY_POLICY.maxDealAmount
    ) {
      invalidReasons.push("direct_max_deal_amount_invalid");
    }
    if (
      maxDirectDealsPerCycle !==
      MARKET_DIRECT_CANARY_POLICY.maxDealsPerCycle
    ) {
      invalidReasons.push("direct_max_deals_per_cycle_invalid");
    }
    if (
      directCanaryMaxConfirmedDeals !==
      MARKET_DIRECT_CANARY_POLICY.maxConfirmedDeals
    ) {
      invalidReasons.push("direct_max_confirmed_deals_invalid");
    }
    if (
      maxDirectRawOrdersScannedPerCycle !==
      MARKET_DIRECT_CANARY_POLICY.maxRawOrdersScannedPerCycle
    ) {
      invalidReasons.push("direct_raw_order_scan_limit_invalid");
    }
    if (
      maxDirectEligibleOrdersPricedPerCycle !==
      MARKET_DIRECT_CANARY_POLICY.maxEligibleOrdersPricedPerCycle
    ) {
      invalidReasons.push("direct_eligible_order_pricing_limit_invalid");
    }
    if (
      maxDirectTransactionEnergy !==
      MARKET_DIRECT_CANARY_POLICY.maxTransactionEnergy
    ) {
      invalidReasons.push("direct_transaction_energy_limit_invalid");
    }
    if (
      terminalEnergyReserve <
      MARKET_DIRECT_CANARY_POLICY.minTerminalEnergyReserve
    ) {
      invalidReasons.push("direct_terminal_energy_reserve_below_minimum");
    }
    if (
      energyShadowHardFloor <
      MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor
    ) {
      invalidReasons.push("direct_energy_shadow_hard_floor_below_minimum");
    }
    if (
      (hardFloor[MARKET_DIRECT_CANARY_POLICY.resource] ?? 0) <
      MARKET_DIRECT_CANARY_POLICY.minResourceFloor
    ) {
      invalidReasons.push(
        `direct_hard_floor_below_minimum:${MARKET_DIRECT_CANARY_POLICY.resource}`,
      );
    }
    if (
      (economicFloor[MARKET_DIRECT_CANARY_POLICY.resource] ?? 0) <
      MARKET_DIRECT_CANARY_POLICY.minResourceFloor
    ) {
      invalidReasons.push(
        `direct_economic_floor_below_minimum:${MARKET_DIRECT_CANARY_POLICY.resource}`,
      );
    }
    if (
      (forecastBuffer[MARKET_DIRECT_CANARY_POLICY.resource] ?? 0) <
      MARKET_DIRECT_CANARY_POLICY.minForecastBuffer
    ) {
      invalidReasons.push(
        `direct_forecast_buffer_below_minimum:${MARKET_DIRECT_CANARY_POLICY.resource}`,
      );
    }
    if (
      maxDirectDealAmount <
      Math.max(minDealAmount, minDirectOrderAmount)
    ) {
      invalidReasons.push("direct_max_deal_below_required_minimum");
    }
    if (
      planningSnapshotMaxAgeTicks !==
      MARKET_DIRECT_CANARY_POLICY.planningSnapshotMaxAgeTicks
    ) {
      invalidReasons.push("direct_planning_snapshot_max_age_invalid");
    }
    validateExplicitDirectNumericFields(raw, invalidReasons);
  }

  return {
    mode,
    shadowStrategy,
    configRevision,
    sellResources,
    hardFloor,
    economicFloor,
    forecastBuffer,
    minDealAmount,
    maxDealAmount: normalizeNumber(raw.maxDealAmount, 5_000, 100, 50_000),
    makerBatchAmount,
    maxManagedOrders: normalizeNumber(raw.maxManagedOrders, 3, 1, 20),
    minFreeOrderSlots: normalizeNumber(raw.minFreeOrderSlots, 5, 1, 100),
    creditReserve,
    rollingFeeBudget: normalizeNumber(raw.rollingFeeBudget, 1_000_000, 0, 1_000_000_000),
    feeWindowTicks: normalizeNumber(raw.feeWindowTicks, 20_000, 100, 1_000_000),
    terminalEnergyReserve,
    energyShadowPrice:
      typeof raw.energyShadowPrice === "number" &&
      Number.isFinite(raw.energyShadowPrice) &&
      raw.energyShadowPrice > 0
        ? raw.energyShadowPrice
        : undefined,
    directDiscountRatio: normalizeDecimalNumber(
      raw.directDiscountRatio,
      0.95,
      0.5,
      1,
    ),
    minHistoryDays: normalizeNumber(raw.minHistoryDays, 5, 3, 14),
    minHistoryTransactions: normalizeNumber(raw.minHistoryTransactions, 3, 1, 1_000_000),
    minHistoryVolume: normalizeNumber(raw.minHistoryVolume, 1_000, 1, 1_000_000_000),
    historyFloorRatio: normalizeDecimalNumber(
      raw.historyFloorRatio,
      0.9,
      0.5,
      1,
    ),
    historyMaxAgeDays: normalizeNumber(raw.historyMaxAgeDays, 2, 1, 14),
    minReferenceOrderAmount: normalizeNumber(raw.minReferenceOrderAmount, 1_000, 1, 1_000_000),
    minReferenceOrderNotional: normalizeDecimalNumber(
      raw.minReferenceOrderNotional,
      100,
      0.001,
      1_000_000_000,
    ),
    minReferenceOrderCount: normalizeNumber(raw.minReferenceOrderCount, 3, 1, 20),
    minReferenceDistinctRooms: normalizeNumber(
      raw.minReferenceDistinctRooms,
      3,
      2,
      20,
    ),
    referenceDepthMultiplier: normalizeNumber(raw.referenceDepthMultiplier, 3, 1, 20),
    maxHistoryAskDeviationRatio: normalizeDecimalNumber(
      raw.maxHistoryAskDeviationRatio,
      0.5,
      0.05,
      2,
    ),
    makerAskFloorRatio: normalizeDecimalNumber(
      raw.makerAskFloorRatio,
      0.98,
      0.9,
      1,
    ),
    makerHistoryVolumeRatio: normalizeDecimalNumber(
      raw.makerHistoryVolumeRatio,
      0.1,
      0.001,
      1,
    ),
    orderPolicyTtl: normalizeNumber(raw.orderPolicyTtl, 20_000, 100, 1_000_000),
    mutationBackoffTicks: normalizeNumber(raw.mutationBackoffTicks, 1_000, 10, 100_000),
    canaryEnabled,
    canaryAllowExpansion,
    maxDirectDealAmount,
    maxDirectDealsPerCycle,
    minDirectOrderAmount,
    minDirectOrderNotional,
    maxDirectRawOrdersScannedPerCycle,
    maxDirectEligibleOrdersPricedPerCycle,
    maxDirectTransactionEnergy,
    directCanaryMaxConfirmedDeals,
    energyShadowHardFloor,
    planningSnapshotMaxAgeTicks,
    validForPlanning: invalidReasons.length === 0,
    invalidReasons,
  };
}

export function enforceLegacyMarketSafetyLatch(): void {
  if (!Memory.cfg) Memory.cfg = {};
  if (!Memory.cfg.resourceControl) Memory.cfg.resourceControl = {};
  if (!Memory.cfg.resourceControl.market) Memory.cfg.resourceControl.market = {};
  Memory.cfg.resourceControl.market.enabled = false;

  if (!Memory.cfg.factoryControl) Memory.cfg.factoryControl = {};
  if (!Memory.cfg.factoryControl.market) Memory.cfg.factoryControl.market = {};
  Memory.cfg.factoryControl.market.enabled = false;
}
