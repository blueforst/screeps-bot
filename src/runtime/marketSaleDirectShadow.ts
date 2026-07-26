import { MARKET_DIRECT_CANARY_POLICY } from "@/runtime/marketSaleConfig";

export type DirectLifecycleMode =
  | "off"
  | "shadow"
  | "maker"
  | "direct"
  | "hybrid"
  | "emergencyStop";

export interface DirectStructuralCandidate {
  roomName: string;
  resourceType: ResourceConstant;
  protectionRevision: number;
  observedAt: number;
  expiresAt: number;
  sellableAmount: number;
  terminalStock: number;
  terminalCooldown?: number;
  terminalEnergy?: number;
  capacityState?: "normal" | "pressure" | "emergency";
  isHubRoom?: boolean;
  rejectionReasons: string[];
}

export interface DirectCanaryLock {
  roomName: string;
  resourceType: ResourceConstant;
  lockedAt: number;
  configRevision: string;
  safetyFingerprint: string;
}

type DirectLifecycleKey =
  | "direct_shadow"
  | "direct"
  | "other";

export interface DirectShadowQualification {
  configRevision?: string;
  safetyFingerprint?: string;
  canary?: DirectCanaryLock;
  consecutiveCycles: number;
  lastCycleTick?: number;
  qualifiedAt?: number;
  lastLifecycleKey?: DirectLifecycleKey;
  lastLifecycleTick?: number;
  activationAuthorized: boolean;
}

export interface DirectPlanningSnapshot<TOpportunity = unknown> {
  observedAt: number;
  configRevision: string;
  safetyFingerprint: string;
  canary?: DirectCanaryLock;
  result:
    | "safe_opportunity"
    | "safe_no_opportunity"
    | "production_priority_wait"
    | "incomplete";
  rejectedByReason: Record<string, number>;
  opportunity?: TOpportunity;
}

export interface DirectPlanningSnapshotStatus<TOpportunity = unknown> {
  snapshot?: DirectPlanningSnapshot<TOpportunity>;
  age?: number;
  maxAgeTicks: number;
  fresh: boolean;
}

export const REQUIRED_DIRECT_SHADOW_CYCLES = 100;
export const DIRECT_PLANNING_SNAPSHOT_MAX_AGE_TICKS = 10;

export function createDirectShadowQualification(): DirectShadowQualification {
  return {
    consecutiveCycles: 0,
    activationAuthorized: false,
  };
}

function lifecycleKey(
  mode: DirectLifecycleMode,
  shadowStrategy: "maker" | "direct",
): DirectLifecycleKey {
  if (mode === "shadow" && shadowStrategy === "direct") {
    return "direct_shadow";
  }
  if (mode === "direct") return "direct";
  return "other";
}

function samePolicy(
  qualification: DirectShadowQualification,
  configRevision: string | undefined,
  safetyFingerprint: string | undefined,
): boolean {
  return Boolean(
    configRevision &&
      safetyFingerprint &&
      qualification.configRevision === configRevision &&
      qualification.safetyFingerprint === safetyFingerprint &&
      qualification.canary,
  );
}

function hasBoundDirectPolicy(
  qualification: DirectShadowQualification,
): boolean {
  return Boolean(
    qualification.configRevision !== undefined ||
      qualification.safetyFingerprint !== undefined ||
      qualification.canary ||
      qualification.consecutiveCycles > 0 ||
      qualification.qualifiedAt !== undefined ||
      qualification.activationAuthorized,
  );
}

function resetQualification(
  qualification: DirectShadowQualification,
  clearCanary: boolean,
): void {
  qualification.configRevision = undefined;
  qualification.safetyFingerprint = undefined;
  qualification.consecutiveCycles = 0;
  qualification.lastCycleTick = undefined;
  qualification.qualifiedAt = undefined;
  qualification.activationAuthorized = false;
  if (clearCanary) qualification.canary = undefined;
}

/**
 * 每 tick 最多观察一次 mode 边及当前策略。已绑定的 revision/fingerprint
 * 任一失配都会立即清空资格与 canary；只有已完成资格的 direct Shadow
 * 直接切到 active direct，且 revision/fingerprint/canary 未变，才保留授权。
 */
export function observeDirectLifecycleTransition(
  qualification: DirectShadowQualification,
  input: {
    tick: number;
    mode: DirectLifecycleMode;
    shadowStrategy: "maker" | "direct";
    configRevision?: string;
    safetyFingerprint?: string;
  },
): DirectShadowQualification {
  if (qualification.lastLifecycleTick === input.tick) return qualification;
  const current = lifecycleKey(input.mode, input.shadowStrategy);
  const previous = qualification.lastLifecycleKey;

  if (current === "direct") {
    const directActivationEdge =
      previous === "direct_shadow" &&
      qualification.consecutiveCycles >= REQUIRED_DIRECT_SHADOW_CYCLES &&
      qualification.qualifiedAt !== undefined &&
      samePolicy(
        qualification,
        input.configRevision,
        input.safetyFingerprint,
      );
    const continuingAuthorizedDirect =
      previous === "direct" &&
      qualification.activationAuthorized &&
      samePolicy(
        qualification,
        input.configRevision,
        input.safetyFingerprint,
      );
    if (directActivationEdge || continuingAuthorizedDirect) {
      qualification.activationAuthorized = true;
    } else {
      resetQualification(qualification, true);
    }
  } else if (current === "direct_shadow") {
    const boundPolicyMismatch =
      hasBoundDirectPolicy(qualification) &&
      !samePolicy(
        qualification,
        input.configRevision,
        input.safetyFingerprint,
      );
    if (
      (previous !== undefined && previous !== "direct_shadow") ||
      boundPolicyMismatch
    ) {
      resetQualification(qualification, true);
    }
    qualification.activationAuthorized = false;
  } else {
    resetQualification(qualification, true);
  }

  qualification.lastLifecycleKey = current;
  qualification.lastLifecycleTick = input.tick;
  return qualification;
}

function candidateOrder(
  left: DirectStructuralCandidate,
  right: DirectStructuralCandidate,
): number {
  const leftPressure = left.capacityState === "pressure" ? 0 : 1;
  const rightPressure = right.capacityState === "pressure" ? 0 : 1;
  return (
    leftPressure - rightPressure ||
    right.sellableAmount - left.sellableAmount ||
    right.terminalStock - left.terminalStock ||
    left.roomName.localeCompare(right.roomName) ||
    left.resourceType.localeCompare(right.resourceType)
  );
}

export function selectDirectStructuralCanary(
  candidates: readonly DirectStructuralCandidate[],
): DirectStructuralCandidate | undefined {
  return [...candidates]
    .filter(
      (candidate) =>
        candidate.rejectionReasons.length === 0 &&
        candidate.isHubRoom === false &&
        candidate.capacityState !== undefined &&
        candidate.capacityState !== "emergency" &&
        candidate.sellableAmount >=
          MARKET_DIRECT_CANARY_POLICY.minOrderAmount &&
        candidate.terminalStock >=
          MARKET_DIRECT_CANARY_POLICY.minOrderAmount &&
        candidate.terminalCooldown === 0 &&
        Number.isSafeInteger(candidate.terminalEnergy) &&
        candidate.terminalEnergy! >= 0,
    )
    .sort(candidateOrder)[0];
}

export function canaryKey(
  canary: Pick<DirectCanaryLock, "roomName" | "resourceType">,
): string {
  return `${canary.roomName}:${canary.resourceType}`;
}

/**
 * 只有完整 ResourceControl 周期才推进。safe_no_opportunity 仍是完整安全
 * 决策；输入不完整清零连续计数，但不会偷偷改选 BUY 驱动的 canary。
 */
export function advanceDirectShadowQualification(
  qualification: DirectShadowQualification,
  input: {
    tick: number;
    configRevision: string;
    safetyFingerprint: string;
    canary: DirectStructuralCandidate;
    complete: boolean;
  },
): DirectShadowQualification {
  if (qualification.lastCycleTick === input.tick) return qualification;

  const nextCanary: DirectCanaryLock = {
    roomName: input.canary.roomName,
    resourceType: input.canary.resourceType,
    lockedAt: input.tick,
    configRevision: input.configRevision,
    safetyFingerprint: input.safetyFingerprint,
  };
  const policyChanged =
    qualification.configRevision !== input.configRevision ||
    qualification.safetyFingerprint !== input.safetyFingerprint ||
    !qualification.canary ||
    canaryKey(qualification.canary) !== canaryKey(nextCanary);

  if (policyChanged) {
    resetQualification(qualification, true);
    qualification.configRevision = input.configRevision;
    qualification.safetyFingerprint = input.safetyFingerprint;
    qualification.canary = nextCanary;
  }
  qualification.lastCycleTick = input.tick;
  qualification.activationAuthorized = false;
  if (!input.complete) {
    qualification.consecutiveCycles = 0;
    qualification.qualifiedAt = undefined;
    return qualification;
  }

  qualification.consecutiveCycles += 1;
  if (
    qualification.consecutiveCycles >= REQUIRED_DIRECT_SHADOW_CYCLES &&
    qualification.qualifiedAt === undefined
  ) {
    qualification.qualifiedAt = input.tick;
  }
  return qualification;
}

export function isDirectActivationQualified(
  qualification: DirectShadowQualification,
  input: {
    configRevision: string;
    safetyFingerprint: string;
    canary: DirectStructuralCandidate;
  },
): boolean {
  return Boolean(
    qualification.activationAuthorized &&
      qualification.consecutiveCycles >= REQUIRED_DIRECT_SHADOW_CYCLES &&
      qualification.qualifiedAt !== undefined &&
      qualification.configRevision === input.configRevision &&
      qualification.safetyFingerprint === input.safetyFingerprint &&
      qualification.canary &&
      canaryKey(qualification.canary) === canaryKey(input.canary),
  );
}

export function getDirectPlanningSnapshotStatus<TOpportunity>(
  snapshot: DirectPlanningSnapshot<TOpportunity> | undefined,
  tick: number,
  maxAgeTicks = DIRECT_PLANNING_SNAPSHOT_MAX_AGE_TICKS,
): DirectPlanningSnapshotStatus<TOpportunity> {
  if (!snapshot) {
    return { maxAgeTicks, fresh: false };
  }
  const age = tick - snapshot.observedAt;
  return {
    snapshot,
    age,
    maxAgeTicks,
    fresh: age >= 0 && age <= maxAgeTicks,
  };
}
