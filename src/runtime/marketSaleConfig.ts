import { normalizeBoolean, normalizeNumber } from "@/runtime/configNormalize";
import type { MarketSaleMode } from "@/runtime/marketSaleLifecycle";
import { DIRECT_ENGINE_ASSUMPTIONS } from "@/runtime/marketSaleDirectEngineAssumptions";
import {
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE_FINGERPRINT,
  MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY,
  canonicalStableHashV1,
} from "@/runtime/marketDirectContinuousPolicy";
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_CONFIG_REVISION,
  MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
  MARKET_BASE_RESOURCE_LANE_DERIVATION_POLICY,
  MARKET_BASE_RESOURCE_POLICIES,
  parseMarketBaseResourceRawConfig,
  validateMarketBaseResourceRawConfig,
} from "@/runtime/marketBaseResourcePolicy";

export type MarketSaleThresholdMap = Partial<Record<ResourceConstant, number>>;
export type MarketSaleStrategy = "maker" | "direct";
export type MarketSaleDirectCapability =
  | "legacy-canary"
  | "continuous-v2"
  | "continuous-v3";
export type MarketSaleAutomationMode = MarketSaleMode | "direct";

export const MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION =
  "market-direct-continuous-v2-r1" as const;

export { MARKET_BASE_RESOURCE_CONFIG_REVISION };

/**
 * V3 的静态 runtime 指纹故意不包含动态 roster/lane set。account identity
 * 与 admission policy 由 exact permit 冻结，当前 scope 只进入两次 full
 * read/pending/monitor；新增房间不会改写未变化 lane 的稳定 shared 合同。
 */
export const MARKET_BASE_RESOURCE_RUNTIME_FINGERPRINT =
  canonicalStableHashV1({
    domain: "market-base-resource:runtime-v1",
    configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
    engineAssumptionCommit: DIRECT_ENGINE_ASSUMPTIONS.commit,
    catalog: MARKET_BASE_RESOURCE_CATALOG,
    resourcePolicyFingerprints: MARKET_BASE_RESOURCE_POLICIES.map(
      (policy) => policy.fingerprint,
    ),
    floorBootstrapFingerprint:
      MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.fingerprint,
    laneDerivationPolicy:
      MARKET_BASE_RESOURCE_LANE_DERIVATION_POLICY,
    historyPolicy: {
      minHistoryDays: 7,
      minHistoryTransactions: 100,
      minHistoryVolume: 100_000,
      historyFloorRatio: 0.95,
      historyMaxAgeDays: 2,
    },
  });

/**
 * 逐字等同于 canonical resolved V3 direct config 的公开安全指纹。运行时
 * 只有 resolver 完成 exact parser/scalar checks、递归冻结并登记私有
 * provenance 后才复用；自建对象、clone、spread 与 accessor 均不得命中。
 */
export const MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT =
  JSON.stringify({
    strategy: "continuous-v3",
    runtimeFingerprint: MARKET_BASE_RESOURCE_RUNTIME_FINGERPRINT,
    configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
    sellResources: [...MARKET_BASE_RESOURCE_CATALOG],
    hardFloor: sortedThresholdMap(
      Object.fromEntries(
        MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
          policy.resource,
          policy.hardFloor,
        ]),
      ),
    ),
    economicFloor: sortedThresholdMap(
      Object.fromEntries(
        MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
          policy.resource,
          policy.economicFloor,
        ]),
      ),
    ),
    forecastBuffer: sortedThresholdMap(
      Object.fromEntries(
        MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
          policy.resource,
          policy.laneReserve,
        ]),
      ),
    ),
    mismatchReasons: [],
  });

const marketBaseResourceCanonicalResolvedConfigs = new WeakSet<object>();

function freezeCanonicalResolvedConfig<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
      if (descriptor && "value" in descriptor) {
        freezeCanonicalResolvedConfig(descriptor.value);
      }
    }
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
  }
  return value;
}

/**
 * Continuous permit 冻结的是这份代码级运行合同。Memory 配置只允许逐字段
 * 匹配它，不能靠修改一个 revision 字符串放宽资源、房间或安全阈值。
 */
export const MARKET_DIRECT_CONTINUOUS_RUNTIME_FINGERPRINT =
  canonicalStableHashV1({
    domain: "market-direct-continuous:runtime-v1",
    configRevision: MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION,
    engineAssumptionCommit: DIRECT_ENGINE_ASSUMPTIONS.commit,
    executionTableFingerprint:
      MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE_FINGERPRINT,
    globalPolicy: MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY,
    historyPolicy: {
      minHistoryDays: 7,
      minHistoryTransactions: 100,
      minHistoryVolume: 100_000,
      historyFloorRatio: 0.95,
      historyMaxAgeDays: 2,
    },
  });

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
  directCapability?: MarketSaleDirectCapability;
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
      | "directCapability"
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

function normalizeDirectCapability(
  value: unknown,
): MarketSaleDirectCapability {
  if (value === "continuous-v3") return "continuous-v3";
  if (value === "continuous-v2") return "continuous-v2";
  return "legacy-canary";
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

function exactResourceSet(
  actual: readonly ResourceConstant[],
  expected: readonly ResourceConstant[],
): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return (
    left.length === right.length &&
    left.every((resource, index) => resource === right[index])
  );
}

/**
 * Continuous 不复用 legacy X canary 的单资源配置解释。只有 Memory 中的
 * 显式配置与 canonical execution table 逐字段一致时，permit 才可能写入。
 */
export function marketDirectContinuousConfigMismatchReasons(
  config: MarketSaleAutomationConfig,
): string[] {
  const reasons: string[] = [];
  const expectedResources =
    MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
      (entry) => entry.resourceType,
    );
  if (config.directCapability !== "continuous-v2") {
    reasons.push("continuous_direct_capability_mismatch");
  }
  if (
    config.configRevision !==
    MARKET_DIRECT_CONTINUOUS_CONFIG_REVISION
  ) {
    reasons.push("continuous_direct_config_revision_mismatch");
  }
  if (!exactResourceSet(config.sellResources, expectedResources)) {
    reasons.push("continuous_direct_resource_table_mismatch");
  }
  for (const entry of MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE) {
    if (config.hardFloor[entry.resourceType] !== entry.hardFloor) {
      reasons.push(
        `continuous_direct_hard_floor_mismatch:${entry.resourceType}`,
      );
    }
    if (
      config.economicFloor[entry.resourceType] !== entry.economicFloor
    ) {
      reasons.push(
        `continuous_direct_economic_floor_mismatch:${entry.resourceType}`,
      );
    }
    if (
      config.forecastBuffer[entry.resourceType] !== entry.laneReserve
    ) {
      reasons.push(
        `continuous_direct_lane_reserve_mismatch:${entry.resourceType}`,
      );
    }
  }
  const expectedMaximumNotional = Math.max(
    ...MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
      (entry) => entry.minOrderNotional,
    ),
  );
  const expectedRawScan = Math.max(
    ...MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
      (entry) => entry.maxRawOrdersScanned,
    ),
  );
  const expectedEligibleScan = Math.max(
    ...MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
      (entry) => entry.maxEligibleOrdersPriced,
    ),
  );
  const expectedTransactionEnergy = Math.min(
    ...MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
      (entry) => entry.maxTransactionEnergy,
    ),
  );
  const expectedTerminalReserve = Math.max(
    ...MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map(
      (entry) => entry.terminalEnergyReserve,
    ),
  );
  const exactSharedValues: Array<
    readonly [boolean, string]
  > = [
    [
      config.minDealAmount ===
        MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.plannedDealAmount,
      "continuous_direct_min_deal_amount_mismatch",
    ],
    [
      directConfigValue(
        config,
        "maxDirectDealAmount",
        MARKET_DIRECT_CANARY_POLICY.maxDealAmount,
      ) === MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.plannedDealAmount,
      "continuous_direct_max_deal_amount_mismatch",
    ],
    [
      directConfigValue(
        config,
        "maxDirectDealsPerCycle",
        MARKET_DIRECT_CANARY_POLICY.maxDealsPerCycle,
      ) === MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.maxDealsPerCycle,
      "continuous_direct_deals_per_cycle_mismatch",
    ],
    [
      directConfigValue(
        config,
        "minDirectOrderAmount",
        MARKET_DIRECT_CANARY_POLICY.minOrderAmount,
      ) === MARKET_DIRECT_CONTINUOUS_GLOBAL_POLICY.plannedDealAmount,
      "continuous_direct_min_order_amount_mismatch",
    ],
    [
      directConfigValue(
        config,
        "minDirectOrderNotional",
        MARKET_DIRECT_CANARY_POLICY.minOrderNotional,
      ) === expectedMaximumNotional,
      "continuous_direct_scalar_notional_mismatch",
    ],
    [
      directConfigValue(
        config,
        "maxDirectRawOrdersScannedPerCycle",
        MARKET_DIRECT_CANARY_POLICY.maxRawOrdersScannedPerCycle,
      ) === expectedRawScan,
      "continuous_direct_raw_scan_mismatch",
    ],
    [
      directConfigValue(
        config,
        "maxDirectEligibleOrdersPricedPerCycle",
        MARKET_DIRECT_CANARY_POLICY.maxEligibleOrdersPricedPerCycle,
      ) === expectedEligibleScan,
      "continuous_direct_eligible_scan_mismatch",
    ],
    [
      directConfigValue(
        config,
        "maxDirectTransactionEnergy",
        MARKET_DIRECT_CANARY_POLICY.maxTransactionEnergy,
      ) === expectedTransactionEnergy,
      "continuous_direct_transaction_energy_mismatch",
    ],
    [
      config.terminalEnergyReserve === expectedTerminalReserve,
      "continuous_direct_terminal_reserve_mismatch",
    ],
    [
      directConfigValue(
        config,
        "energyShadowHardFloor",
        MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor,
      ) === MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor,
      "continuous_direct_energy_shadow_floor_mismatch",
    ],
    [
      config.energyShadowPrice === undefined,
      "continuous_direct_fixed_energy_shadow_forbidden",
    ],
    [
      config.canaryEnabled && !config.canaryAllowExpansion,
      "continuous_direct_canary_latch_mismatch",
    ],
    [
      config.directCanaryMaxConfirmedDeals === 1,
      "continuous_direct_canary_count_mismatch",
    ],
    [
      config.planningSnapshotMaxAgeTicks === 10,
      "continuous_direct_snapshot_age_mismatch",
    ],
    [
      config.minHistoryDays === 7,
      "continuous_direct_history_days_mismatch",
    ],
    [
      config.minHistoryTransactions === 100,
      "continuous_direct_history_transactions_mismatch",
    ],
    [
      config.minHistoryVolume === 100_000,
      "continuous_direct_history_volume_mismatch",
    ],
    [
      config.historyFloorRatio === 0.95,
      "continuous_direct_history_ratio_mismatch",
    ],
    [
      config.historyMaxAgeDays === 2,
      "continuous_direct_history_age_mismatch",
    ],
  ];
  for (const [matches, reason] of exactSharedValues) {
    if (!matches) reasons.push(reason);
  }
  return [...new Set(reasons)].sort();
}

/**
 * V3 只接受签入的七资源安全合同。原始配置的重复/额外项由
 * validateMarketBaseResourceRawConfig 在 normalizer 前检查；这里再校验
 * 规范化后的完整值，防止调用方绕过 resolve 直接构造 config。
 */
export function marketBaseResourceV3ConfigMismatchReasons(
  config: MarketSaleAutomationConfig,
): string[] {
  const reasons = [
    ...parseMarketBaseResourceRawConfig({
      sellResources: config.sellResources,
      hardFloor: config.hardFloor,
      economicFloor: config.economicFloor,
      forecastBuffer: config.forecastBuffer,
    }).invalidReasons,
  ];
  if (config.directCapability !== "continuous-v3") {
    reasons.push("base_resource_v3_capability_mismatch");
  }
  if (config.configRevision !== MARKET_BASE_RESOURCE_CONFIG_REVISION) {
    reasons.push("base_resource_v3_config_revision_mismatch");
  }
  const maximumNotional = Math.max(
    ...MARKET_BASE_RESOURCE_POLICIES.map(
      (policy) => policy.minOrderNotional,
    ),
  );
  const sharedValues: Array<readonly [boolean, string]> = [
    [
      config.minDealAmount === 1_000,
      "base_resource_v3_min_deal_amount_mismatch",
    ],
    [
      directConfigValue(
        config,
        "maxDirectDealAmount",
        MARKET_DIRECT_CANARY_POLICY.maxDealAmount,
      ) === 1_000,
      "base_resource_v3_max_deal_amount_mismatch",
    ],
    [
      directConfigValue(
        config,
        "maxDirectDealsPerCycle",
        MARKET_DIRECT_CANARY_POLICY.maxDealsPerCycle,
      ) === 1,
      "base_resource_v3_deals_per_cycle_mismatch",
    ],
    [
      directConfigValue(
        config,
        "minDirectOrderAmount",
        MARKET_DIRECT_CANARY_POLICY.minOrderAmount,
      ) === 1_000,
      "base_resource_v3_min_order_amount_mismatch",
    ],
    [
      directConfigValue(
        config,
        "minDirectOrderNotional",
        MARKET_DIRECT_CANARY_POLICY.minOrderNotional,
      ) === maximumNotional,
      "base_resource_v3_scalar_notional_mismatch",
    ],
    [
      directConfigValue(
        config,
        "maxDirectRawOrdersScannedPerCycle",
        MARKET_DIRECT_CANARY_POLICY.maxRawOrdersScannedPerCycle,
      ) === 1_000,
      "base_resource_v3_raw_scan_mismatch",
    ],
    [
      directConfigValue(
        config,
        "maxDirectEligibleOrdersPricedPerCycle",
        MARKET_DIRECT_CANARY_POLICY.maxEligibleOrdersPricedPerCycle,
      ) === 200,
      "base_resource_v3_eligible_scan_mismatch",
    ],
    [
      directConfigValue(
        config,
        "maxDirectTransactionEnergy",
        MARKET_DIRECT_CANARY_POLICY.maxTransactionEnergy,
      ) === 1_000,
      "base_resource_v3_transaction_energy_mismatch",
    ],
    [
      config.terminalEnergyReserve === 25_000,
      "base_resource_v3_terminal_reserve_mismatch",
    ],
    [
      directConfigValue(
        config,
        "energyShadowHardFloor",
        MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor,
      ) === MARKET_DIRECT_CANARY_POLICY.minEnergyShadowHardFloor,
      "base_resource_v3_energy_shadow_floor_mismatch",
    ],
    [
      config.energyShadowPrice === undefined,
      "base_resource_v3_fixed_energy_shadow_forbidden",
    ],
    [
      config.canaryEnabled && !config.canaryAllowExpansion,
      "base_resource_v3_canary_latch_mismatch",
    ],
    [
      directConfigValue(
        config,
        "directCanaryMaxConfirmedDeals",
        MARKET_DIRECT_CANARY_POLICY.maxConfirmedDeals,
      ) === 1,
      "base_resource_v3_canary_count_mismatch",
    ],
    [
      directConfigValue(
        config,
        "planningSnapshotMaxAgeTicks",
        MARKET_DIRECT_CANARY_POLICY.planningSnapshotMaxAgeTicks,
      ) === 10,
      "base_resource_v3_snapshot_age_mismatch",
    ],
    [
      config.minHistoryDays === 7,
      "base_resource_v3_history_days_mismatch",
    ],
    [
      config.minHistoryTransactions === 100,
      "base_resource_v3_history_transactions_mismatch",
    ],
    [
      config.minHistoryVolume === 100_000,
      "base_resource_v3_history_volume_mismatch",
    ],
    [
      config.historyFloorRatio === 0.95,
      "base_resource_v3_history_ratio_mismatch",
    ],
    [
      config.historyMaxAgeDays === 2,
      "base_resource_v3_history_age_mismatch",
    ],
  ];
  for (const [matches, reason] of sharedValues) {
    if (!matches) reasons.push(reason);
  }
  return [...new Set(reasons)].sort();
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

  if (config.directCapability === "continuous-v3") {
    if (
      typeof config === "object" &&
      config !== null &&
      marketBaseResourceCanonicalResolvedConfigs.has(config)
    ) {
      return MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT;
    }
    const mismatchReasons =
      marketBaseResourceV3ConfigMismatchReasons(config);
    const fallbackPayload = {
      strategy: "continuous-v3",
      runtimeFingerprint: MARKET_BASE_RESOURCE_RUNTIME_FINGERPRINT,
      configRevision: config.configRevision ?? null,
      sellResources: [...config.sellResources],
      hardFloor: sortedThresholdMap(config.hardFloor),
      economicFloor: sortedThresholdMap(config.economicFloor),
      forecastBuffer: sortedThresholdMap(config.forecastBuffer),
      mismatchReasons,
    };
    const fallbackFingerprint = JSON.stringify(fallbackPayload);
    if (
      fallbackFingerprint !==
      MARKET_BASE_RESOURCE_CANONICAL_DIRECT_SAFETY_FINGERPRINT
    ) {
      return fallbackFingerprint;
    }
    // 私有 provenance、validForPlanning/invalidReasons 与 hostile accessor
    // 不进入历史 payload；unprovenanced fallback 若发生逐字碰撞，必须显式
    // 打破它，避免 operator equality 把自建输入重新提升成 canonical 证明。
    return JSON.stringify({
      ...fallbackPayload,
      mismatchReasons: [
        ...mismatchReasons,
        "base_resource_v3_noncanonical_direct_input",
      ],
    });
  }

  if (config.directCapability === "continuous-v2") {
    return JSON.stringify({
      strategy: "continuous-v2",
      runtimeFingerprint:
        MARKET_DIRECT_CONTINUOUS_RUNTIME_FINGERPRINT,
      configRevision: config.configRevision ?? null,
      sellResources: [...config.sellResources].sort(),
      hardFloor: sortedThresholdMap(config.hardFloor),
      economicFloor: sortedThresholdMap(config.economicFloor),
      forecastBuffer: sortedThresholdMap(config.forecastBuffer),
      mismatchReasons:
        marketDirectContinuousConfigMismatchReasons(config),
    });
  }

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
  const directCapability = normalizeDirectCapability(
    raw.directCapability,
  );
  const usesDirectStrategy =
    mode === "direct" ||
    (mode === "shadow" && shadowStrategy === "direct");
  const rawV3Validation =
    usesDirectStrategy && directCapability === "continuous-v3"
      ? validateMarketBaseResourceRawConfig(raw)
      : undefined;
  const sellResources =
    rawV3Validation?.valid && rawV3Validation.canonical
      ? [...rawV3Validation.canonical.sellResources] as ResourceConstant[]
      : rawV3Validation
        ? []
        : normalizeResourceList(raw.sellResources);
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

  if (usesDirectStrategy) {
    if (!rawCanaryShapeValid) {
      invalidReasons.push("direct_canary_config_invalid");
    }
    if (rawV3Validation) {
      for (const reason of rawV3Validation.invalidReasons) {
        addInvalidReason(invalidReasons, reason);
      }
    }
    if (directCapability === "legacy-canary") {
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
    }
    validateExplicitDirectNumericFields(raw, invalidReasons);
  }

  const resolved: ResolvedMarketSaleAutomationConfig = {
    mode,
    directCapability,
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
    validForPlanning: false,
    invalidReasons,
  };
  if (
    usesDirectStrategy &&
    directCapability === "continuous-v2"
  ) {
    for (const reason of marketDirectContinuousConfigMismatchReasons(
      resolved,
    )) {
      addInvalidReason(invalidReasons, reason);
    }
  }
  if (
    usesDirectStrategy &&
    directCapability === "continuous-v3"
  ) {
    for (const reason of marketBaseResourceV3ConfigMismatchReasons(
      resolved,
    )) {
      addInvalidReason(invalidReasons, reason);
    }
  }
  resolved.validForPlanning = invalidReasons.length === 0;
  if (
    usesDirectStrategy &&
    directCapability === "continuous-v3" &&
    rawV3Validation?.valid === true &&
    rawV3Validation.canonical &&
    resolved.validForPlanning &&
    invalidReasons.length === 0
  ) {
    freezeCanonicalResolvedConfig(resolved);
    marketBaseResourceCanonicalResolvedConfigs.add(resolved);
  }
  return resolved;
}

export function enforceLegacyMarketSafetyLatch(): void {
  if (!Memory.cfg) Memory.cfg = {};
  if (!Memory.cfg.pixelGenerator) {
    Memory.cfg.pixelGenerator = {};
  }
  Memory.cfg.pixelGenerator.enabled = false;
  if (!Memory.cfg.resourceControl) Memory.cfg.resourceControl = {};
  if (!Memory.cfg.resourceControl.market) Memory.cfg.resourceControl.market = {};
  Memory.cfg.resourceControl.market.enabled = false;

  if (!Memory.cfg.factoryControl) Memory.cfg.factoryControl = {};
  if (!Memory.cfg.factoryControl.market) Memory.cfg.factoryControl.market = {};
  Memory.cfg.factoryControl.market.enabled = false;
}
