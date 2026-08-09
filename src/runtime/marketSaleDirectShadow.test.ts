import {
  advanceDirectShadowQualification,
  createDirectShadowQualification,
  getDirectPlanningSnapshotStatus,
  isDirectActivationQualified,
  observeDirectLifecycleTransition,
  selectDirectStructuralCanary,
  type DirectStructuralCandidate,
} from "@/runtime/marketSaleDirectShadow";

function candidate(
  overrides: Partial<DirectStructuralCandidate> = {},
): DirectStructuralCandidate {
  return {
    roomName: "E6N59",
    resourceType: RESOURCE_CATALYST,
    protectionRevision: 100,
    observedAt: 100,
    expiresAt: 100,
    sellableAmount: 10_000,
    terminalStock: 20_000,
    terminalCooldown: 0,
    terminalEnergy: 50_000,
    capacityState: "normal",
    isHubRoom: false,
    rejectionReasons: [],
    ...overrides,
  };
}

describe("Direct Shadow qualification", () => {

  it("safe_no_opportunity 等完整周期可连续累计到 100", () => {
    const state = createDirectShadowQualification();
    observeDirectLifecycleTransition(state, {
      tick: 1,
      mode: "shadow",
      shadowStrategy: "direct",
      configRevision: "r1",
      safetyFingerprint: "fp1",
    });
    for (let cycle = 1; cycle <= 100; cycle += 1) {
      advanceDirectShadowQualification(state, {
        tick: cycle * 10,
        configRevision: "r1",
        safetyFingerprint: "fp1",
        canary: candidate(),
        complete: true,
      });
    }

    expect(state.consecutiveCycles).toBe(100);
    expect(state.qualifiedAt).toBe(1_000);
  });

  it("同 tick 重复调用不重复计数", () => {
    const state = createDirectShadowQualification();
    const input = {
      tick: 10,
      configRevision: "r1",
      safetyFingerprint: "fp1",
      canary: candidate(),
      complete: true,
    };
    advanceDirectShadowQualification(state, input);
    advanceDirectShadowQualification(state, input);
    expect(state.consecutiveCycles).toBe(1);
  });

  it("规划快照 age=10 仍 fresh，age=11 stale", () => {
    const snapshot = {
      observedAt: 100,
      configRevision: "r1",
      safetyFingerprint: "fp1",
      result: "safe_no_opportunity" as const,
      rejectedByReason: {},
    };

    expect(getDirectPlanningSnapshotStatus(snapshot, 110).fresh).toBe(true);
    expect(getDirectPlanningSnapshotStatus(snapshot, 111).fresh).toBe(false);
  });
});
