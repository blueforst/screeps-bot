import {
  runMarketSaleAutomation,
  type MarketSaleAutomationResult,
  type MarketSalePlanCandidate,
} from "@/runtime/marketSaleAutomation";
import {
  resolveMarketSaleAutomationConfig,
  type MarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import {
  collectMarketSalePriceSnapshots,
  type CollectMarketSalePriceSnapshotsOptions,
  type MarketSalePriceSnapshotCollection,
  type MarketSalePricingDataStore,
  type MarketSalePricingReadMarket,
} from "@/runtime/marketSalePricingAdapter";
import type {
  MarketProtectionCandidate,
  MarketSaleProtectionLedger,
} from "@/runtime/marketSaleProtection";
import { collectLiveMarketSaleProtectionLedger } from "@/runtime/marketSaleProtectionAdapter";

const DEFAULT_MINIMUM_TERMINAL_FREE_CAPACITY = 50_000;
const MINIMUM_PRICING_CPU_BUCKET = 5_000;
const ORDER_BOOK_REFRESH_TICKS = 100;
const HISTORY_REFRESH_TICKS = 5_000;
const MAX_CACHED_RESOURCES = 8;

interface TimedCacheEntry<T> {
  refreshedAt: number;
  value: T;
}

interface PricingResultCache {
  signature: string;
  refreshedAt: number;
  value: MarketSalePriceSnapshotCollection;
}

let activeCacheSignature: string | undefined;
let pricingResultCache: PricingResultCache | undefined;
const historyCache = new Map<ResourceConstant, TimedCacheEntry<PriceHistory[]>>();
const orderBookCache = new Map<ResourceConstant, TimedCacheEntry<Order[]>>();

type CollectProtection = typeof collectLiveMarketSaleProtectionLedger;
type CollectPricing = typeof collectMarketSalePriceSnapshots;
type RunAutomation = typeof runMarketSaleAutomation;

export interface MarketSaleRuntimeDependencies {
  collectProtection?: CollectProtection;
  collectPricing?: CollectPricing;
  runAutomation?: RunAutomation;
}

export interface MarketSaleRuntimeCompositionContext {
  currentTick: number;
  resourceControlUpdatedAt?: number;
  capacityStateByRoom: Readonly<
    Record<string, "normal" | "pressure" | "emergency" | undefined>
  >;
  hubEnabled: boolean;
  hubRoomName?: string;
  minimumTerminalFreeCapacity: number;
  pricingEvidenceFresh?: boolean;
  pricingRejectionReason?: string;
}

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons.filter(Boolean))].slice(0, 40);
}

function makerNetPrice(
  snapshot: MarketSalePriceSnapshotCollection["snapshots"][ResourceConstant],
): number | undefined {
  const evaluation = snapshot?.makerPriceResult?.evaluation;
  if (
    !evaluation ||
    !Number.isSafeInteger(evaluation.netRemainingValueMilli) ||
    !Number.isSafeInteger(evaluation.postRemainingAmount) ||
    evaluation.postRemainingAmount <= 0
  ) {
    return undefined;
  }
  const value =
    evaluation.netRemainingValueMilli /
    evaluation.postRemainingAmount /
    1_000;
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Join the independently testable production-protection and pricing views.
 * Missing fields remain explicit rejection inputs; this function never
 * invents a floor, market depth, capacity state, or producer safety signal.
 */
export function composeMarketSalePlanCandidates(
  config: MarketSaleAutomationConfig,
  protection: MarketSaleProtectionLedger,
  pricing: MarketSalePriceSnapshotCollection,
  context: MarketSaleRuntimeCompositionContext,
): MarketSalePlanCandidate[] {
  const resourceControlCurrent =
    context.resourceControlUpdatedAt === context.currentTick;
  const hubStateKnown =
    !context.hubEnabled ||
    (typeof context.hubRoomName === "string" &&
      context.hubRoomName.length > 0);

  return Object.values(protection.entries)
    .map((entry): MarketSalePlanCandidate => {
      const price = pricing.snapshots[entry.resource];
      const protectionReasons = entry.issues.map(
        (issue) =>
          `protection:${issue.code}${
            issue.sourceKind ? `:${issue.sourceKind}` : ""
          }`,
      );
      const priceReasons =
        price?.rejections.map((rejection) => `pricing:${rejection.reason}`) ??
        ["pricing:snapshot_missing"];
      const integrationReasons: string[] = [];
      if (!resourceControlCurrent) {
        integrationReasons.push("resource_control_cycle_stale");
      }
      if (!hubStateKnown) {
        integrationReasons.push("hub_state_unknown");
      }
      if (context.pricingEvidenceFresh === false) {
        integrationReasons.push(
          context.pricingRejectionReason || "pricing_cache_stale",
        );
      }

      return {
        roomName: entry.roomName,
        resourceType: entry.resource,
        protectionEntry: entry,
        effectiveNetFloor: price?.effectiveNetFloor ?? 0,
        historyTrusted: price?.historyResult?.trusted,
        historyCompleteDayCount: price?.historyResult?.completeDayCount,
        historyAcceptedDayCount: price?.historyResult?.acceptedDayCount,
        historyFloor: price?.historyFloor,
        ratchetFloor: price?.ratchetFloor,
        makerPrice: price?.makerPrice,
        makerNetPrice: makerNetPrice(price),
        trustedPrice:
          context.pricingEvidenceFresh !== false && price?.trusted === true,
        trustedDepth:
          context.pricingEvidenceFresh !== false &&
          price?.referenceSellBook?.trusted === true,
        capacityState: resourceControlCurrent
          ? context.capacityStateByRoom[entry.roomName]
          : undefined,
        hasCriticalConflict: entry.blocked,
        isHubRoom: hubStateKnown
          ? context.hubEnabled &&
            context.hubRoomName === entry.roomName
          : undefined,
        minimumTerminalFreeCapacity:
          context.minimumTerminalFreeCapacity,
        additionalRejectionReasons: uniqueReasons([
          ...protectionReasons,
          ...priceReasons,
          ...integrationReasons,
        ]),
      };
    })
    .sort(
      (left, right) =>
        left.roomName.localeCompare(right.roomName) ||
        left.resourceType.localeCompare(right.resourceType),
    );
}

function sortedThresholdEntries(
  value: Partial<Record<ResourceConstant, number>>,
): Array<[string, number]> {
  return Object.entries(value)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right));
}

function cacheSignature(config: MarketSaleAutomationConfig): string {
  const resources = [...config.sellResources].sort();
  return JSON.stringify({
    mode: config.mode,
    configRevision: config.configRevision,
    resources,
    hardFloor: sortedThresholdEntries(config.hardFloor),
    economicFloor: sortedThresholdEntries(config.economicFloor),
    makerBatchAmount: config.makerBatchAmount,
    energyShadowPrice: config.energyShadowPrice,
    minHistoryDays: config.minHistoryDays,
    minHistoryTransactions: config.minHistoryTransactions,
    minHistoryVolume: config.minHistoryVolume,
    historyFloorRatio: config.historyFloorRatio,
    historyMaxAgeDays: config.historyMaxAgeDays,
    minReferenceOrderAmount: config.minReferenceOrderAmount,
    minReferenceOrderNotional: config.minReferenceOrderNotional,
    minReferenceOrderCount: config.minReferenceOrderCount,
    minReferenceDistinctRooms: config.minReferenceDistinctRooms,
    referenceDepthMultiplier: config.referenceDepthMultiplier,
    maxHistoryAskDeviationRatio: config.maxHistoryAskDeviationRatio,
    makerAskFloorRatio: config.makerAskFloorRatio,
    makerHistoryVolumeRatio: config.makerHistoryVolumeRatio,
  });
}

function pricingResultSignature(
  config: MarketSaleAutomationConfig,
  pricingStore: MarketSalePricingDataStore,
): string {
  const resources = [...config.sellResources].sort();
  return JSON.stringify({
    config: cacheSignature(config),
    carriedFeeDebtMilli: resources.map((resource) => [
      resource,
      pricingStore.carriedFeeDebtMilli?.[resource] ?? 0,
    ]),
  });
}

function resetPricingCaches(signature?: string): void {
  activeCacheSignature = signature;
  pricingResultCache = undefined;
  historyCache.clear();
  orderBookCache.clear();
}

function ensurePricingCacheSignature(signature: string): void {
  if (activeCacheSignature !== signature) {
    resetPricingCaches(signature);
  }
}

function cacheStillFresh(
  refreshedAt: number,
  currentTick: number,
  ttl: number,
): boolean {
  return (
    Number.isFinite(refreshedAt) &&
    refreshedAt <= currentTick &&
    currentTick - refreshedAt < ttl
  );
}

function boundedSet<T>(
  cache: Map<ResourceConstant, TimedCacheEntry<T>>,
  resource: ResourceConstant,
  entry: TimedCacheEntry<T>,
): void {
  cache.delete(resource);
  cache.set(resource, entry);
  while (cache.size > MAX_CACHED_RESOURCES) {
    const oldest = cache.keys().next().value as ResourceConstant | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function resourceFromOrderFilter(
  filter?: OrderFilter | ((order: Order) => boolean),
): ResourceConstant {
  if (
    !filter ||
    typeof filter === "function" ||
    typeof filter.resourceType !== "string"
  ) {
    throw new TypeError("market-sale order cache requires a resourceType filter");
  }
  return filter.resourceType as ResourceConstant;
}

function createCachedReadMarket(currentTick: number): MarketSalePricingReadMarket {
  return {
    orders: Game.market.orders,
    getHistory: (resource?: MarketResourceConstant): PriceHistory[] => {
      if (typeof resource !== "string") {
        throw new TypeError("market-sale history cache requires a resource");
      }
      const resourceType = resource as ResourceConstant;
      const cached = historyCache.get(resourceType);
      if (
        cached &&
        cacheStillFresh(cached.refreshedAt, currentTick, HISTORY_REFRESH_TICKS)
      ) {
        return cached.value;
      }
      const value = Game.market.getHistory(resource);
      boundedSet(historyCache, resourceType, {
        refreshedAt: currentTick,
        value,
      });
      return value;
    },
    getAllOrders: (
      filter?: OrderFilter | ((order: Order) => boolean),
    ): Order[] => {
      const resource = resourceFromOrderFilter(filter);
      const cached = orderBookCache.get(resource);
      if (
        cached &&
        cacheStillFresh(cached.refreshedAt, currentTick, ORDER_BOOK_REFRESH_TICKS)
      ) {
        return cached.value;
      }
      const value = Game.market.getAllOrders({
        resourceType: resource as MarketResourceConstant,
      });
      boundedSet(orderBookCache, resource, {
        refreshedAt: currentTick,
        value,
      });
      return value;
    },
  };
}

function collectCachedPricing(
  config: MarketSaleAutomationConfig,
  pricingStore: MarketSalePricingDataStore,
  collectPricing: CollectPricing,
): MarketSalePriceSnapshotCollection {
  ensurePricingCacheSignature(cacheSignature(config));
  const signature = pricingResultSignature(config, pricingStore);
  if (
    pricingResultCache &&
    pricingResultCache.signature === signature &&
    cacheStillFresh(
      pricingResultCache.refreshedAt,
      Game.time,
      ORDER_BOOK_REFRESH_TICKS,
    )
  ) {
    return pricingResultCache.value;
  }

  const options: CollectMarketSalePriceSnapshotsOptions = {
    market: createCachedReadMarket(Game.time),
    gameTime: Game.time,
  };
  const value = collectPricing(
    config,
    pricingStore,
    config.sellResources.map((resource) => ({
      resource,
      makerAmount: config.makerBatchAmount,
      feeDebtMilli: pricingStore.carriedFeeDebtMilli?.[resource] ?? 0,
    })),
    options,
  );
  pricingResultCache = {
    signature,
    refreshedAt: Game.time,
    value,
  };
  return value;
}

function emptyPricingCollection(): MarketSalePriceSnapshotCollection {
  return {
    observedAt: Game.time,
    asOfDate: new Date().toISOString().slice(0, 10),
    snapshots: {},
  };
}

function resetShadowQualification(reason: string): void {
  const runtime = Memory.runtime?.marketSaleAutomation as
    | (NonNullable<
        NonNullable<Memory["runtime"]>["marketSaleAutomation"]
      > & { lastShadowCycleTick?: number })
    | undefined;
  if (!runtime) return;
  runtime.shadowConsecutiveCycles = 0;
  runtime.shadowConfigRevision = undefined;
  runtime.shadowConfigSignature = undefined;
  runtime.lastShadowCycleTick = Game.time;
  runtime.rejectedByReason[reason] =
    (runtime.rejectedByReason[reason] || 0) + 1;
}

export function clearMarketSaleRuntimeCachesForTest(): void {
  resetPricingCaches();
}

function resolveCompositionContext(): MarketSaleRuntimeCompositionContext {
  const resourceControl = Memory.runtime?.resourceControl;
  const capacityStateByRoom: Record<
    string,
    "normal" | "pressure" | "emergency" | undefined
  > = {};
  for (const [roomName, state] of Object.entries(
    resourceControl?.rooms || {},
  )) {
    capacityStateByRoom[roomName] = state.capacityState;
  }
  const hub = Memory.cfg?.hub;
  return {
    currentTick: Game.time,
    resourceControlUpdatedAt: resourceControl?.updatedAt,
    capacityStateByRoom,
    hubEnabled: hub?.enabled === true,
    hubRoomName: hub?.hubRoomName,
    minimumTerminalFreeCapacity:
      resourceControl?.capacityPolicy?.receiverTerminalMinFreeCapacity ??
      DEFAULT_MINIMUM_TERMINAL_FREE_CAPACITY,
  };
}

function exposureProtectionCandidates(
  data: NonNullable<NonNullable<Memory["data"]>["marketSaleAutomation"]>,
): MarketProtectionCandidate[] {
  const candidates: MarketProtectionCandidate[] = [];
  for (const managed of Object.values(data.managedOrders || {})) {
    if (
      typeof managed.roomName === "string" &&
      managed.roomName.length > 0 &&
      typeof managed.resourceType === "string" &&
      managed.resourceType.length > 0
    ) {
      candidates.push({
        roomName: managed.roomName,
        resource: managed.resourceType,
      });
    }
  }
  const pendingTuple = data.pendingCreate?.tuple;
  if (
    typeof pendingTuple?.roomName === "string" &&
    pendingTuple.roomName.length > 0 &&
    typeof pendingTuple.resourceType === "string" &&
    pendingTuple.resourceType.length > 0
  ) {
    candidates.push({
      roomName: pendingTuple.roomName,
      resource: pendingTuple.resourceType,
    });
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.roomName}:${candidate.resource}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Production entrypoint called after ResourceControl. Expensive market reads
 * occur only on a fresh ResourceControl cycle. Existing managed/pending
 * exposure still gets a current-tick protection collection on every tick;
 * ResourceControl freshness remains a hard gate for new-order planning.
 */
export function runLiveMarketSaleAutomation(
  dependencies: MarketSaleRuntimeDependencies = {},
): MarketSaleAutomationResult {
  const collectProtection =
    dependencies.collectProtection || collectLiveMarketSaleProtectionLedger;
  const collectPricing =
    dependencies.collectPricing || collectMarketSalePriceSnapshots;
  const runAutomation = dependencies.runAutomation || runMarketSaleAutomation;
  const config = resolveMarketSaleAutomationConfig();
  const data = Memory.data?.marketSaleAutomation;
  const resourceControlCurrent =
    Memory.runtime?.resourceControl?.updatedAt === Game.time;
  const exposureCandidates = data
    ? exposureProtectionCandidates(data)
    : [];
  const hasExposureState = Boolean(
    data &&
      (Object.keys(data.managedOrders || {}).length > 0 ||
        data.pendingCreate ||
        Object.keys(data.pendingMutations || {}).length > 0),
  );

  if (
    !config.validForPlanning ||
    (config.mode !== "shadow" &&
      config.mode !== "maker" &&
      config.mode !== "hybrid") ||
    !data ||
    (!resourceControlCurrent && !hasExposureState)
  ) {
    return runAutomation();
  }

  try {
    // Production commitments stay current even while pricing is CPU-throttled.
    // This lets stale-price candidates fail closed and cancel existing exposure.
    const protection = collectProtection(
      config,
      data.managedOrders,
      resourceControlCurrent
        ? undefined
        : { candidates: exposureCandidates },
    );
    const pricingStore =
      data as unknown as MarketSalePricingDataStore;
    ensurePricingCacheSignature(cacheSignature(config));
    const bucket = Game.cpu?.bucket;
    const pricingAllowed =
      resourceControlCurrent &&
      typeof bucket === "number" &&
      Number.isFinite(bucket) &&
      bucket >= MINIMUM_PRICING_CPU_BUCKET;
    const cachedPricingFresh =
      pricingResultCache !== undefined &&
      cacheStillFresh(
        pricingResultCache.refreshedAt,
        Game.time,
        ORDER_BOOK_REFRESH_TICKS,
      );
    let pricing = cachedPricingFresh
      ? pricingResultCache!.value
      : emptyPricingCollection();
    let pricingEvidenceFresh = false;
    let pricingRejectionReason = resourceControlCurrent
      ? pricingAllowed
        ? "pricing_cache_stale"
        : "cpu_bucket_low"
      : "resource_control_cycle_stale";
    if (pricingAllowed) {
      try {
        pricing = collectCachedPricing(config, pricingStore, collectPricing);
        pricingEvidenceFresh =
          pricingResultCache !== undefined &&
          cacheStillFresh(
            pricingResultCache.refreshedAt,
            Game.time,
            ORDER_BOOK_REFRESH_TICKS,
          );
      } catch (error) {
        pricingRejectionReason = "pricing_refresh_failed";
        console.log(
          `[market-sale] pricing refresh failed closed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const candidates = composeMarketSalePlanCandidates(
      config,
      protection,
      pricing,
      {
        ...resolveCompositionContext(),
        pricingEvidenceFresh,
        pricingRejectionReason,
      },
    );
    const result = runAutomation({
      candidates,
      stagingAmount: 0,
      reservationAmount: 0,
    });
    if (resourceControlCurrent && !pricingEvidenceFresh) {
      resetShadowQualification(pricingRejectionReason);
      result.rejectedByReason[pricingRejectionReason] =
        (result.rejectedByReason[pricingRejectionReason] || 0) + 1;
    }
    return result;
  } catch (error) {
    console.log(
      `[market-sale] live adapter failed closed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    resetShadowQualification("live_adapter_failed");
    return runAutomation();
  }
}
