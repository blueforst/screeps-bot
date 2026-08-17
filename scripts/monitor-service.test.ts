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
          localOffloadCapacityCommitment: 6000,
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

    const sourcePath = resolve(
      REPO_ROOT,
      "scripts/fixtures/market-sale-continuous-monitor.json",
    );
    const fixture = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, any>;
    const planning = fixture.data.marketSaleAutomation.directAutomation.baseResourceV3
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

    const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "screeps-monitor-cpu-trace-"));
    const fixturePath = resolve(temporaryDirectory, "fixture.json");
    try {
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const projected = executeFixture(fixturePath)
        .payload.memory.marketSaleAutomation.direct.baseResourceV3;
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
});

describe("monitor-service Hub protection projection", () => {

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
