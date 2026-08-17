import {
  getReceiverSafeCapacity,
  isReceiverAdmissionEligible,
  normalizeCapacityHeadroomPolicy,
  resolveCapacityState,
} from "@/runtime/logistics/capacityHeadroom";

describe("capacity headroom policy", () => {

  it("admits a fresh room at the storage pressure boundary", () => {
    const policy = normalizeCapacityHeadroomPolicy(undefined);

    expect(resolveCapacityState(100_000, 80_000, policy)).toBe("normal");
    expect(resolveCapacityState(99_999, 80_000, policy)).toBe("pressure");
    expect(
      isReceiverAdmissionEligible(100_000, 80_000, "normal", policy),
    ).toBe(true);
    expect(getReceiverSafeCapacity(100_000, 80_000, policy)).toBe(0);
  });

  it("keeps zero or negative physical headroom in emergency", () => {
    const policy = normalizeCapacityHeadroomPolicy(undefined);

    expect(resolveCapacityState(0, 80_000, policy)).toBe("emergency");
    expect(resolveCapacityState(200_000, 0, policy)).toBe("emergency");
    expect(resolveCapacityState(-1, 80_000, policy)).toBe("emergency");
    expect(resolveCapacityState(200_000, -1, policy)).toBe("emergency");
  });
});
