import {
  execFileSync,
  spawnSync,
} from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const MONITOR_SCRIPT = resolve(REPO_ROOT, "scripts/monitor-service.mjs");

function executeFixture(
  fixturePath: string,
): { output: string; payload: Record<string, any> } {
  const output = execFileSync(
    process.execPath,
    [
      MONITOR_SCRIPT,
      "--once",
      "--memory-fixture",
      fixturePath,
      "--segment-id",
      "off",
      "--output",
      "off",
      "--no-http",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
  const jsonStart = output.indexOf("\n{");
  if (jsonStart < 0) {
    throw new Error(`monitor CLI 未输出 JSON: ${output}`);
  }
  return {
    output,
    payload: JSON.parse(output.slice(jsonStart + 1)),
  };
}

function readFixtureProjection(fixtureName: string): Record<string, any> {
  return executeFixture(
    resolve(REPO_ROOT, `scripts/fixtures/${fixtureName}`),
  ).payload;
}

describe("monitor-service ResourceControl terminal headroom projection", () => {
  test("投影容量策略、receiver 统计和逐房 headroom 诊断", () => {
    const payload = readFixtureProjection("resource-control-headroom-monitor.json");
    const resourceControl = payload.memory.resourceControl;

    expect(resourceControl.capacityPolicy).toEqual({
      enabled: true,
      terminalHeadroomRecoveryEnabled: true,
      storagePressureFreeCapacity: 80000,
      storageReliefTargetFreeCapacity: 120000,
      receiverStorageMinFreeCapacity: 140000,
      terminalPressureFreeCapacity: 30000,
      terminalReliefTargetFreeCapacity: 60000,
      receiverTerminalMinFreeCapacity: 50000,
    });
    expect(resourceControl.eligibleReceiverCount).toBe(1);
    expect(resourceControl.receiverExcludedByReason).toEqual({
      storage_headroom: 1,
    });
    expect(resourceControl.suppressedStagingCount).toEqual({
      fee_budget: 1,
      receiver_capacity: 2,
    });
    expect(resourceControl.capacityIndexBuildCount).toBe(1);

    expect(resourceControl.rooms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roomName: "W1N1",
          storageUsedCapacity: 870000,
          storageFreeCapacity: 130000,
          desiredTerminalFreeCapacity: 60000,
          terminalRecoveryGap: 30000,
          recoverableOffloadAmount: 10000,
          stickyHeadroom: true,
          stickyHeadroomReason: "carrier_backlog",
          capacityReservation: {
            committed: 22000,
            remaining: 0,
          },
          staging: {
            admittedAmount: 2000,
            admittedTaskCount: 1,
            admittedByResource: {
              O: 2000,
            },
            suppressedCount: 3,
            suppressedByReason: {
              fee_budget: 1,
              receiver_capacity: 2,
            },
          },
        }),
        expect.objectContaining({
          roomName: "W2N1",
          storageUsedCapacity: 860000,
          storageFreeCapacity: 140000,
          terminalUsedCapacity: 200000,
          terminalFreeCapacity: 100000,
          stickyHeadroom: false,
          stickyHeadroomReason: null,
          staging: {
            admittedAmount: 0,
            admittedTaskCount: 0,
            admittedByResource: {},
            suppressedCount: 0,
            suppressedByReason: {},
          },
        }),
      ]),
    );
  });

  test("旧 runtime 缺少新字段时保持 null，不伪造零值或空对象", () => {
    const payload = readFixtureProjection("resource-control-monitor.json");
    const resourceControl = payload.memory.resourceControl;

    expect(resourceControl).toEqual(
      expect.objectContaining({
        capacityPolicy: null,
        eligibleReceiverCount: null,
        receiverExcludedByReason: null,
        suppressedStagingCount: null,
        capacityIndexBuildCount: null,
      }),
    );
    expect(resourceControl.rooms[0]).toEqual(
      expect.objectContaining({
        desiredTerminalFreeCapacity: null,
        terminalRecoveryGap: null,
        recoverableOffloadAmount: null,
        stickyHeadroom: null,
        stickyHeadroomReason: null,
        capacityReservation: null,
        staging: null,
        marketEnergyReadiness: null,
      }),
    );
  });
});

describe("monitor-service Hub protection projection", () => {
  test("投影 attempt 与 committed component marker，并验证同 revision", () => {
    const payload = readFixtureProjection(
      "market-sale-continuous-monitor.json",
    );
    const hub = payload.memory.hub;

    expect(hub.protectionAttempt).toEqual({
      attemptRevision: 17,
      configIncarnation: 3,
      startedAt: 50000,
      finishedAt: 50001,
      configFingerprint: "hubcfg-v1:stable",
      status: "committed",
      valid: true,
      reason: null,
    });
    expect(hub.committedProtectionMarker).toEqual(
      expect.objectContaining({
        schema: "hub-protection-snapshot-v1",
        planRevision: 17,
        configIncarnation: 3,
        observedAt: 50001,
        expiresAt: 50011,
        configFingerprint: "hubcfg-v1:stable",
        status: "committed",
        valid: true,
        consistent: true,
        marker: {
          revision: 17,
          configIncarnation: 3,
          configFingerprint: "hubcfg-v1:stable",
          hubRoomName: "E6N59",
          planMode: "distributed",
        },
      }),
    );
    expect(
      hub.committedProtectionMarker.components,
    ).toEqual({
      synthesisConfig: {
        revision: 17,
        configIncarnation: 3,
        configFingerprint: "hubcfg-v1:stable",
      },
      transferTasks: {
        revision: 17,
        configIncarnation: 3,
        configFingerprint: "hubcfg-v1:stable",
      },
      distributed: {
        revision: 17,
        configIncarnation: 3,
        configFingerprint: "hubcfg-v1:stable",
      },
      baseMineralSurplus: {
        revision: 17,
        configIncarnation: 3,
        configFingerprint: "hubcfg-v1:stable",
      },
    });
  });

  test("旧 Hub analytics 缺保护字段时返回 null", () => {
    const payload = readFixtureProjection(
      "resource-control-monitor.json",
    );
    expect(payload.memory.hub).toEqual(
      expect.objectContaining({
        protectionAttempt: null,
        committedProtectionMarker: null,
      }),
    );
  });

  test("损坏 Memory 的超长字符串与整行日志均被硬截断", () => {
    const sourcePath = resolve(
      REPO_ROOT,
      "scripts/fixtures/market-sale-continuous-monitor.json",
    );
    const fixture = JSON.parse(
      readFileSync(sourcePath, "utf8"),
    ) as Record<string, any>;
    const oversized = "x".repeat(8_192);
    fixture.analytics.hub.protectionAttempt.reason =
      oversized;
    const baseResourceV3 =
      fixture.data.marketSaleAutomation.directAutomation
        .baseResourceV3;
    baseResourceV3.scope.accountIdentity = oversized;
    baseResourceV3.catalog.resources[0] = oversized;
    baseResourceV3.lastPlanningSnapshot.blocker =
      oversized;
    baseResourceV3.blocker = oversized;
    baseResourceV3.quotaProjection.lanes = {
      [oversized]: {
        limit: 1,
        confirmed: 0,
        reserved: 0,
        used: 0,
        remaining: 1,
      },
    };
    fixture.runtime.marketSaleAutomation.direct.entries[0]
      .resourceType = oversized;

    const temporaryDirectory = mkdtempSync(
      resolve(tmpdir(), "screeps-monitor-bounds-"),
    );
    const fixturePath = resolve(
      temporaryDirectory,
      "fixture.json",
    );
    try {
      writeFileSync(
        fixturePath,
        JSON.stringify(fixture),
        "utf8",
      );
      const { payload } = executeFixture(fixturePath);
      const hub = payload.memory.hub;
      const base =
        payload.memory.marketSaleAutomation.direct
          .baseResourceV3;
      expect(hub.protectionAttempt.reason).toHaveLength(256);
      expect(base.roster.accountIdentity).toHaveLength(256);
      expect(base.catalog.resources.values[6]).toHaveLength(
        256,
      );
      expect(base.planning.blocker).toHaveLength(256);
      expect(base.blocker.code).toHaveLength(256);
      expect(
        Object.keys(base.quota.lanes.samples)[0],
      ).toHaveLength(256);

      const service = spawnSync(
        process.execPath,
        [
          MONITOR_SCRIPT,
          "--memory-fixture",
          fixturePath,
          "--segment-id",
          "off",
          "--output",
          "off",
          "--no-http",
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 1_000,
        },
      );
      const memoryLogLine = service.stdout
        .split("\n")
        .find((line) =>
          line.startsWith("[monitor][memory]"),
        );
      expect(memoryLogLine).toBeDefined();
      expect(memoryLogLine!.length).toBeLessThanOrEqual(4_096);
      expect(
        memoryLogLine!.endsWith(" …[truncated]"),
      ).toBe(true);
    } finally {
      rmSync(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("monitor-service market sale automation projection", () => {
  test("投影模式、Shadow 进度、保护拒绝与 canary 锁", () => {
    const payload = readFixtureProjection("resource-control-headroom-monitor.json");
    const marketSale = payload.memory.marketSaleAutomation;

    expect(marketSale).toEqual(
      expect.objectContaining({
        available: true,
        updatedAt: 2000,
        requestedMode: "shadow",
        phase: "shadow",
        configRevision: "shadow-v1",
        shadowConfigRevision: "shadow-v1",
        shadowConsecutiveCycles: 37,
        managedOrderCount: 0,
        managedOrders: [],
        managedOrderSummaryTruncated: false,
        orderSlots: {
          total: 300,
          current: 11,
          free: 289,
          reserved: 0,
          minFree: 5,
        },
        backoffSummary: {
          activeCount: 0,
          nextUntil: null,
        },
        pendingCreateCount: 0,
        pendingMutationCount: 0,
        stagingAmount: 0,
        reservationAmount: 0,
        exposureAmount: 0,
        creditSummary: {
          credits: 2500000,
          reserve: 1000000,
          reservedFeesThisTick: 0,
          availableAfterReserve: 1500000,
        },
        terminalClaims: ["W1N1"],
        rejectedByReason: {
          price_history_stale: 2,
          production_protected: 1,
        },
        safetyViolationCount: 0,
      }),
    );
    expect(marketSale.candidates).toEqual([
      expect.objectContaining({
        key: "W2N1:K",
        roomName: "W2N1",
        resource: "K",
        sellableAmount: 5000,
        historyTrusted: true,
        historyCompleteDayCount: 7,
        historyAcceptedDayCount: 6,
        historyFloor: 81,
        ratchetFloor: 81.5,
        effectiveNetFloor: 82,
        makerPrice: 90,
        makerNetPrice: 85.5,
      }),
    ]);
    expect(marketSale.canaryLock).toEqual({
      roomName: "W2N1",
      resourceType: "K",
      lockedAt: 1990,
      configRevision: "shadow-v1",
    });
  });

  test("旧 runtime 缺字段时显式返回 unavailable 与 null", () => {
    const payload = readFixtureProjection("resource-control-monitor.json");

    expect(payload.memory.marketSaleAutomation).toEqual(
      expect.objectContaining({
        available: false,
        updatedAt: null,
        requestedMode: null,
        phase: null,
        shadowConsecutiveCycles: null,
        candidates: null,
        rejectedByReason: null,
      }),
    );
  });

  test("旧 market runtime 缺少新增摘要时逐字段返回 null", () => {
    const payload = readFixtureProjection("market-sale-legacy-monitor.json");

    expect(payload.memory.marketSaleAutomation).toEqual(
      expect.objectContaining({
        available: true,
        updatedAt: 1500,
        managedOrders: null,
        managedOrderSummaryTruncated: null,
        orderSlots: null,
        backoffSummary: null,
        creditSummary: null,
        direct: null,
      }),
    );
  });

  test("投影 Direct Shadow、pending、BUY 机会与能量影子证据", () => {
    const payload = readFixtureProjection("market-sale-direct-monitor.json");
    const direct = payload.memory.marketSaleAutomation.direct;

    expect(direct).toEqual({
      available: true,
      baseResourceV3: null,
      strategyActive: true,
      shadowConsecutiveCycles: 42,
      qualifiedAt: null,
      activationAuthorized: false,
      canary: {
        roomName: "E6N59",
        resourceType: "X",
        lockedAt: 2000,
        configRevision: "x-direct-v1",
        safetyFingerprint: "direct-fingerprint-v1",
      },
      pendingCount: 1,
      pendingByStatus: {
        submitted: 1,
      },
      confirmedDealCount: 0,
      pausedForReview: false,
      migrationBlockedReason: null,
      exposure: {
        pendingCount: 1,
        quarantinedCount: null,
        resourceAmount: 1000,
        transactionEnergy: 900,
        reconcileGapCount: 0,
      },
      snapshot: {
        observedAt: 2100,
        age: 3,
        maxAgeTicks: 10,
        fresh: true,
        result: "safe_opportunity",
        configRevision: "x-direct-v1",
        safetyFingerprint: "direct-fingerprint-v1",
        canary: {
          roomName: "E6N59",
          resourceType: "X",
          lockedAt: 2000,
          configRevision: "x-direct-v1",
          safetyFingerprint: "direct-fingerprint-v1",
        },
        structuralCandidateCount: 6,
        eligibleStructuralCandidateCount: 1,
        buyBook: {
          rawOrderCount: 14,
          rawOrderLimit: 1000,
          eligibleOrderCount: 2,
          eligibleOrderLimit: 200,
          eligibleDepth: 6000,
          eligibleDistinctRoomCount: 2,
          pricedOrderCount: 2,
          safeCandidateCount: 1,
          rejectedOrderCount: 12,
          highestGrossPrice: 665.8,
          selectedOrderId: "buy-x-top",
          cycleRejection: null,
          orderRejectionCounts: {
            dust_amount: 4,
            gross_below_floor: 8,
          },
        },
        opportunity: {
          orderId: "buy-x-top",
          orderRoomName: "E51S9",
          price: 665.8,
          orderAmount: 1000,
          dealAmount: 1000,
          transactionEnergy: 900,
          netCreditsMilli: 641680000,
          worstCaseNetCreditsMilli: 639000,
          effectiveNetFloorMilli: 600000,
        },
        manualBuyOrderCount: 0,
        manualSellOrderCount: 1,
        zeroRemainingOwnOrderCount: 2,
        manualOrderBlocked: true,
        manualOrderBlockers: [
          "manual_sell_order_present",
        ],
        effectiveNetFloor: 600,
        effectiveEnergyShadowPrice: 26.8,
        energyShadowObservedAt: 2100,
        energyShadowComponents: {
          hardFloor: 20,
          explicit: 25,
          historyFloor: 26.8,
          ratchetFloor: 26.2,
        },
        rejectedByReason: {
          manual_sell_order_present: 1,
        },
      },
    });
  });

  test("兼容投影 Continuous v2 permit、逐 entry 生命周期、双层 quota 与账本高水位", () => {
    const payload = readFixtureProjection(
      "market-sale-continuous-monitor.json",
    );
    const direct = payload.memory.marketSaleAutomation.direct;

    expect(direct).toEqual(
      expect.objectContaining({
        available: true,
        strategyActive: true,
        capability: "market-direct-continuous",
        schemaVersion: 2,
        migrationStatus: "active",
        permit: {
          epoch: 3,
          permitId: "permit-epoch-3",
          permitHead: "permit-head-3",
          grants: [
            {
              entryId: "base-h-e3n59-v1",
              stage: "continuous",
              newDealGrant: "continuous",
            },
            {
              entryId: "base-x-e6n59-v1",
              stage: "continuous",
              newDealGrant: "continuous",
            },
            {
              entryId: "base-z-e7n57-v1",
              stage: "canary",
              newDealGrant: "canary",
            },
          ],
        },
        proposedPermitId: "permit-epoch-4",
        globalQuota: expect.objectContaining({
          limit: 12000,
          confirmed: 11000,
          reserved: 0,
          used: 11000,
          remaining: 1000,
          consistent: true,
        }),
        bestTuple: {
          entryId: "base-z-e7n57-v1",
          resourceType: "Z",
          sellerRoom: "E7N57",
          orderId: "buy-z-safe",
          grossPrice: 52,
          unitNetPrice: 49.75,
          transactionEnergy: 450,
        },
        coverage: {
          startTick: 20004,
          receiptHead: "receipt-head-12",
        },
        highWater: {
          finalizedAttemptSeq: 12,
          nextAttemptSeq: 13,
          permitEpoch: 3,
          permitChainHead: "permit-head-3",
        },
        blocker: {
          source: "ledger",
          code: "receipt_chain_gap",
          detectedAt: 50001,
          detailHash: "receipt-gap-detail",
        },
      }),
    );
    expect(direct.opportunityAdmission).toEqual({
      safeResourceTypes: ["H", "X", "Z"],
      requiredResourceTypes: ["H", "Z"],
      admittedResourceTypes: ["Z"],
      unmetByResource: {
        H: 0,
        Z: 1000,
      },
      totalUnmetAmount: 1000,
    });

    const h = direct.entries.find(
      (entry: Record<string, any>) => entry.resourceType === "H",
    );
    const x = direct.entries.find(
      (entry: Record<string, any>) => entry.resourceType === "X",
    );
    const z = direct.entries.find(
      (entry: Record<string, any>) => entry.resourceType === "Z",
    );
    expect(h).toEqual(
      expect.objectContaining({
        lane: {
          allowedRoomNames: ["E3N59"],
          requireNativeMineral: null,
          reserve: 100000,
        },
        floor: {
          hard: 428,
          economic: 451,
        },
        lifecycle: expect.objectContaining({
          stage: "continuous",
          shadowConsecutiveCycles: 100,
          canaryConfirmedCount: 1,
        }),
        quota: expect.objectContaining({
          resource: expect.objectContaining({
            limit: 8000,
            confirmed: 3000,
            reserved: 0,
            remaining: 5000,
          }),
          global: expect.objectContaining({
            limit: 12000,
            used: 11000,
            remaining: 1000,
          }),
        }),
        opportunity: {
          reserveAmount: 1000,
          safe: true,
          required: true,
          unmetAmount: 0,
          satisfied: true,
          admitted: false,
          admission:
            "global_quota_or_opportunity_reserve_blocked",
        },
      }),
    );
    expect(x.opportunity).toEqual(
      expect.objectContaining({
        required: false,
        unmetAmount: 0,
        admitted: false,
        admission: "resource_quota_blocked",
      }),
    );
    expect(z.opportunity).toEqual(
      expect.objectContaining({
        required: true,
        unmetAmount: 1000,
        admitted: true,
        admission: "admitted",
      }),
    );
    expect(direct.ledger).toEqual(
      expect.objectContaining({
        pending: null,
        quarantinedCount: 1,
        blocker: {
          code: "receipt_chain_gap",
          detectedAt: 50001,
          detailHash: "receipt-gap-detail",
        },
      }),
    );

    expect(direct.baseResourceV3).toEqual(
      expect.objectContaining({
        schemaVersion: 3,
        catalog: {
          revision: "base-mineral-v1",
          configRevision: "market-base-resource-v3-r1",
          resources: {
            total: 7,
            values: ["H", "K", "L", "O", "U", "X", "Z"],
            truncated: false,
          },
        },
        roster: expect.objectContaining({
          updatedAt: 50003,
          rosterFingerprint: "roster-v3",
          laneSetFingerprint: "lane-set-v3",
          roomCount: 2,
          truncated: false,
        }),
        lifecycle: expect.objectContaining({
          total: 2,
          truncated: false,
        }),
        permit: expect.objectContaining({
          currentPermitEpoch: 65,
          currentPermitId: "mbr-permit-v3:65:current",
          totalChainLength: 65,
          retainedPermitCount: 1,
          legacyV2GrantSuspended: true,
          prefix: {
            prunedThroughEpoch: 1,
            referencedPermitBindingCount: 1,
            prefixCommitment: "prefix-commitment-1",
          },
        }),
        quota: expect.objectContaining({
          revision: "quota-v3",
          global: {
            limit: 12000,
            confirmed: 11000,
            reserved: 0,
            used: 11000,
            remaining: 1000,
          },
        }),
        readinessAuthorization: expect.objectContaining({
          schemaVersion: 3,
          validated: true,
          status: "authorized",
          roomCount: 1,
          truncated: false,
        }),
        planning: expect.objectContaining({
          complete: false,
          blocker: "market_base_cpu_ceiling_exceeded",
          cpuUsed: 25.4,
          transactionCostEvaluationBudget: 1024,
          shadowPlannerMode: "batch_candidate",
          shadowPlannerInvocationCount: 1,
          actualTransactionEnergyEvaluations: 96,
          evaluatedShadowResourceCount: 1,
          candidateIdentityOrderChecks: 700,
        }),
        blocker: null,
      }),
    );

    const resourceControl = payload.memory.resourceControl;
    expect(resourceControl.rooms).toEqual([
      expect.objectContaining({
        roomName: "E6N59",
        marketEnergyReadiness: expect.objectContaining({
          schemaVersion: 3,
          authorizationRevision: "readiness-v3",
          terminalId: "terminal-e6",
          authorized: true,
          effectivePostDealEnergyReserve: 25000,
          marketTerminalEnergyTarget: 26000,
          desiredTerminalEnergy: 26000,
          plannedFeedAmount: 1000,
          status: "feed_planned",
          blocker: null,
        }),
      }),
    ]);
  });

  test("旧 V3 planning snapshot 缺少新增资源与身份检查指标时安全投影 null", () => {
    const sourcePath = resolve(
      REPO_ROOT,
      "scripts/fixtures/market-sale-continuous-monitor.json",
    );
    const fixture = JSON.parse(
      readFileSync(sourcePath, "utf8"),
    ) as Record<string, any>;
    const planning =
      fixture.data.marketSaleAutomation.directAutomation.baseResourceV3
        .lastPlanningSnapshot;
    delete planning.evaluatedShadowResourceCount;
    delete planning.candidateIdentityOrderChecks;

    const temporaryDirectory = mkdtempSync(
      resolve(tmpdir(), "screeps-monitor-old-planning-"),
    );
    const fixturePath = resolve(temporaryDirectory, "fixture.json");
    try {
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const { payload } = executeFixture(fixturePath);
      expect(
        payload.memory.marketSaleAutomation.direct.baseResourceV3.planning,
      ).toEqual(
        expect.objectContaining({
          evaluatedShadowResourceCount: null,
          candidateIdentityOrderChecks: null,
          cpuTrace: null,
        }),
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("未提交 canonical root 时优先投影更新的 runtime CPU trace", () => {
    const sourcePath = resolve(
      REPO_ROOT,
      "scripts/fixtures/market-sale-continuous-monitor.json",
    );
    const fixture = JSON.parse(
      readFileSync(sourcePath, "utf8"),
    ) as Record<string, any>;
    const planning =
      fixture.data.marketSaleAutomation.directAutomation.baseResourceV3
        .lastPlanningSnapshot;
    planning.cpuTrace = {
      observedAt: 700,
      cpuAfterOuterSession: 1,
      cpuAfterScopeCore: 2,
      cpuAfterMarketFacts: 3,
      cpuAfterShadowBatch: 4,
      cpuAfterInnerApply: 5,
      cpuCutPhase: null,
      marketFactsDisposition: "read",
    };
    fixture.runtime.marketSaleAutomation.direct.baseResourceV3CpuTrace = {
      observedAt: 701,
      cpuAfterOuterSession: 6,
      cpuAfterScopeCore: 12,
      cpuAfterMarketFacts: 19,
      cpuAfterShadowBatch: 24,
      cpuAfterInnerApply: 25,
      cpuCutPhase: "outer_precommit",
      marketFactsDisposition: "read",
    };

    const temporaryDirectory = mkdtempSync(
      resolve(tmpdir(), "screeps-monitor-cpu-trace-"),
    );
    const fixturePath = resolve(temporaryDirectory, "fixture.json");
    try {
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const { payload } = executeFixture(fixturePath);
      const projected =
        payload.memory.marketSaleAutomation.direct.baseResourceV3;
      expect(projected.cpuTrace).toEqual({
        observedAt: 701,
        cpuAfterOuterSession: 6,
        cpuAfterScopeCore: 12,
        cpuAfterMarketFacts: 19,
        cpuAfterShadowBatch: 24,
        cpuAfterInnerApply: 25,
        cpuCutPhase: "outer_precommit",
        marketFactsDisposition: "read",
      });
      expect(projected.planning.cpuTrace).toEqual(projected.cpuTrace);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("CPU trace 任一数值或枚举非法时整条 fail closed 为 null", () => {
    const sourcePath = resolve(
      REPO_ROOT,
      "scripts/fixtures/market-sale-continuous-monitor.json",
    );
    const fixture = JSON.parse(
      readFileSync(sourcePath, "utf8"),
    ) as Record<string, any>;
    fixture.runtime.marketSaleAutomation.direct.baseResourceV3CpuTrace = {
      observedAt: 701,
      cpuAfterOuterSession: -1,
      cpuAfterScopeCore: 101,
      cpuAfterMarketFacts: Number.POSITIVE_INFINITY,
      cpuAfterShadowBatch: "24",
      cpuAfterInnerApply: 25,
      cpuCutPhase: "forged_phase",
      marketFactsDisposition: "forged_disposition",
    };

    const temporaryDirectory = mkdtempSync(
      resolve(tmpdir(), "screeps-monitor-invalid-cpu-trace-"),
    );
    const fixturePath = resolve(temporaryDirectory, "fixture.json");
    try {
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const { payload } = executeFixture(fixturePath);
      expect(
        payload.memory.marketSaleAutomation.direct.baseResourceV3.cpuTrace,
      ).toBeNull();
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test.each([
    ["非单调", { cpuAfterScopeCore: 20, cpuAfterMarketFacts: 10 }],
    ["null 洞", { cpuAfterScopeCore: null, cpuAfterMarketFacts: 10 }],
    ["额外字段", { injected: "forged" }],
    ["非安全 tick", { observedAt: Number.MAX_SAFE_INTEGER + 1 }],
  ])("CPU trace %s 时 monitor 丢弃整条诊断", (_label, mutation) => {
    const sourcePath = resolve(
      REPO_ROOT,
      "scripts/fixtures/market-sale-continuous-monitor.json",
    );
    const fixture = JSON.parse(
      readFileSync(sourcePath, "utf8"),
    ) as Record<string, any>;
    fixture.runtime.marketSaleAutomation.direct.baseResourceV3CpuTrace = {
      observedAt: 701,
      cpuAfterOuterSession: 1,
      cpuAfterScopeCore: 2,
      cpuAfterMarketFacts: 3,
      cpuAfterShadowBatch: 4,
      cpuAfterInnerApply: 5,
      cpuCutPhase: null,
      marketFactsDisposition: "read",
      ...mutation,
    };

    const temporaryDirectory = mkdtempSync(
      resolve(tmpdir(), "screeps-monitor-structural-cpu-trace-"),
    );
    const fixturePath = resolve(temporaryDirectory, "fixture.json");
    try {
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const { payload } = executeFixture(fixturePath);
      expect(
        payload.memory.marketSaleAutomation.direct.baseResourceV3.cpuTrace,
      ).toBeNull();
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

});
