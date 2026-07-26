import { normalizeBoolean, normalizeNumber } from "@/runtime/configNormalize";
import type { MarketSaleMode } from "@/runtime/marketSaleLifecycle";

export type MarketSaleThresholdMap = Partial<Record<ResourceConstant, number>>;

export interface MarketSaleAutomationConfig {
  mode: MarketSaleMode;
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
  validForPlanning: boolean;
  invalidReasons: string[];
}

const BASE_MINERALS = new Set<ResourceConstant>([
  RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN,
  RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM,
  RESOURCE_KEANIUM,
  RESOURCE_ZYNTHIUM,
  RESOURCE_CATALYST,
]);

const VALID_MODES = new Set<MarketSaleMode>([
  "off",
  "shadow",
  "maker",
  "hybrid",
  "emergencyStop",
]);

function normalizeMode(value: unknown): MarketSaleMode {
  return typeof value === "string" && VALID_MODES.has(value as MarketSaleMode)
    ? (value as MarketSaleMode)
    : "off";
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

export function resolveMarketSaleAutomationConfig(
  rawValue: unknown = Memory.cfg?.marketSaleAutomation,
): MarketSaleAutomationConfig {
  const raw =
    rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? (rawValue as Record<string, unknown>)
      : {};
  const mode = normalizeMode(raw.mode);
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

  const invalidReasons: string[] = [];
  const requiresPlanningConfig =
    mode === "shadow" || mode === "maker" || mode === "hybrid";
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

  return {
    mode,
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
    terminalEnergyReserve: normalizeNumber(raw.terminalEnergyReserve, 25_000, 0, 300_000),
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
    canaryEnabled: normalizeBoolean(
      raw.canary && typeof raw.canary === "object"
        ? (raw.canary as Record<string, unknown>).enabled
        : undefined,
      true,
    ),
    canaryAllowExpansion: normalizeBoolean(
      raw.canary && typeof raw.canary === "object"
        ? (raw.canary as Record<string, unknown>).allowExpansion
        : undefined,
      false,
    ),
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
