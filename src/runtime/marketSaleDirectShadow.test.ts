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
  it("结构 canary 与输入顺序无关，并按 pressure/可售量/terminal/名称排序", () => {
    const normal = candidate({
      roomName: "E1N1",
      sellableAmount: 50_000,
    });
    const pressureSmall = candidate({
      roomName: "E2N2",
      capacityState: "pressure",
      sellableAmount: 5_000,
      terminalStock: 30_000,
    });
    const pressureLarge = candidate({
      roomName: "E3N3",
      capacityState: "pressure",
      sellableAmount: 8_000,
      terminalStock: 10_000,
    });

    expect(
      selectDirectStructuralCanary([
        normal,
        pressureSmall,
        pressureLarge,
      ])?.roomName,
    ).toBe("E3N3");
    expect(
      selectDirectStructuralCanary([
        pressureLarge,
        normal,
        pressureSmall,
      ])?.roomName,
    ).toBe("E3N3");
  });

  it("排序前排除不足 1000 可售量或 terminal 库存的高优先级房间", () => {
    const executable = candidate({
      roomName: "E1N1",
      capacityState: "normal",
      sellableAmount: 5_000,
      terminalStock: 5_000,
    });
    const pressureSellableDust = candidate({
      roomName: "E2N2",
      capacityState: "pressure",
      sellableAmount: 999,
      terminalStock: 50_000,
    });
    const pressureTerminalDust = candidate({
      roomName: "E3N3",
      capacityState: "pressure",
      sellableAmount: 50_000,
      terminalStock: 999,
    });

    expect(
      selectDirectStructuralCanary([
        pressureSellableDust,
        pressureTerminalDust,
        executable,
      ])?.roomName,
    ).toBe("E1N1");
  });

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

  it("只允许冻结配置的 Direct Shadow 直接激活 Direct", () => {
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
    observeDirectLifecycleTransition(state, {
      tick: 1_001,
      mode: "direct",
      shadowStrategy: "direct",
      configRevision: "r1",
      safetyFingerprint: "fp1",
    });

    expect(
      isDirectActivationQualified(state, {
        configRevision: "r1",
        safetyFingerprint: "fp1",
        canary: candidate(),
      }),
    ).toBe(true);
  });

  it("经 Maker 返回 Direct 或安全指纹变化都会清零", () => {
    const state = createDirectShadowQualification();
    state.configRevision = "r1";
    state.safetyFingerprint = "fp1";
    state.canary = {
      roomName: "E6N59",
      resourceType: RESOURCE_CATALYST,
      lockedAt: 1,
      configRevision: "r1",
      safetyFingerprint: "fp1",
    };
    state.consecutiveCycles = 100;
    state.qualifiedAt = 1_000;
    state.lastLifecycleKey = "direct_shadow";
    state.lastLifecycleTick = 1_000;

    observeDirectLifecycleTransition(state, {
      tick: 1_001,
      mode: "maker",
      shadowStrategy: "maker",
      configRevision: "r1",
      safetyFingerprint: undefined,
    });
    observeDirectLifecycleTransition(state, {
      tick: 1_002,
      mode: "direct",
      shadowStrategy: "direct",
      configRevision: "r1",
      safetyFingerprint: "fp1",
    });
    expect(state.consecutiveCycles).toBe(0);
    expect(state.activationAuthorized).toBe(false);

    advanceDirectShadowQualification(state, {
      tick: 1_010,
      configRevision: "r2",
      safetyFingerprint: "fp2",
      canary: candidate(),
      complete: true,
    });
    expect(state.consecutiveCycles).toBe(1);
    expect(state.configRevision).toBe("r2");
  });

  it.each([
    ["revision", "r2", "fp1"],
    ["fingerprint", "r1", "fp2"],
  ])(
    "非规划 tick 的 %s 失配立即清空资格，恢复旧策略也不能激活",
    (_field, changedRevision, changedFingerprint) => {
      const state = createDirectShadowQualification();
      state.configRevision = "r1";
      state.safetyFingerprint = "fp1";
      state.canary = {
        roomName: "E6N59",
        resourceType: RESOURCE_CATALYST,
        lockedAt: 10,
        configRevision: "r1",
        safetyFingerprint: "fp1",
      };
      state.consecutiveCycles = 100;
      state.lastCycleTick = 1_000;
      state.qualifiedAt = 1_000;
      state.lastLifecycleKey = "direct_shadow";
      state.lastLifecycleTick = 1_000;

      observeDirectLifecycleTransition(state, {
        tick: 1_001,
        mode: "shadow",
        shadowStrategy: "direct",
        configRevision: changedRevision,
        safetyFingerprint: changedFingerprint,
      });

      expect(state.configRevision).toBeUndefined();
      expect(state.safetyFingerprint).toBeUndefined();
      expect(state.canary).toBeUndefined();
      expect(state.consecutiveCycles).toBe(0);
      expect(state.qualifiedAt).toBeUndefined();
      expect(state.activationAuthorized).toBe(false);

      observeDirectLifecycleTransition(state, {
        tick: 1_002,
        mode: "shadow",
        shadowStrategy: "direct",
        configRevision: "r1",
        safetyFingerprint: "fp1",
      });
      observeDirectLifecycleTransition(state, {
        tick: 1_003,
        mode: "direct",
        shadowStrategy: "direct",
        configRevision: "r1",
        safetyFingerprint: "fp1",
      });

      expect(state.canary).toBeUndefined();
      expect(state.consecutiveCycles).toBe(0);
      expect(state.activationAuthorized).toBe(false);
    },
  );

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
