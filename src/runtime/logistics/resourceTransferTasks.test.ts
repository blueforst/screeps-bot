import {
  createResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import * as resourceTransferTaskModule from "@/runtime/logistics/resourceTransferTasks";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

type CreatedTask = Exclude<ReturnType<typeof createResourceTransferTask>, string>["task"];
type TaskHealthApi = {
  createAutomaticResourceTransferTask?: typeof createResourceTransferTask;
  countDemandCoveringIncomingResourceTransferTasksByRoom?: (roomName: string) => number;
  countsResourceTransferTaskTowardDemand?: (
    task: CreatedTask,
    options?: {
      automaticTaskNoProgressTtl: number;
      sourceDepletedGraceTicks: number;
      receiverCapacityDemandCoverageGraceTicks: number;
    },
  ) => boolean;
  createResourceTransferTaskAmountIndex?: () => {
    getIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number;
    getPendingIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number;
  };
  getIncomingResourceTransferAmount?: (roomName: string, resource: ResourceConstant) => number;
  getResourceTransferTaskDemandCoverageExpirationReason?: (
    task: CreatedTask,
    options?: {
      automaticTaskNoProgressTtl: number;
      sourceDepletedGraceTicks: number;
      receiverCapacityDemandCoverageGraceTicks: number;
    },
  ) => string | null;
  isHealthyReceiverCapacityCommitment?: (
    task: CreatedTask,
    automaticTaskNoProgressTtl?: number,
  ) => boolean;
  markResourceTransferTaskBlocked?: (
    task: CreatedTask,
    reason: "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee",
  ) => void;
  clearResourceTransferTaskBlocker?: (task: CreatedTask) => void;
  recordResourceTransferTaskProgress?: (task: CreatedTask) => void;
  reconcileResourceTransferTasks?: (options?: {
    automaticTaskNoProgressTtl?: number;
    sourceDepletedGraceTicks?: number;
    receiverCapacityDemandCoverageGraceTicks?: number;
  }) => number;
};

const taskHealthApi = resourceTransferTaskModule as typeof resourceTransferTaskModule & TaskHealthApi;

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

describe("resource transfer task health v2", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Memory.cfg = undefined;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("creates console-compatible manual tasks that retain demand coverage and normalizes receiver grace", () => {
    const result = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "operator-request");
    if (typeof result === "string") throw new Error("unexpected task creation failure");

    expect(result.task).toEqual(
      expect.objectContaining({
        origin: "manual",
        lastProgressAt: 100,
      }),
    );

    const countsTowardDemand = taskHealthApi.countsResourceTransferTaskTowardDemand;
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    const reconcile = taskHealthApi.reconcileResourceTransferTasks;
    expect(countsTowardDemand).toBeDefined();
    expect(markBlocked).toBeDefined();
    expect(reconcile).toBeDefined();
    if (!countsTowardDemand || !markBlocked || !reconcile) return;

    markBlocked(result.task, "receiver_capacity");
    Game.time = 10_100;
    expect(countsTowardDemand(result.task)).toBe(true);
    expect(reconcile()).toBe(0);
    expect(result.task).toEqual(expect.objectContaining({
      status: "pending",
      blockedReason: "receiver_capacity",
      blockedSince: 100,
    }));

    expect(taskHealthApi.resolveResourceTransferTaskHealthOptions()).toEqual(expect.objectContaining({
      receiverCapacityDemandCoverageGraceTicks: 500,
    }));
    Memory.cfg = { resourceControl: { capacityBalancing: {} } };
    const capacityBalancing = Memory.cfg.resourceControl!
      .capacityBalancing as {
        receiverCapacityDemandCoverageGraceTicks?: number;
      };
    capacityBalancing.receiverCapacityDemandCoverageGraceTicks = 1;
    expect(taskHealthApi.resolveResourceTransferTaskHealthOptions().receiverCapacityDemandCoverageGraceTicks).toBe(50);
    capacityBalancing.receiverCapacityDemandCoverageGraceTicks = 50_001;
    expect(taskHealthApi.resolveResourceTransferTaskHealthOptions().receiverCapacityDemandCoverageGraceTicks).toBe(5_000);
  });

  it("migrates legacy tasks and applies automatic demand-coverage lifecycle boundaries", () => {
    const reconcile = taskHealthApi.reconcileResourceTransferTasks;
    expect(reconcile).toBeDefined();
    if (!reconcile) return;

    const legacyTask = (id: string, reason?: string, lastError?: string, updatedAt: number | undefined = 90) => ({
      id,
      resource: RESOURCE_HYDROGEN,
      fromRoomName: `W${id.length}N1`,
      toRoomName: "W9N9",
      amount: 100,
      remainingAmount: 100,
      status: "pending",
      createdAt: 80,
      updatedAt,
      reason,
      lastError,
    });
    const knownReasons = [
      "hub:import:H",
      "synthesis:direct:H",
      "auto:synthesis:W1N1:H",
      "powerBankBoost:task-1",
      "energy-support",
      "capacity:relief:H",
    ];
    const tasks: Record<string, ReturnType<typeof legacyTask>> = {};
    knownReasons.forEach((reason, index) => {
      tasks[`known-${index}`] = legacyTask(`known-${index}`, reason, index === 0 ? "insufficient_terminal_resource_or_fee" : undefined);
    });
    tasks["known-4"].updatedAt = undefined;
    tasks.unknown = legacyTask("unknown", "operator-request");
    tasks.absent = legacyTask("absent");
    Memory.data = { resourceControl: { tasks } } as unknown as NonNullable<Memory["data"]>;

    expect(reconcile()).toBe(0);
    const resourceControl = Memory.data!.resourceControl as NonNullable<Memory["data"]>["resourceControl"] & {
      taskSchemaVersion?: number;
    };
    const migrated = resourceControl!.tasks! as Record<string, CreatedTask>;
    expect(resourceControl!.taskSchemaVersion).toBe(2);
    for (let index = 0; index < knownReasons.length; index += 1) {
      expect(migrated[`known-${index}`]).toEqual(
        expect.objectContaining({
          origin: "automatic",
          lastProgressAt: index === 4 ? 80 : 90,
        }),
      );
    }
    expect(migrated["known-0"]).toEqual(
      expect.objectContaining({
        blockedReason: "insufficient_terminal_resource_or_fee",
        blockedSince: 90,
        lastError: undefined,
      }),
    );
    expect(migrated.unknown).toEqual(expect.objectContaining({ origin: "manual", status: "pending" }));
    expect(migrated.absent).toEqual(expect.objectContaining({ origin: "manual", status: "pending" }));

    const once = JSON.stringify(resourceControl);
    expect(reconcile()).toBe(0);
    expect(JSON.stringify(resourceControl)).toBe(once);

    const createAutomatic = taskHealthApi.createAutomaticResourceTransferTask;
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    const countsTowardDemand = taskHealthApi.countsResourceTransferTaskTowardDemand;
    const expirationReason = taskHealthApi.getResourceTransferTaskDemandCoverageExpirationReason;
    const getIncoming = taskHealthApi.getIncomingResourceTransferAmount;
    const createAmountIndex = taskHealthApi.createResourceTransferTaskAmountIndex;
    const countDemandCovering = taskHealthApi.countDemandCoveringIncomingResourceTransferTasksByRoom;
    expect(createAutomatic).toBeDefined();
    expect(markBlocked).toBeDefined();
    expect(countsTowardDemand).toBeDefined();
    expect(expirationReason).toBeDefined();
    expect(getIncoming).toBeDefined();
    expect(createAmountIndex).toBeDefined();
    expect(countDemandCovering).toBeDefined();
    if (
      !createAutomatic ||
      !markBlocked ||
      !countsTowardDemand ||
      !expirationReason ||
      !getIncoming ||
      !createAmountIndex ||
      !countDemandCovering
    ) return;

    Memory.data = undefined;
    Memory.cfg = undefined;
    Game.time = 1_000;
    const capacityResult = createAutomatic("W1N1", "W2N1", RESOURCE_HYDROGEN, 400, "synthesis:W2N1:OH");
    if (typeof capacityResult === "string") throw new Error("unexpected automatic task creation failure");
    markBlocked(capacityResult.task, "receiver_capacity");

    Game.time = 1_499;
    expect(countsTowardDemand(capacityResult.task)).toBe(true);
    expect(expirationReason(capacityResult.task)).toBeNull();
    expect(getIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(400);
    expect(createAmountIndex().getIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(400);
    expect(countDemandCovering("W2N1")).toBe(1);

    Game.time = 1_500;
    expect(countsTowardDemand(capacityResult.task)).toBe(false);
    expect(expirationReason(capacityResult.task)).toBe("automatic_receiver_capacity_coverage_timeout");
    expect(getIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(0);
    const expiredIndex = createAmountIndex();
    expect(expiredIndex.getIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(0);
    expect(expiredIndex.getPendingIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(400);
    expect(resourceTransferTaskModule.getOutgoingResourceTransferAmount("W1N1", RESOURCE_HYDROGEN)).toBe(400);
    expect(resourceTransferTaskModule.countPendingIncomingResourceTransferTasksByRoom("W2N1")).toBe(1);
    expect(countDemandCovering("W2N1")).toBe(0);

    const replacementResult = createAutomatic("W1N1", "W2N1", RESOURCE_HYDROGEN, 150, "synthesis:W2N1:OH");
    if (typeof replacementResult === "string") throw new Error("unexpected replacement task creation failure");
    expect(replacementResult.task.id).not.toBe(capacityResult.task.id);
    expect(capacityResult.task.remainingAmount).toBe(400);
    expect(replacementResult.task.remainingAmount).toBe(150);
    expect(getIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(150);
    expect(resourceTransferTaskModule.countPendingIncomingResourceTransferTasksByRoom("W2N1")).toBe(2);
    expect(countDemandCovering("W2N1")).toBe(1);

    expect(reconcile({ receiverCapacityDemandCoverageGraceTicks: 500 })).toBe(1);
    expect(capacityResult.task).toEqual(expect.objectContaining({
      status: "cancelled",
      blockedReason: "receiver_capacity",
      blockedSince: 1_000,
      lastError: "automatic_receiver_capacity_coverage_timeout",
    }));
    expect(replacementResult.task.status).toBe("pending");

    Game.time = 2_000;
    const sourceResult = createAutomatic("W3N1", "W2N1", RESOURCE_OXYGEN, 200, "synthesis:W2N1:OH");
    if (typeof sourceResult === "string") throw new Error("unexpected source task creation failure");
    markBlocked(sourceResult.task, "source_depleted");
    Game.time = 2_099;
    expect(countsTowardDemand(sourceResult.task)).toBe(true);
    Game.time = 2_100;
    expect(countsTowardDemand(sourceResult.task)).toBe(false);
    expect(expirationReason(sourceResult.task)).toBe("automatic_source_depleted_timeout");
    expect(getIncoming("W2N1", RESOURCE_OXYGEN)).toBe(0);
    const sourceExpiredIndex = createAmountIndex();
    expect(sourceExpiredIndex.getIncoming("W2N1", RESOURCE_OXYGEN)).toBe(0);
    expect(sourceExpiredIndex.getPendingIncoming("W2N1", RESOURCE_OXYGEN)).toBe(200);
    expect(reconcile({ sourceDepletedGraceTicks: 100 })).toBe(1);
    expect(sourceResult.task.lastError).toBe("automatic_source_depleted_timeout");

    Memory.data = undefined;
    Game.time = 3_000;
    const stalledResult = createAutomatic(
      "W4N1",
      "W2N1",
      RESOURCE_KEANIUM,
      100,
      "synthesis:W2N1:KH",
    );
    if (typeof stalledResult === "string") {
      throw new Error("unexpected stalled task creation failure");
    }
    Game.time = 8_000;
    expect(countsTowardDemand(stalledResult.task)).toBe(true);
    expect(expirationReason(stalledResult.task)).toBeNull();
    Game.time = 8_001;
    expect(countsTowardDemand(stalledResult.task)).toBe(false);
    expect(expirationReason(stalledResult.task)).toBe(
      "automatic_no_progress_timeout",
    );
    expect(reconcile()).toBe(1);
    expect(stalledResult.task.lastError).toBe(
      "automatic_no_progress_timeout",
    );
  });
});
