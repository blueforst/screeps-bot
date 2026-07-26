import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const MONITOR_SCRIPT = resolve(REPO_ROOT, "scripts/monitor-service.mjs");

function readFixtureProjection(fixtureName: string): Record<string, any> {
  const output = execFileSync(
    process.execPath,
    [
      MONITOR_SCRIPT,
      "--once",
      "--memory-fixture",
      resolve(REPO_ROOT, `scripts/fixtures/${fixtureName}`),
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
  return JSON.parse(output.slice(jsonStart + 1));
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
      }),
    );
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
  });

});
