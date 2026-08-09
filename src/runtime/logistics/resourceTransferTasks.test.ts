import {
  cancelResourceTransferTask,
  cleanupResourceTransferTaskStore,
  createResourceTransferTaskAmountIndex,
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
  getIncomingResourceTransferAmount,
  getOutgoingResourceTransferAmount,
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

describe("getOutgoingResourceTransferAmount / getIncomingResourceTransferAmount", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("indexes pending retry-blocked transfers as healthy reservations", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "healthy");
    const cancelled = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 300, "cancelled");
    const blocked = createResourceTransferTask("W3N1", "W2N1", RESOURCE_ENERGY, 200, "blocked");
    if (typeof cancelled === "string" || typeof blocked === "string") throw new Error("unexpected task creation failure");
    cancelResourceTransferTask(cancelled.task.id);
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    expect(markBlocked).toBeDefined();
    if (!markBlocked) return;
    markBlocked(blocked.task, "insufficient_terminal_resource_or_fee");

    const index = createResourceTransferTaskAmountIndex();

    expect(index.getOutgoing("W1N1", RESOURCE_ENERGY)).toBe(500);
    expect(index.getIncoming("W2N1", RESOURCE_ENERGY)).toBe(700);
    expect(index.getOutgoing("W3N1", RESOURCE_ENERGY)).toBe(200);
    expect(index.getIncoming("W1N1", RESOURCE_ENERGY)).toBe(0);
  });
});

describe("resource transfer task health v2", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("keeps old manual pending and fee-blocked tasks as receiver capacity commitments", () => {
    const pending = createResourceTransferTask("W1N1", "W9N9", RESOURCE_HYDROGEN, 100, "operator-pending");
    const feeBlocked = createResourceTransferTask("W2N1", "W9N9", RESOURCE_UTRIUM, 100, "operator-fee");
    if (typeof pending === "string" || typeof feeBlocked === "string") {
      throw new Error("unexpected task creation failure");
    }
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    const isHealthyCommitment = taskHealthApi.isHealthyReceiverCapacityCommitment;
    expect(markBlocked).toBeDefined();
    expect(isHealthyCommitment).toBeDefined();
    if (!markBlocked || !isHealthyCommitment) return;

    markBlocked(feeBlocked.task, "insufficient_terminal_resource_or_fee");
    pending.task.lastProgressAt = 0;
    feeBlocked.task.lastProgressAt = 0;
    Game.time = 100_000;

    expect(isHealthyCommitment(pending.task)).toBe(true);
    expect(isHealthyCommitment(feeBlocked.task)).toBe(true);
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

  it("provides an explicit automatic creator path", () => {
    const createAutomatic = taskHealthApi.createAutomaticResourceTransferTask;
    expect(createAutomatic).toBeDefined();
    if (!createAutomatic) return;

    const result = createAutomatic("W1N1", "W2N1", RESOURCE_ENERGY, 500, "hub:export:energy");
    if (typeof result === "string") throw new Error("unexpected task creation failure");

    expect(result.task).toEqual(
      expect.objectContaining({
        origin: "automatic",
        lastProgressAt: 100,
      }),
    );
  });

  it("uses configured no-progress TTL during task-store cleanup", () => {
    Memory.cfg = {
      resourceControl: {
        capacityBalancing: {
          automaticTaskNoProgressTtl: 10_000,
        },
      },
    };
    const createAutomatic = taskHealthApi.createAutomaticResourceTransferTask;
    expect(createAutomatic).toBeDefined();
    if (!createAutomatic) return;
    Game.time = 0;
    const created = createAutomatic("W1N1", "W2N1", RESOURCE_HYDROGEN, 100, "hub:configured-ttl");
    if (typeof created === "string") throw new Error(created);

    Game.time = 6_000;
    cleanupResourceTransferTaskStore(new Set(["W1N1", "W2N1"]), 200);

    expect(created.task.status).toBe("pending");
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
