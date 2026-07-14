import { normalizeBoolean, normalizeNumber } from "@/runtime/configNormalize";

export type CapacityState = "normal" | "pressure" | "emergency";

export interface CapacityHeadroomPolicy {
  enabled: boolean;
  terminalHeadroomRecoveryEnabled: boolean;
  storagePressureFreeCapacity: number;
  storageReliefTargetFreeCapacity: number;
  receiverStorageMinFreeCapacity: number;
  terminalPressureFreeCapacity: number;
  terminalReliefTargetFreeCapacity: number;
  receiverTerminalMinFreeCapacity: number;
}

export const DEFAULT_CAPACITY_HEADROOM_POLICY: CapacityHeadroomPolicy = {
  enabled: true,
  terminalHeadroomRecoveryEnabled: true,
  storagePressureFreeCapacity: 100_000,
  storageReliefTargetFreeCapacity: 200_000,
  receiverStorageMinFreeCapacity: 300_000,
  terminalPressureFreeCapacity: 40_000,
  terminalReliefTargetFreeCapacity: 80_000,
  receiverTerminalMinFreeCapacity: 50_000,
};

export function normalizeCapacityHeadroomPolicy(value: unknown): CapacityHeadroomPolicy {
  const raw = value && typeof value === "object"
    ? (value as Partial<CapacityHeadroomPolicy>)
    : {};
  const storagePressureFreeCapacity = normalizeNumber(
    raw.storagePressureFreeCapacity,
    DEFAULT_CAPACITY_HEADROOM_POLICY.storagePressureFreeCapacity,
    0,
    1_000_000,
  );
  const storageReliefTargetFreeCapacity = Math.max(
    storagePressureFreeCapacity,
    normalizeNumber(
      raw.storageReliefTargetFreeCapacity,
      DEFAULT_CAPACITY_HEADROOM_POLICY.storageReliefTargetFreeCapacity,
      0,
      1_000_000,
    ),
  );
  const receiverStorageMinFreeCapacity = Math.max(
    storageReliefTargetFreeCapacity,
    normalizeNumber(
      raw.receiverStorageMinFreeCapacity,
      DEFAULT_CAPACITY_HEADROOM_POLICY.receiverStorageMinFreeCapacity,
      0,
      1_000_000,
    ),
  );
  const terminalPressureFreeCapacity = normalizeNumber(
    raw.terminalPressureFreeCapacity,
    DEFAULT_CAPACITY_HEADROOM_POLICY.terminalPressureFreeCapacity,
    0,
    300_000,
  );
  const receiverTerminalMinFreeCapacity = Math.max(
    terminalPressureFreeCapacity,
    normalizeNumber(
      raw.receiverTerminalMinFreeCapacity,
      DEFAULT_CAPACITY_HEADROOM_POLICY.receiverTerminalMinFreeCapacity,
      0,
      300_000,
    ),
  );
  const terminalReliefTargetFreeCapacity = Math.max(
    receiverTerminalMinFreeCapacity,
    normalizeNumber(
      raw.terminalReliefTargetFreeCapacity,
      DEFAULT_CAPACITY_HEADROOM_POLICY.terminalReliefTargetFreeCapacity,
      0,
      300_000,
    ),
  );

  return {
    enabled: normalizeBoolean(raw.enabled, DEFAULT_CAPACITY_HEADROOM_POLICY.enabled),
    terminalHeadroomRecoveryEnabled: normalizeBoolean(
      raw.terminalHeadroomRecoveryEnabled,
      DEFAULT_CAPACITY_HEADROOM_POLICY.terminalHeadroomRecoveryEnabled,
    ),
    storagePressureFreeCapacity,
    storageReliefTargetFreeCapacity,
    receiverStorageMinFreeCapacity,
    terminalPressureFreeCapacity,
    terminalReliefTargetFreeCapacity,
    receiverTerminalMinFreeCapacity,
  };
}

export function resolveCapacityState(
  storageFreeCapacity: number,
  terminalFreeCapacity: number,
  policy: CapacityHeadroomPolicy,
  previousState?: CapacityState,
): CapacityState {
  if (storageFreeCapacity <= 0 || terminalFreeCapacity <= 0) {
    return "emergency";
  }

  if (previousState === "pressure" || previousState === "emergency") {
    const recovered =
      storageFreeCapacity >= policy.storageReliefTargetFreeCapacity &&
      terminalFreeCapacity >= policy.terminalReliefTargetFreeCapacity;
    if (!recovered) {
      return "pressure";
    }
  }

  if (
    storageFreeCapacity <= policy.storagePressureFreeCapacity ||
    terminalFreeCapacity <= policy.terminalPressureFreeCapacity
  ) {
    return "pressure";
  }

  return "normal";
}

export function isReceiverAdmissionEligible(
  storageFreeCapacity: number,
  terminalFreeCapacity: number,
  capacityState: CapacityState,
  policy: CapacityHeadroomPolicy,
): boolean {
  return capacityState === "normal" &&
    storageFreeCapacity >= policy.receiverStorageMinFreeCapacity &&
    terminalFreeCapacity >= policy.receiverTerminalMinFreeCapacity;
}

export function getReceiverSafeCapacity(
  storageFreeCapacity: number,
  terminalFreeCapacity: number,
  policy: CapacityHeadroomPolicy,
): number {
  return Math.max(
    0,
    Math.min(
      storageFreeCapacity - policy.storagePressureFreeCapacity,
      terminalFreeCapacity - policy.terminalPressureFreeCapacity,
    ),
  );
}
