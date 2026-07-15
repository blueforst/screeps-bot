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
