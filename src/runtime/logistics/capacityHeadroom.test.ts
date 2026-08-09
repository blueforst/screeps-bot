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
      receiverStorageMinFreeCapacity: 100_000,
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
      receiverStorageMinFreeCapacity: 100_000,
      terminalPressureFreeCapacity: 40_000,
      receiverTerminalMinFreeCapacity: 50_000,
      terminalReliefTargetFreeCapacity: 80_000,
    };

    expect(capacityPolicy).toEqual({
      terminalHeadroomRecoveryEnabled: true,
      storagePressureFreeCapacity: 100_000,
      storageReliefTargetFreeCapacity: 200_000,
      receiverStorageMinFreeCapacity: 100_000,
      terminalPressureFreeCapacity: 40_000,
      receiverTerminalMinFreeCapacity: 50_000,
      terminalReliefTargetFreeCapacity: 80_000,
    });
  });

  it("keeps receiver storage admission independent from the recovery target", () => {
    const policy = normalizeCapacityHeadroomPolicy({
      receiverStorageMinFreeCapacity: 120_000,
      storageReliefTargetFreeCapacity: 250_000,
    });

    expect(policy.storagePressureFreeCapacity).toBe(100_000);
    expect(policy.receiverStorageMinFreeCapacity).toBe(120_000);
    expect(policy.storageReliefTargetFreeCapacity).toBe(250_000);
  });

  it("clamps receiver storage admission to the pressure watermark", () => {
    const policy = normalizeCapacityHeadroomPolicy({
      storagePressureFreeCapacity: 120_000,
      receiverStorageMinFreeCapacity: 100_000,
      storageReliefTargetFreeCapacity: 250_000,
    });

    expect(policy.receiverStorageMinFreeCapacity).toBe(120_000);
    expect(policy.storageReliefTargetFreeCapacity).toBe(250_000);
  });

  it("admits a fresh room at the storage pressure boundary", () => {
    const policy = normalizeCapacityHeadroomPolicy(undefined);

    expect(resolveCapacityState(100_000, 80_000, policy)).toBe("normal");
    expect(resolveCapacityState(99_999, 80_000, policy)).toBe("pressure");
    expect(
      isReceiverAdmissionEligible(100_000, 80_000, "normal", policy),
    ).toBe(true);
    expect(getReceiverSafeCapacity(100_000, 80_000, policy)).toBe(0);
  });

  it("keeps a pressured room sticky until both recovery watermarks are met", () => {
    const policy = normalizeCapacityHeadroomPolicy(undefined);

    expect(resolveCapacityState(100_000, 80_000, policy, "pressure")).toBe(
      "pressure",
    );
    expect(resolveCapacityState(200_000, 80_000, policy, "pressure")).toBe(
      "normal",
    );
  });

  it("admits a fresh room at the terminal pressure boundary", () => {
    const policy = normalizeCapacityHeadroomPolicy(undefined);

    expect(resolveCapacityState(200_000, 40_000, policy)).toBe("normal");
    expect(resolveCapacityState(200_000, 39_999, policy)).toBe("pressure");
  });

  it("keeps zero or negative physical headroom in emergency", () => {
    const policy = normalizeCapacityHeadroomPolicy(undefined);

    expect(resolveCapacityState(0, 80_000, policy)).toBe("emergency");
    expect(resolveCapacityState(200_000, 0, policy)).toBe("emergency");
    expect(resolveCapacityState(-1, 80_000, policy)).toBe("emergency");
    expect(resolveCapacityState(200_000, -1, policy)).toBe("emergency");
  });
});
