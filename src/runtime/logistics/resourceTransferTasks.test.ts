import {
  createResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import * as resourceTransferTaskModule from "@/runtime/logistics/resourceTransferTasks";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

type CreatedTask = Exclude<ReturnType<typeof createResourceTransferTask>, string>["task"];
type TaskHealthApi = {
  createAutomaticResourceTransferTask?: typeof createResourceTransferTask;
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
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("creates console-compatible tasks as manual with an initialized progress timestamp", () => {
    const result = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "operator-request");
    if (typeof result === "string") throw new Error("unexpected task creation failure");

    expect(result.task).toEqual(
      expect.objectContaining({
        origin: "manual",
        lastProgressAt: 100,
      }),
    );
  });

  it("migrates known generated reasons conservatively and idempotently to schema v2", () => {
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
  });
});
