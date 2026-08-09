import {
  DEFAULT_CAPACITY_HEADROOM_POLICY,
  getReceiverSafeCapacity,
  isReceiverAdmissionEligible,
  normalizeCapacityHeadroomPolicy,
  resolveCapacityState,
} from "@/runtime/logistics/capacityHeadroom";

describe("capacity headroom policy", () => {
  it("uses the established watermarks and enables terminal recovery by default", () => {
    expect(DEFAULT_CAPACITY_HEADROOM_POLICY).toEqual({
      enabled: true,
      terminalHeadroomRecoveryEnabled: true,
      storagePressureFreeCapacity: 100_000,
      storageReliefTargetFreeCapacity: 200_000,
      receiverStorageMinFreeCapacity: 300_000,
      terminalPressureFreeCapacity: 40_000,
      terminalReliefTargetFreeCapacity: 80_000,
      receiverTerminalMinFreeCapacity: 50_000,
    });

    expect(normalizeCapacityHeadroomPolicy(undefined)).toEqual(
      DEFAULT_CAPACITY_HEADROOM_POLICY,
    );
  });

  it("normalizes invalid values and clamps watermarks to building capacity", () => {
    expect(
      normalizeCapacityHeadroomPolicy({
        enabled: "invalid",
        terminalHeadroomRecoveryEnabled: "invalid",
        storagePressureFreeCapacity: 2_000_000,
        storageReliefTargetFreeCapacity: Number.NaN,
        receiverStorageMinFreeCapacity: -1,
        terminalPressureFreeCapacity: Number.POSITIVE_INFINITY,
        terminalReliefTargetFreeCapacity: -1,
        receiverTerminalMinFreeCapacity: 500_000,
      }),
    ).toEqual({
      enabled: true,
      terminalHeadroomRecoveryEnabled: true,
      storagePressureFreeCapacity: 1_000_000,
      storageReliefTargetFreeCapacity: 1_000_000,
      receiverStorageMinFreeCapacity: 1_000_000,
      terminalPressureFreeCapacity: 40_000,
      terminalReliefTargetFreeCapacity: 300_000,
      receiverTerminalMinFreeCapacity: 300_000,
    });
  });

  it("supports the normalized policy shape in optional runtime memory", () => {
    type ResourceControlRuntime = NonNullable<
      NonNullable<Memory["runtime"]>["resourceControl"]
    >;
    const capacityPolicy: NonNullable<ResourceControlRuntime["capacityPolicy"]> = {
      terminalHeadroomRecoveryEnabled: true,
      storagePressureFreeCapacity: 100_000,
      storageReliefTargetFreeCapacity: 200_000,
      receiverStorageMinFreeCapacity: 300_000,
      terminalPressureFreeCapacity: 40_000,
      receiverTerminalMinFreeCapacity: 50_000,
      terminalReliefTargetFreeCapacity: 80_000,
    };

    expect(capacityPolicy).toEqual({
      terminalHeadroomRecoveryEnabled: true,
      storagePressureFreeCapacity: 100_000,
      storageReliefTargetFreeCapacity: 200_000,
      receiverStorageMinFreeCapacity: 300_000,
      terminalPressureFreeCapacity: 40_000,
      receiverTerminalMinFreeCapacity: 50_000,
      terminalReliefTargetFreeCapacity: 80_000,
    });
  });
});
