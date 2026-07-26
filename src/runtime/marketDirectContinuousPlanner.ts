import {
  priceToMilliDown,
  priceToMilliUp,
  type MarketOrderSnapshot,
  type MilliCredits,
} from "@/runtime/marketSalePricing";

export const MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT = 1_000;

export type MarketDirectContinuousGrant = "canary" | "continuous";

export interface MarketDirectContinuousPolicy {
  entryId: string;
  revision: string;
  resourceType: string;
  allowedRooms: readonly string[];
  requireNativeMineral: boolean;
  grant: MarketDirectContinuousGrant;
  hardNetFloor: number;
  economicNetFloor: number;
  historyNetFloor?: number;
  ratchetNetFloor?: number;
  minExecutableNotional: number;
  maxRawOrders: number;
  maxEligibleOrders: number;
  maxTransactionEnergy: number;
  terminalEnergyReserve: number;
  resourceRollingCap: number;
  opportunityReserve: number;
}

export interface MarketDirectContinuousLane {
  roomName: string;
  resourceType: string;
  owned: boolean;
  hub: boolean;
  capacityEmergency: boolean;
  nativeMineralType?: string;
}

export interface MarketDirectContinuousProtection {
  complete: boolean;
  revision: string;
  sellableAmount: number;
}

export interface MarketDirectContinuousTerminal {
  revision: string;
  normal: boolean;
  claimed: boolean;
  cooldown: number;
  resourceAmount: number;
  energy: number;
}

export interface MarketDirectContinuousBook {
  complete: boolean;
  revision: string;
  orders: readonly MarketOrderSnapshot[];
  ownOrderIds: readonly string[];
}

export interface MarketDirectContinuousResourceQuota {
  complete: boolean;
  revision: string;
  resourceType: string;
  rollingCap: number;
  confirmedAmount: number;
  unmatchedPlannedAmount: number;
  opportunityReserveSatisfied: boolean;
}

export interface MarketDirectContinuousLaneInput {
  lane: MarketDirectContinuousLane;
  protection: MarketDirectContinuousProtection;
  terminal: MarketDirectContinuousTerminal;
  book: MarketDirectContinuousBook;
  calculateTransactionEnergy: (
    amount: number,
    order: MarketOrderSnapshot,
    sellerRoomName: string,
  ) => number;
}

export interface MarketDirectContinuousEntryInput {
  policy: MarketDirectContinuousPolicy;
  quota: MarketDirectContinuousResourceQuota;
  lanes: readonly MarketDirectContinuousLaneInput[];
}

export interface MarketDirectContinuousEnergyShadow {
  complete: boolean;
  revision: string;
  price: number;
}

export interface MarketDirectContinuousGlobalQuota {
  complete: boolean;
  revision: string;
  rollingCap: number;
  confirmedAmount: number;
  unmatchedPlannedAmount: number;
}

/**
 * 这些值不参与价格计算，但属于写前必须保持不变的账户级事实。
 * 调用方可把仲裁器的完整状态编码进 revision。
 */
export interface MarketDirectContinuousWriteContext {
  complete: boolean;
  revision: string;
  credits: number;
  executorShard: string;
  permitEpoch: number;
  permitId: string;
  permitHead: string;
  pendingState: "none" | "active" | "gap" | "quarantine";
  arbiterState: "available" | "claimed" | "blocked";
}

export interface PlanMarketDirectContinuousInput {
  entries: readonly MarketDirectContinuousEntryInput[];
  energyShadow: MarketDirectContinuousEnergyShadow;
  globalQuota: MarketDirectContinuousGlobalQuota;
  writeContext: MarketDirectContinuousWriteContext;
}

export type MarketDirectContinuousBlockerReason =
  | "invalid_input"
  | "write_context_incomplete"
  | "write_context_blocked"
  | "energy_shadow_incomplete"
  | "global_quota_incomplete"
  | "entry_scope_invalid"
  | "lane_scope_invalid"
  | "protection_incomplete"
  | "book_incomplete"
  | "raw_book_limit_exceeded"
  | "eligible_book_limit_exceeded"
  | "duplicate_order_id"
  | "energy_pricing_failed"
  | "unsafe_arithmetic";

export interface MarketDirectContinuousBlocker {
  reason: MarketDirectContinuousBlockerReason;
  entryId?: string;
  roomName?: string;
  orderId?: string;
  detail?: string;
}

export type MarketDirectContinuousTupleRejectionReason =
  | "side_mismatch"
  | "resource_mismatch"
  | "missing_order_room"
  | "self_order"
  | "invalid_order"
  | "order_amount_below_plan"
  | "executable_notional_below_minimum"
  | "transaction_energy_exceeded"
  | "terminal_energy_reserve"
  | "planned_net_below_floor"
  | "worst_case_net_below_floor"
  | "resource_quota_exhausted"
  | "global_quota_or_opportunity_reserve";

export interface MarketDirectContinuousTupleRejection {
  entryId: string;
  resourceType: string;
  roomName: string;
  orderId?: string;
  reason: MarketDirectContinuousTupleRejectionReason;
}

export interface MarketDirectContinuousCandidate {
  entryId: string;
  policyRevision: string;
  resourceType: string;
  roomName: string;
  order: MarketOrderSnapshot;
  plannedAmount: typeof MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT;
  grossPriceMilli: MilliCredits;
  executableNotionalMilli: MilliCredits;
  transactionEnergy: number;
  energyShadowPriceMilli: MilliCredits;
  energyShadowCostMilli: MilliCredits;
  netCreditsMilli: MilliCredits;
  effectiveNetFloorMilli: MilliCredits;
  requiredNetCreditsMilli: MilliCredits;
  worstCaseActualAmount: 1;
  worstCaseTransactionEnergy: number;
  worstCaseNetCreditsMilli: MilliCredits;
  resourceQuotaBefore: number;
  globalQuotaBefore: number;
  reservedForOtherSafeResources: number;
  tupleKey: string;
}

export interface MarketDirectContinuousPlanningResult {
  complete: boolean;
  blocker?: MarketDirectContinuousBlocker;
  /**
   * 通过价格、保护和能量门禁，但尚未经过 resource/global quota admission。
   */
  safeCandidates: MarketDirectContinuousCandidate[];
  /**
   * 同时通过 resource quota、global quota 和其它安全资源机会保留的候选。
   */
  admittedCandidates: MarketDirectContinuousCandidate[];
  selected?: MarketDirectContinuousCandidate;
  rejections: MarketDirectContinuousTupleRejection[];
  planningFingerprint: string;
  /**
   * 精确规范化证据。fingerprint 用于日志；二次读比较同时检查本字段，避免短哈希碰撞。
   */
  planningEvidence: string;
}

interface EligibleOrder {
  order: MarketOrderSnapshot;
  remainingAmount: number;
  grossPriceMilli: MilliCredits;
  executableNotionalMilli: MilliCredits;
}

interface PreparedLane {
  entry: MarketDirectContinuousEntryInput;
  laneInput: MarketDirectContinuousLaneInput;
  effectiveNetFloorMilli: MilliCredits;
  minExecutableNotionalMilli: MilliCredits;
  eligibleOrders: EligibleOrder[];
}

interface EnergyObservation {
  entryId: string;
  roomName: string;
  orderId: string;
  planned: number;
  worst: number;
}

function stableStringCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function checkedAdd(left: number, right: number): number | undefined {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function checkedMultiply(left: number, right: number): number | undefined {
  const result = left * right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function checkedSubtract(left: number, right: number): number | undefined {
  const result = left - right;
  return Number.isSafeInteger(result) ? result : undefined;
}

function remainingOrderAmount(order: MarketOrderSnapshot): number {
  if (order.remainingAmount === undefined) return order.amount;
  if (!Number.isSafeInteger(order.remainingAmount)) return Number.NaN;
  return Math.min(order.amount, order.remainingAmount);
}

function effectiveFloor(policy: MarketDirectContinuousPolicy): number | undefined {
  const values = [
    policy.hardNetFloor,
    policy.economicNetFloor,
    policy.historyNetFloor,
    policy.ratchetNetFloor,
  ].filter((value): value is number => value !== undefined);
  if (values.length < 2 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return undefined;
  }
  return Math.max(...values);
}

function policyIsValid(policy: MarketDirectContinuousPolicy): boolean {
  const floor = effectiveFloor(policy);
  return (
    typeof policy.entryId === "string" &&
    policy.entryId.length > 0 &&
    typeof policy.revision === "string" &&
    policy.revision.length > 0 &&
    typeof policy.resourceType === "string" &&
    policy.resourceType.length > 0 &&
    (policy.grant === "canary" || policy.grant === "continuous") &&
    Array.isArray(policy.allowedRooms) &&
    policy.allowedRooms.length > 0 &&
    new Set(policy.allowedRooms).size === policy.allowedRooms.length &&
    policy.allowedRooms.every((roomName) =>
      typeof roomName === "string" && roomName.length > 0) &&
    floor !== undefined &&
    Number.isFinite(policy.minExecutableNotional) &&
    policy.minExecutableNotional > 0 &&
    isPositiveSafeInteger(policy.maxRawOrders) &&
    isPositiveSafeInteger(policy.maxEligibleOrders) &&
    policy.maxEligibleOrders <= policy.maxRawOrders &&
    isNonNegativeSafeInteger(policy.maxTransactionEnergy) &&
    isNonNegativeSafeInteger(policy.terminalEnergyReserve) &&
    isPositiveSafeInteger(policy.resourceRollingCap) &&
    isPositiveSafeInteger(policy.opportunityReserve) &&
    policy.opportunityReserve === MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT
  );
}

function quotaIsValid(
  quota: MarketDirectContinuousResourceQuota,
  policy: MarketDirectContinuousPolicy,
): boolean {
  return (
    quota.complete &&
    typeof quota.revision === "string" &&
    quota.revision.length > 0 &&
    quota.resourceType === policy.resourceType &&
    quota.rollingCap === policy.resourceRollingCap &&
    isPositiveSafeInteger(quota.rollingCap) &&
    isNonNegativeSafeInteger(quota.confirmedAmount) &&
    isNonNegativeSafeInteger(quota.unmatchedPlannedAmount)
  );
}

function globalQuotaIsValid(quota: MarketDirectContinuousGlobalQuota): boolean {
  return (
    quota.complete &&
    typeof quota.revision === "string" &&
    quota.revision.length > 0 &&
    isPositiveSafeInteger(quota.rollingCap) &&
    isNonNegativeSafeInteger(quota.confirmedAmount) &&
    isNonNegativeSafeInteger(quota.unmatchedPlannedAmount)
  );
}

function normalizeOrder(order: MarketOrderSnapshot): Record<string, unknown> {
  return {
    amount: order.amount,
    created: order.created ?? null,
    id: order.id,
    price: order.price,
    remainingAmount: order.remainingAmount ?? null,
    resourceType: order.resourceType,
    roomName: order.roomName ?? null,
    totalAmount: order.totalAmount ?? null,
    type: order.type,
  };
}

function normalizeInput(input: PlanMarketDirectContinuousInput): Record<string, unknown> {
  return {
    energyShadow: { ...input.energyShadow },
    entries: [...input.entries]
      .sort((left, right) =>
        stableStringCompare(left.policy.entryId, right.policy.entryId))
      .map((entry) => ({
        policy: {
          ...entry.policy,
          allowedRooms: [...entry.policy.allowedRooms].sort(stableStringCompare),
        },
        quota: { ...entry.quota },
        lanes: [...entry.lanes]
          .sort((left, right) =>
            stableStringCompare(left.lane.roomName, right.lane.roomName))
          .map((laneInput) => ({
            lane: { ...laneInput.lane },
            protection: { ...laneInput.protection },
            terminal: { ...laneInput.terminal },
            book: {
              complete: laneInput.book.complete,
              revision: laneInput.book.revision,
              ownOrderIds: [...laneInput.book.ownOrderIds].sort(stableStringCompare),
              orders: [...laneInput.book.orders]
                .sort((left, right) => stableStringCompare(left.id, right.id))
                .map(normalizeOrder),
            },
          })),
      })),
    globalQuota: { ...input.globalQuota },
    writeContext: { ...input.writeContext },
  };
}

function stableCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return JSON.stringify("<NaN>");
    if (value === Number.POSITIVE_INFINITY) return JSON.stringify("<Infinity>");
    if (value === Number.NEGATIVE_INFINITY) return JSON.stringify("<-Infinity>");
    if (Object.is(value, -0)) return "0";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableCanonical).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort(stableStringCompare)
      .map((key) => `${JSON.stringify(key)}:${stableCanonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(`<${typeof value}>`);
}

function shortFingerprint(evidence: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < evidence.length; index += 1) {
    hash ^= evidence.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `market-direct-continuous:plan:v1:${(hash >>> 0)
    .toString(16)
    .padStart(8, "0")}:${evidence.length}`;
}

function candidateTupleKey(candidate: Pick<
  MarketDirectContinuousCandidate,
  "resourceType" | "roomName" | "order" | "plannedAmount"
>): string {
  return [
    candidate.resourceType,
    candidate.roomName,
    candidate.order.id,
    candidate.order.price,
    remainingOrderAmount(candidate.order),
    candidate.plannedAmount,
  ].join("|");
}

/**
 * 价格优先级只使用：单位净价、总净额、gross、resource/room/orderId。
 * 订单量、库存、容量压力和配置顺序均不参与比较。
 */
export function compareMarketDirectContinuousCandidates(
  left: MarketDirectContinuousCandidate,
  right: MarketDirectContinuousCandidate,
): number {
  const leftUnitCross = checkedMultiply(left.netCreditsMilli, right.plannedAmount);
  const rightUnitCross = checkedMultiply(right.netCreditsMilli, left.plannedAmount);
  if (leftUnitCross === undefined || rightUnitCross === undefined) {
    throw new RangeError("unit-net comparison exceeds safe integer precision");
  }
  if (leftUnitCross !== rightUnitCross) {
    return leftUnitCross > rightUnitCross ? -1 : 1;
  }
  if (left.netCreditsMilli !== right.netCreditsMilli) {
    return left.netCreditsMilli > right.netCreditsMilli ? -1 : 1;
  }
  if (left.grossPriceMilli !== right.grossPriceMilli) {
    return left.grossPriceMilli > right.grossPriceMilli ? -1 : 1;
  }
  const resourceComparison = stableStringCompare(left.resourceType, right.resourceType);
  if (resourceComparison !== 0) return resourceComparison;
  const roomComparison = stableStringCompare(left.roomName, right.roomName);
  if (roomComparison !== 0) return roomComparison;
  return stableStringCompare(left.order.id, right.order.id);
}

function finishResult(
  input: PlanMarketDirectContinuousInput,
  partial: Omit<
    MarketDirectContinuousPlanningResult,
    "planningFingerprint" | "planningEvidence"
  >,
  energyObservations: readonly EnergyObservation[] = [],
): MarketDirectContinuousPlanningResult {
  const evidence = stableCanonical({
    input: normalizeInput(input),
    observation: {
      blocker: partial.blocker ?? null,
      energy: [...energyObservations].sort((left, right) =>
        stableStringCompare(
          `${left.entryId}|${left.roomName}|${left.orderId}`,
          `${right.entryId}|${right.roomName}|${right.orderId}`,
        )),
      rejections: [...partial.rejections].sort((left, right) =>
        stableStringCompare(
          `${left.entryId}|${left.roomName}|${left.orderId ?? ""}|${left.reason}`,
          `${right.entryId}|${right.roomName}|${right.orderId ?? ""}|${right.reason}`,
        )),
      safeTupleKeys: partial.safeCandidates.map((candidate) => candidate.tupleKey),
      admittedTupleKeys: partial.admittedCandidates.map((candidate) =>
        candidate.tupleKey),
      selectedTupleKey: partial.selected?.tupleKey ?? null,
    },
  });
  return {
    ...partial,
    planningFingerprint: shortFingerprint(evidence),
    planningEvidence: evidence,
  };
}

function blockedResult(
  input: PlanMarketDirectContinuousInput,
  blocker: MarketDirectContinuousBlocker,
  rejections: MarketDirectContinuousTupleRejection[] = [],
  energyObservations: readonly EnergyObservation[] = [],
): MarketDirectContinuousPlanningResult {
  return finishResult(input, {
    complete: false,
    blocker,
    safeCandidates: [],
    admittedCandidates: [],
    rejections,
  }, energyObservations);
}

/**
 * 对所有 permit 参与 entry/lane 的完整 BUY book 做一次纯函数规划。
 * 本模块不拥有、也不调用真实市场写入口。
 */
export function planMarketDirectContinuous(
  input: PlanMarketDirectContinuousInput,
): MarketDirectContinuousPlanningResult {
  if (
    !input ||
    !Array.isArray(input.entries) ||
    input.entries.length === 0
  ) {
    return blockedResult(input, { reason: "invalid_input" });
  }
  if (
    !input.writeContext?.complete ||
    typeof input.writeContext.revision !== "string" ||
    input.writeContext.revision.length === 0 ||
    !Number.isFinite(input.writeContext.credits) ||
    input.writeContext.credits < 0 ||
    !isPositiveSafeInteger(input.writeContext.permitEpoch) ||
    typeof input.writeContext.permitId !== "string" ||
    input.writeContext.permitId.length === 0 ||
    typeof input.writeContext.permitHead !== "string" ||
    input.writeContext.permitHead.length === 0 ||
    input.writeContext.executorShard !== "shard1"
  ) {
    return blockedResult(input, { reason: "write_context_incomplete" });
  }
  if (
    input.writeContext.pendingState !== "none" ||
    input.writeContext.arbiterState !== "available"
  ) {
    return blockedResult(input, { reason: "write_context_blocked" });
  }
  if (
    !input.energyShadow?.complete ||
    typeof input.energyShadow.revision !== "string" ||
    input.energyShadow.revision.length === 0 ||
    !Number.isFinite(input.energyShadow.price) ||
    input.energyShadow.price < 0
  ) {
    return blockedResult(input, { reason: "energy_shadow_incomplete" });
  }
  if (!globalQuotaIsValid(input.globalQuota)) {
    return blockedResult(input, { reason: "global_quota_incomplete" });
  }

  let energyShadowPriceMilli: MilliCredits;
  try {
    energyShadowPriceMilli = input.energyShadow.price === 0
      ? 0
      : priceToMilliUp(input.energyShadow.price);
  } catch (error) {
    return blockedResult(input, {
      reason: "unsafe_arithmetic",
      detail: error instanceof Error ? error.message : "energy shadow conversion failed",
    });
  }

  const entryIds = new Set<string>();
  const resourceTypes = new Set<string>();
  const laneKeys = new Set<string>();
  const preparedLanes: PreparedLane[] = [];
  const rejections: MarketDirectContinuousTupleRejection[] = [];

  // 第一阶段只验证 scope、完整 book 和 scan budget；在所有 book 证明完整前不做能量定价。
  for (const entry of input.entries) {
    const { policy, quota } = entry;
    if (
      !policyIsValid(policy) ||
      entryIds.has(policy.entryId) ||
      resourceTypes.has(policy.resourceType) ||
      !quotaIsValid(quota, policy) ||
      !Array.isArray(entry.lanes) ||
      entry.lanes.length !== policy.allowedRooms.length ||
      new Set(entry.lanes.map((laneInput) => laneInput.lane.roomName)).size !==
        policy.allowedRooms.length ||
      policy.allowedRooms.some((roomName) =>
        !entry.lanes.some((laneInput) => laneInput.lane.roomName === roomName))
    ) {
      return blockedResult(input, {
        reason: "entry_scope_invalid",
        entryId: policy?.entryId,
      });
    }
    entryIds.add(policy.entryId);
    resourceTypes.add(policy.resourceType);

    let effectiveNetFloorMilli: MilliCredits;
    let minExecutableNotionalMilli: MilliCredits;
    try {
      effectiveNetFloorMilli = priceToMilliUp(effectiveFloor(policy)!);
      minExecutableNotionalMilli = priceToMilliUp(policy.minExecutableNotional);
    } catch (error) {
      return blockedResult(input, {
        reason: "unsafe_arithmetic",
        entryId: policy.entryId,
        detail: error instanceof Error ? error.message : "policy conversion failed",
      });
    }

    for (const laneInput of entry.lanes) {
      const { lane, protection, terminal, book } = laneInput;
      const laneKey = `${policy.resourceType}|${lane.roomName}`;
      if (
        laneKeys.has(laneKey) ||
        lane.resourceType !== policy.resourceType ||
        !policy.allowedRooms.includes(lane.roomName) ||
        !lane.owned ||
        lane.hub ||
        lane.capacityEmergency ||
        (policy.requireNativeMineral &&
          lane.nativeMineralType !== policy.resourceType) ||
        typeof laneInput.calculateTransactionEnergy !== "function" ||
        !terminal.normal ||
        terminal.claimed ||
        !isNonNegativeSafeInteger(terminal.cooldown) ||
        terminal.cooldown !== 0 ||
        !isNonNegativeSafeInteger(terminal.resourceAmount) ||
        !isNonNegativeSafeInteger(terminal.energy) ||
        typeof terminal.revision !== "string" ||
        terminal.revision.length === 0
      ) {
        return blockedResult(input, {
          reason: "lane_scope_invalid",
          entryId: policy.entryId,
          roomName: lane?.roomName,
        });
      }
      laneKeys.add(laneKey);
      if (
        !protection.complete ||
        typeof protection.revision !== "string" ||
        protection.revision.length === 0 ||
        !isNonNegativeSafeInteger(protection.sellableAmount)
      ) {
        return blockedResult(input, {
          reason: "protection_incomplete",
          entryId: policy.entryId,
          roomName: lane.roomName,
        });
      }
      if (
        !book.complete ||
        typeof book.revision !== "string" ||
        book.revision.length === 0 ||
        !Array.isArray(book.orders) ||
        !Array.isArray(book.ownOrderIds)
      ) {
        return blockedResult(input, {
          reason: "book_incomplete",
          entryId: policy.entryId,
          roomName: lane.roomName,
        });
      }
      if (book.orders.length > policy.maxRawOrders) {
        return blockedResult(input, {
          reason: "raw_book_limit_exceeded",
          entryId: policy.entryId,
          roomName: lane.roomName,
          detail: `${book.orders.length}>${policy.maxRawOrders}`,
        });
      }

      const seenOrderIds = new Set<string>();
      const ownOrderIds = new Set(book.ownOrderIds);
      const eligibleOrders: EligibleOrder[] = [];
      for (const order of book.orders) {
        const orderId = typeof order?.id === "string" && order.id.length > 0
          ? order.id
          : undefined;
        if (!orderId) {
          rejections.push({
            entryId: policy.entryId,
            resourceType: policy.resourceType,
            roomName: lane.roomName,
            reason: "invalid_order",
          });
          continue;
        }
        if (seenOrderIds.has(orderId)) {
          return blockedResult(input, {
            reason: "duplicate_order_id",
            entryId: policy.entryId,
            roomName: lane.roomName,
            orderId,
          }, rejections);
        }
        seenOrderIds.add(orderId);

        let rejectionReason: MarketDirectContinuousTupleRejectionReason | undefined;
        if (order.type !== "buy") {
          rejectionReason = "side_mismatch";
        } else if (order.resourceType !== policy.resourceType) {
          rejectionReason = "resource_mismatch";
        } else if (typeof order.roomName !== "string" || order.roomName.length === 0) {
          rejectionReason = "missing_order_room";
        } else if (ownOrderIds.has(orderId)) {
          rejectionReason = "self_order";
        } else if (
          !Number.isFinite(order.price) ||
          order.price <= 0 ||
          !isPositiveSafeInteger(order.amount) ||
          (order.remainingAmount !== undefined &&
            !isPositiveSafeInteger(order.remainingAmount))
        ) {
          rejectionReason = "invalid_order";
        }
        const remainingAmount = rejectionReason
          ? Number.NaN
          : remainingOrderAmount(order);
        if (!rejectionReason && remainingAmount < MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT) {
          rejectionReason = "order_amount_below_plan";
        }
        if (rejectionReason) {
          rejections.push({
            entryId: policy.entryId,
            resourceType: policy.resourceType,
            roomName: lane.roomName,
            orderId,
            reason: rejectionReason,
          });
          continue;
        }

        let grossPriceMilli: MilliCredits;
        try {
          grossPriceMilli = priceToMilliDown(order.price);
        } catch (error) {
          return blockedResult(input, {
            reason: "unsafe_arithmetic",
            entryId: policy.entryId,
            roomName: lane.roomName,
            orderId,
            detail: error instanceof Error ? error.message : "order price conversion failed",
          }, rejections);
        }
        const executableNotionalMilli = checkedMultiply(
          grossPriceMilli,
          MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
        );
        if (executableNotionalMilli === undefined) {
          return blockedResult(input, {
            reason: "unsafe_arithmetic",
            entryId: policy.entryId,
            roomName: lane.roomName,
            orderId,
            detail: "executable notional overflow",
          }, rejections);
        }
        if (executableNotionalMilli < minExecutableNotionalMilli) {
          rejections.push({
            entryId: policy.entryId,
            resourceType: policy.resourceType,
            roomName: lane.roomName,
            orderId,
            reason: "executable_notional_below_minimum",
          });
          continue;
        }
        eligibleOrders.push({
          order,
          remainingAmount,
          grossPriceMilli,
          executableNotionalMilli,
        });
      }
      if (eligibleOrders.length > policy.maxEligibleOrders) {
        return blockedResult(input, {
          reason: "eligible_book_limit_exceeded",
          entryId: policy.entryId,
          roomName: lane.roomName,
          detail: `${eligibleOrders.length}>${policy.maxEligibleOrders}`,
        }, rejections);
      }
      preparedLanes.push({
        entry,
        laneInput,
        effectiveNetFloorMilli,
        minExecutableNotionalMilli,
        eligibleOrders,
      });
    }
  }

  const safeCandidates: MarketDirectContinuousCandidate[] = [];
  const energyObservations: EnergyObservation[] = [];
  for (const prepared of preparedLanes) {
    const { entry, laneInput, effectiveNetFloorMilli } = prepared;
    const { policy, quota } = entry;
    const { lane, protection, terminal } = laneInput;
    if (
      protection.sellableAmount < MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT ||
      terminal.resourceAmount < MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT
    ) {
      continue;
    }

    for (const eligible of prepared.eligibleOrders) {
      let transactionEnergy: number;
      let worstCaseTransactionEnergy: number;
      try {
        transactionEnergy = laneInput.calculateTransactionEnergy(
          MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
          eligible.order,
          lane.roomName,
        );
        worstCaseTransactionEnergy = laneInput.calculateTransactionEnergy(
          1,
          eligible.order,
          lane.roomName,
        );
      } catch (error) {
        return blockedResult(input, {
          reason: "energy_pricing_failed",
          entryId: policy.entryId,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          detail: error instanceof Error ? error.message : "energy pricing threw",
        }, rejections, energyObservations);
      }
      if (
        !isNonNegativeSafeInteger(transactionEnergy) ||
        !isNonNegativeSafeInteger(worstCaseTransactionEnergy)
      ) {
        return blockedResult(input, {
          reason: "energy_pricing_failed",
          entryId: policy.entryId,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          detail: "transaction energy must be a non-negative safe integer",
        }, rejections, energyObservations);
      }
      energyObservations.push({
        entryId: policy.entryId,
        roomName: lane.roomName,
        orderId: eligible.order.id,
        planned: transactionEnergy,
        worst: worstCaseTransactionEnergy,
      });

      let rejectionReason: MarketDirectContinuousTupleRejectionReason | undefined;
      if (transactionEnergy > policy.maxTransactionEnergy) {
        rejectionReason = "transaction_energy_exceeded";
      } else if (
        terminal.energy < transactionEnergy ||
        terminal.energy - transactionEnergy < policy.terminalEnergyReserve
      ) {
        rejectionReason = "terminal_energy_reserve";
      }

      const energyShadowCostMilli = checkedMultiply(
        transactionEnergy,
        energyShadowPriceMilli,
      );
      const worstCaseEnergyCostMilli = checkedMultiply(
        worstCaseTransactionEnergy,
        energyShadowPriceMilli,
      );
      const requiredNetCreditsMilli = checkedMultiply(
        effectiveNetFloorMilli,
        MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
      );
      if (
        energyShadowCostMilli === undefined ||
        worstCaseEnergyCostMilli === undefined ||
        requiredNetCreditsMilli === undefined
      ) {
        return blockedResult(input, {
          reason: "unsafe_arithmetic",
          entryId: policy.entryId,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          detail: "energy/floor multiplication overflow",
        }, rejections, energyObservations);
      }
      const netCreditsMilli = checkedSubtract(
        eligible.executableNotionalMilli,
        energyShadowCostMilli,
      );
      const worstCaseNetCreditsMilli = checkedSubtract(
        eligible.grossPriceMilli,
        worstCaseEnergyCostMilli,
      );
      if (
        netCreditsMilli === undefined ||
        worstCaseNetCreditsMilli === undefined
      ) {
        return blockedResult(input, {
          reason: "unsafe_arithmetic",
          entryId: policy.entryId,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          detail: "net credits subtraction overflow",
        }, rejections, energyObservations);
      }
      if (!rejectionReason && netCreditsMilli < requiredNetCreditsMilli) {
        rejectionReason = "planned_net_below_floor";
      }
      if (!rejectionReason && worstCaseNetCreditsMilli < effectiveNetFloorMilli) {
        rejectionReason = "worst_case_net_below_floor";
      }
      if (rejectionReason) {
        rejections.push({
          entryId: policy.entryId,
          resourceType: policy.resourceType,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          reason: rejectionReason,
        });
        continue;
      }

      const resourceQuotaBefore = checkedAdd(
        quota.confirmedAmount,
        quota.unmatchedPlannedAmount,
      );
      const globalQuotaBefore = checkedAdd(
        input.globalQuota.confirmedAmount,
        input.globalQuota.unmatchedPlannedAmount,
      );
      if (resourceQuotaBefore === undefined || globalQuotaBefore === undefined) {
        return blockedResult(input, {
          reason: "unsafe_arithmetic",
          entryId: policy.entryId,
          roomName: lane.roomName,
          orderId: eligible.order.id,
          detail: "quota addition overflow",
        }, rejections, energyObservations);
      }
      const candidate: MarketDirectContinuousCandidate = {
        entryId: policy.entryId,
        policyRevision: policy.revision,
        resourceType: policy.resourceType,
        roomName: lane.roomName,
        order: eligible.order,
        plannedAmount: MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
        grossPriceMilli: eligible.grossPriceMilli,
        executableNotionalMilli: eligible.executableNotionalMilli,
        transactionEnergy,
        energyShadowPriceMilli,
        energyShadowCostMilli,
        netCreditsMilli,
        effectiveNetFloorMilli,
        requiredNetCreditsMilli,
        worstCaseActualAmount: 1,
        worstCaseTransactionEnergy,
        worstCaseNetCreditsMilli,
        resourceQuotaBefore,
        globalQuotaBefore,
        reservedForOtherSafeResources: 0,
        tupleKey: "",
      };
      candidate.tupleKey = candidateTupleKey(candidate);
      safeCandidates.push(candidate);
    }
  }
  safeCandidates.sort(compareMarketDirectContinuousCandidates);

  const safeResourceTypes = new Set(
    safeCandidates
      .filter((candidate) => {
        const entry = input.entries.find((item) =>
          item.policy.entryId === candidate.entryId)!;
        return candidate.resourceQuotaBefore +
          MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT <= entry.quota.rollingCap;
      })
      .map((candidate) => candidate.resourceType),
  );
  const quotaByResource = new Map(
    input.entries.map((entry) => [entry.policy.resourceType, entry] as const),
  );

  const admittedCandidates: MarketDirectContinuousCandidate[] = [];
  for (const candidate of safeCandidates) {
    const entry = quotaByResource.get(candidate.resourceType)!;
    if (
      candidate.resourceQuotaBefore +
        MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT >
      entry.quota.rollingCap
    ) {
      rejections.push({
        entryId: candidate.entryId,
        resourceType: candidate.resourceType,
        roomName: candidate.roomName,
        orderId: candidate.order.id,
        reason: "resource_quota_exhausted",
      });
      continue;
    }

    let reservedForOtherSafeResources = 0;
    for (const resourceType of safeResourceTypes) {
      if (resourceType === candidate.resourceType) continue;
      const other = quotaByResource.get(resourceType)!;
      if (!other.quota.opportunityReserveSatisfied) {
        const nextReserve = checkedAdd(
          reservedForOtherSafeResources,
          other.policy.opportunityReserve,
        );
        if (nextReserve === undefined) {
          return blockedResult(input, {
            reason: "unsafe_arithmetic",
            entryId: candidate.entryId,
            detail: "opportunity reserve overflow",
          }, rejections, energyObservations);
        }
        reservedForOtherSafeResources = nextReserve;
      }
    }
    const afterPlan = checkedAdd(
      candidate.globalQuotaBefore,
      MARKET_DIRECT_CONTINUOUS_PLANNED_AMOUNT,
    );
    const afterReserves = afterPlan === undefined
      ? undefined
      : checkedAdd(afterPlan, reservedForOtherSafeResources);
    if (
      afterReserves === undefined ||
      afterReserves > input.globalQuota.rollingCap
    ) {
      rejections.push({
        entryId: candidate.entryId,
        resourceType: candidate.resourceType,
        roomName: candidate.roomName,
        orderId: candidate.order.id,
        reason: "global_quota_or_opportunity_reserve",
      });
      continue;
    }
    admittedCandidates.push({
      ...candidate,
      reservedForOtherSafeResources,
    });
  }
  admittedCandidates.sort(compareMarketDirectContinuousCandidates);

  return finishResult(input, {
    complete: true,
    safeCandidates,
    admittedCandidates,
    selected: admittedCandidates[0],
    rejections,
  }, energyObservations);
}

/**
 * 写前第二次完整规划必须和第一次逐字段一致，且仍选择完全相同的最佳 tuple。
 * 任一输入、book/order remaining、定价、保护、terminal、quota、permit 或仲裁字段变化均 false。
 */
export function isExactMarketDirectContinuousSecondRead(
  planned: MarketDirectContinuousPlanningResult,
  secondRead: MarketDirectContinuousPlanningResult,
): boolean {
  return (
    planned.complete &&
    secondRead.complete &&
    planned.blocker === undefined &&
    secondRead.blocker === undefined &&
    planned.selected !== undefined &&
    secondRead.selected !== undefined &&
    planned.selected.tupleKey === secondRead.selected.tupleKey &&
    planned.planningFingerprint === secondRead.planningFingerprint &&
    planned.planningEvidence === secondRead.planningEvidence
  );
}
