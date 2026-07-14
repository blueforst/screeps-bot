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

  it("enforces storage pressure <= relief target <= receiver minimum", () => {
    expect(
      normalizeCapacityHeadroomPolicy({
        storagePressureFreeCapacity: 400_000,
        storageReliefTargetFreeCapacity: 200_000,
        receiverStorageMinFreeCapacity: 100_000,
      }),
    ).toMatchObject({
      storagePressureFreeCapacity: 400_000,
      storageReliefTargetFreeCapacity: 400_000,
      receiverStorageMinFreeCapacity: 400_000,
    });
  });

  it("enforces terminal pressure <= receiver minimum <= relief target", () => {
    expect(
      normalizeCapacityHeadroomPolicy({
        terminalPressureFreeCapacity: 60_000,
        receiverTerminalMinFreeCapacity: 90_000,
        terminalReliefTargetFreeCapacity: 70_000,
      }),
    ).toMatchObject({
      terminalPressureFreeCapacity: 60_000,
      receiverTerminalMinFreeCapacity: 90_000,
      terminalReliefTargetFreeCapacity: 90_000,
    });
  });

  it("preserves an explicit disabled terminal recovery flag", () => {
    expect(
      normalizeCapacityHeadroomPolicy({
        terminalHeadroomRecoveryEnabled: false,
      }).terminalHeadroomRecoveryEnabled,
    ).toBe(false);
  });
});

describe("capacity state hysteresis", () => {
  const policy = DEFAULT_CAPACITY_HEADROOM_POLICY;

  it("reports emergency when either building has no free capacity", () => {
    expect(resolveCapacityState(0, 100_000, policy)).toBe("emergency");
    expect(resolveCapacityState(500_000, 0, policy)).toBe("emergency");
  });

  it("enters pressure at either pressure watermark", () => {
    expect(resolveCapacityState(100_000, 100_000, policy)).toBe("pressure");
    expect(resolveCapacityState(500_000, 40_000, policy)).toBe("pressure");
  });

  it("holds a previous pressure state until both relief targets are met", () => {
    expect(resolveCapacityState(200_000, 79_999, policy, "pressure")).toBe(
      "pressure",
    );
    expect(resolveCapacityState(199_999, 80_000, policy, "emergency")).toBe(
      "pressure",
    );
    expect(resolveCapacityState(200_000, 80_000, policy, "pressure")).toBe(
      "normal",
    );
  });

  it("keeps a normal room normal inside the hysteresis band", () => {
    expect(resolveCapacityState(150_000, 60_000, policy, "normal")).toBe(
      "normal",
    );
  });
});

describe("receiver capacity policy", () => {
  const policy = DEFAULT_CAPACITY_HEADROOM_POLICY;

  it("admits only normal receivers meeting both receiver minimums", () => {
    expect(
      isReceiverAdmissionEligible(300_000, 50_000, "normal", policy),
    ).toBe(true);
    expect(
      isReceiverAdmissionEligible(299_999, 50_000, "normal", policy),
    ).toBe(false);
    expect(
      isReceiverAdmissionEligible(300_000, 49_999, "normal", policy),
    ).toBe(false);
    expect(
      isReceiverAdmissionEligible(300_000, 50_000, "pressure", policy),
    ).toBe(false);
  });

  it("returns physical capacity above both pressure watermarks", () => {
    expect(getReceiverSafeCapacity(450_000, 70_000, policy)).toBe(30_000);
    expect(getReceiverSafeCapacity(99_999, 200_000, policy)).toBe(0);
  });
});
