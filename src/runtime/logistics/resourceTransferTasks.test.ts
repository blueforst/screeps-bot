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

describe("createResourceTransferTask validation", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("rejects empty fromRoomName with ERR_INVALID_ROOM", () => {
    const result = createResourceTransferTask("", "W2N1", RESOURCE_ENERGY, 100);
    expect(result).toBe("ERR_INVALID_ROOM");
  });

  it("rejects empty toRoomName with ERR_INVALID_ROOM", () => {
    const result = createResourceTransferTask("W1N1", "", RESOURCE_ENERGY, 100);
    expect(result).toBe("ERR_INVALID_ROOM");
  });

  it("rejects same from/to room with ERR_SAME_ROOM", () => {
    const result = createResourceTransferTask("W1N1", "W1N1", RESOURCE_ENERGY, 100);
    expect(result).toBe("ERR_SAME_ROOM");
  });

  it("rejects empty resource string with ERR_INVALID_RESOURCE", () => {
    const result = createResourceTransferTask("W1N1", "W2N1", "" as ResourceConstant, 100);
    expect(result).toBe("ERR_INVALID_RESOURCE");
  });

  it("rejects resource not in RESOURCES_ALL with ERR_INVALID_RESOURCE", () => {
    const result = createResourceTransferTask("W1N1", "W2N1", "NOT_A_RESOURCE" as ResourceConstant, 100);
    expect(result).toBe("ERR_INVALID_RESOURCE");
  });

  it("rejects zero amount with ERR_INVALID_AMOUNT", () => {
    const result = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 0);
    expect(result).toBe("ERR_INVALID_AMOUNT");
  });

  it("rejects negative amount with ERR_INVALID_AMOUNT", () => {
    const result = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, -50);
    expect(result).toBe("ERR_INVALID_AMOUNT");
  });
});

describe("createResourceTransferTask merge behavior", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("merges amount when same (from, to, resource, reason) is repeated", () => {
    const r1 = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 100, "test");
    expect(r1).toEqual({ ok: true, task: expect.objectContaining({ amount: 100 }) });

    const r2 = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 200, "test");
    expect(r2).toEqual({ ok: true, task: expect.objectContaining({ amount: 300 }) });

    const store = ensureResourceTransferTaskStore();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("creates a separate task when reason differs", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 100, "reason-a");
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 200, "reason-b");

    const store = ensureResourceTransferTaskStore();
    const tasks = Object.values(store);
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.reason === "reason-a")).toEqual(expect.objectContaining({ amount: 100 }));
    expect(tasks.find((t) => t.reason === "reason-b")).toEqual(expect.objectContaining({ amount: 200 }));
  });

  it("creates a separate task when reason is undefined vs defined", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 100);
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 200, "reason-x");

    const store = ensureResourceTransferTaskStore();
    const tasks = Object.values(store);
    expect(tasks).toHaveLength(2);
  });
});

describe("getOutgoingResourceTransferAmount / getIncomingResourceTransferAmount", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("returns correct outgoing sum for a room+resource", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "a");
    createResourceTransferTask("W1N1", "W3N1", RESOURCE_ENERGY, 300, "b");

    expect(getOutgoingResourceTransferAmount("W1N1", RESOURCE_ENERGY)).toBe(800);
    expect(getOutgoingResourceTransferAmount("W2N1", RESOURCE_ENERGY)).toBe(0);
    expect(getOutgoingResourceTransferAmount("W1N1", RESOURCE_KEANIUM)).toBe(0);
  });

  it("returns correct incoming sum for a room+resource", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "a");
    createResourceTransferTask("W3N1", "W2N1", RESOURCE_ENERGY, 300, "b");

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_ENERGY)).toBe(800);
    expect(getIncomingResourceTransferAmount("W1N1", RESOURCE_ENERGY)).toBe(0);
    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_KEANIUM)).toBe(0);
  });

  it("excludes non-pending tasks from counters", () => {
    const r1 = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "a");
    if (typeof r1 !== "string" && r1.ok) {
      cancelResourceTransferTask(r1.task.id);
    }
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 200, "b");

    expect(getOutgoingResourceTransferAmount("W1N1", RESOURCE_ENERGY)).toBe(200);
    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_ENERGY)).toBe(200);
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

  it("indexes incoming amounts by task reason prefix when requested", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "hub:export:energy");
    createResourceTransferTask("W3N1", "W2N1", RESOURCE_ENERGY, 300, "synthesis:direct:energy");

    const index = createResourceTransferTaskAmountIndex();

    expect(index.getIncoming("W2N1", RESOURCE_ENERGY)).toBe(800);
    expect(index.getIncoming("W2N1", RESOURCE_ENERGY, "hub:export:")).toBe(500);
  });

  it("keeps retry-blocked hub exports in both healthy and raw pending indexes", () => {
    const task = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "hub:export:energy");
    if (typeof task === "string") throw new Error("unexpected task creation failure");
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    expect(markBlocked).toBeDefined();
    if (!markBlocked) return;
    markBlocked(task.task, "insufficient_terminal_resource_or_fee");

    const index = createResourceTransferTaskAmountIndex();

    expect(index.getIncoming("W2N1", RESOURCE_ENERGY, "hub:export:")).toBe(500);
    expect(index.getPendingIncoming("W2N1", RESOURCE_ENERGY, "hub:export:")).toBe(500);
  });

  it("indexes pending outgoing amounts by task reason prefix", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "synthesis:direct:energy");
    createResourceTransferTask("W1N1", "W3N1", RESOURCE_ENERGY, 300, "synthesis:hub-route:energy");
    createResourceTransferTask("W1N1", "W4N1", RESOURCE_ENERGY, 200, "hub:export:energy");

    const index = createResourceTransferTaskAmountIndex();

    expect(index.getOutgoing("W1N1", RESOURCE_ENERGY)).toBe(1000);
    expect(index.getPendingOutgoing("W1N1", RESOURCE_ENERGY, "synthesis:direct:")).toBe(500);
    expect(index.getPendingOutgoing("W1N1", RESOURCE_ENERGY, "synthesis:hub-route:")).toBe(300);
  });
});

describe("cancelResourceTransferTask", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("cancels a pending task and returns previous status", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const taskId = r.task.id;

    const cancelResult = cancelResourceTransferTask(taskId);
    expect(cancelResult).toEqual({
      ok: true,
      taskId,
      previousStatus: "pending",
    });

    const store = ensureResourceTransferTaskStore();
    expect(store[taskId].status).toBe("cancelled");
  });

  it("returns ERR_TASK_NOT_FOUND for unknown task id", () => {
    const result = cancelResourceTransferTask("nonexistent-id");
    expect(result).toBe("ERR_TASK_NOT_FOUND:nonexistent-id");
  });

  it("cancelled task is excluded from outgoing/incoming counters", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");

    cancelResourceTransferTask(r.task.id);

    expect(getOutgoingResourceTransferAmount("W1N1", RESOURCE_ENERGY)).toBe(0);
    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_ENERGY)).toBe(0);
  });
});

describe("cleanupResourceTransferTaskStore", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("removes stale done tasks past TTL", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const store = ensureResourceTransferTaskStore();
    const task = store[r.task.id];

    // Simulate task completed at tick 50
    task.status = "done";
    task.updatedAt = 50;

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);

    expect(removed).toBe(1);
    expect(store[r.task.id]).toBeUndefined();
  });

  it("removes stale cancelled tasks past TTL", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const store = ensureResourceTransferTaskStore();
    const task = store[r.task.id];

    task.status = "cancelled";
    task.updatedAt = 50;

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);

    expect(removed).toBe(1);
    expect(store[r.task.id]).toBeUndefined();
  });

  it("removes stale failed tasks past TTL", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const store = ensureResourceTransferTaskStore();
    const task = store[r.task.id];

    task.status = "failed";
    task.updatedAt = 50;

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);

    expect(removed).toBe(1);
    expect(store[r.task.id]).toBeUndefined();
  });

  it("keeps recent done tasks within TTL", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const store = ensureResourceTransferTaskStore();
    store[r.task.id].status = "done";
    store[r.task.id].updatedAt = 95; // 5 ticks ago, TTL=10

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);

    expect(removed).toBe(0);
    expect(store[r.task.id]).toBeDefined();
  });

  it("keeps pending tasks regardless of age", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const store = ensureResourceTransferTaskStore();
    store[r.task.id].updatedAt = 1; // very old but still pending

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);

    expect(removed).toBe(0);
    expect(store[r.task.id]).toBeDefined();
  });

  it("removes tasks where source room is no longer owned", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");

    // Only W2N1 is owned — W1N1 is lost
    const ownedRooms = new Set(["W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 100);

    expect(removed).toBe(1);
  });

  it("removes tasks where target room is no longer owned", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");

    // Only W1N1 is owned — W2N1 is lost
    const ownedRooms = new Set(["W1N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 100);

    expect(removed).toBe(1);
  });

  it("retains old manual pending tasks with retry blockers", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const store = ensureResourceTransferTaskStore();
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    expect(markBlocked).toBeDefined();
    if (!markBlocked) return;
    markBlocked(store[r.task.id], "insufficient_terminal_resource_or_fee");
    store[r.task.id].createdAt = 50; // created 50 ticks ago, TTL=10
    store[r.task.id].updatedAt = 99; // resourceControl keeps refreshing updatedAt

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);

    expect(removed).toBe(0);
    expect(store[r.task.id]).toBeDefined();
  });

  it("keeps manual pending tasks with recent retry blockers", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const store = ensureResourceTransferTaskStore();
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    expect(markBlocked).toBeDefined();
    if (!markBlocked) return;
    markBlocked(store[r.task.id], "insufficient_terminal_resource_or_fee");
    // createdAt=95, Game.time=100, diff=5 < TTL=10
    store[r.task.id].createdAt = 95;
    store[r.task.id].updatedAt = 99;

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);

    expect(removed).toBe(0);
    expect(store[r.task.id]).toBeDefined();
  });

  it("keeps automatic tasks within the no-progress TTL while terminal records use their short TTL", () => {
    const terminal = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "terminal");
    const createAutomatic = taskHealthApi.createAutomaticResourceTransferTask;
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    expect(createAutomatic).toBeDefined();
    expect(markBlocked).toBeDefined();
    if (!createAutomatic || !markBlocked) return;
    const blocked = createAutomatic("W1N1", "W2N1", RESOURCE_HYDROGEN, 500, "hub:import:H");
    if (typeof terminal === "string" || typeof blocked === "string") throw new Error("unexpected task creation failure");
    const store = ensureResourceTransferTaskStore();
    store[terminal.task.id].status = "cancelled";
    store[terminal.task.id].updatedAt = 50;
    markBlocked(store[blocked.task.id], "insufficient_terminal_resource_or_fee");
    (store[blocked.task.id] as CreatedTask & { lastProgressAt: number }).lastProgressAt = 50;

    const removed = cleanupResourceTransferTaskStore(new Set(["W1N1", "W2N1"]), 10, 100);

    expect(removed).toBe(1);
    expect(store[terminal.task.id]).toBeUndefined();
    expect(store[blocked.task.id]).toBeDefined();
  });

  it("keeps pending tasks with non-blocking errors regardless of age", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const store = ensureResourceTransferTaskStore();
    store[r.task.id].lastError = "some_other_error";
    store[r.task.id].createdAt = 1; // very old

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);

    expect(removed).toBe(0);
    expect(store[r.task.id]).toBeDefined();
  });

  it("returns 0 when store is empty", () => {
    const ownedRooms = new Set(["W1N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);
    expect(removed).toBe(0);
  });
});

describe("getIncomingResourceTransferAmount blocked task filter", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("includes pending task blocked by insufficient terminal resource or fee", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    const store = ensureResourceTransferTaskStore();
    const task = Object.values(store)[0];
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    expect(markBlocked).toBeDefined();
    if (!markBlocked) return;
    markBlocked(task, "insufficient_terminal_resource_or_fee");

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_ENERGY)).toBe(500);
  });

  it("includes pending task with legacy remaining-below-minimum lastError", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    const store = ensureResourceTransferTaskStore();
    const task = Object.values(store)[0];
    task.lastError = "remaining_below_transfer_min";

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_ENERGY)).toBe(500);
  });

  it("includes healthy pending incoming task", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_ENERGY)).toBe(500);
  });

  it("excludes an explicitly source-depleted pending task after grace", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_HYDROGEN, 500, "test");
    const task = Object.values(ensureResourceTransferTaskStore())[0];
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    expect(markBlocked).toBeDefined();
    if (!markBlocked) return;
    markBlocked(task, "source_depleted");
    (task as CreatedTask & { blockedSince?: number }).blockedSince = Game.time - 100;

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_HYDROGEN)).toBe(0);
  });

  it("includes a source-depleted pending task within grace", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_HYDROGEN, 500, "test");
    const task = Object.values(ensureResourceTransferTaskStore())[0];
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    expect(markBlocked).toBeDefined();
    if (!markBlocked) return;
    markBlocked(task, "source_depleted");
    (task as CreatedTask & { blockedSince?: number }).blockedSince = Game.time - 99;

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_HYDROGEN)).toBe(500);
  });

  it("includes pending task with non-blocking lastError", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    const store = ensureResourceTransferTaskStore();
    const task = Object.values(store)[0];
    task.lastError = "cooldown";

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_ENERGY)).toBe(500);
  });

  it("sums retry-blocked healthy tasks but excludes expired source-depleted supply", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_HYDROGEN, 1000, "a");
    createResourceTransferTask("W3N1", "W2N1", RESOURCE_HYDROGEN, 1000, "b");
    createResourceTransferTask("W4N1", "W2N1", RESOURCE_HYDROGEN, 5000, "c");

    const store = ensureResourceTransferTaskStore();
    const tasks = Object.values(store);
    const blockedTask = tasks.find((t) => t.reason === "c")!;
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    expect(markBlocked).toBeDefined();
    if (!markBlocked) return;
    markBlocked(blockedTask, "source_depleted");
    (blockedTask as CreatedTask & { blockedSince?: number }).blockedSince = Game.time - 100;

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_HYDROGEN)).toBe(2000);
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

  it("keeps the first blocked tick stable, transitions blocker reasons, and records progress", () => {
    const result = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof result === "string") throw new Error("unexpected task creation failure");
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    const clearBlocker = taskHealthApi.clearResourceTransferTaskBlocker;
    const recordProgress = taskHealthApi.recordResourceTransferTaskProgress;
    expect(markBlocked).toBeDefined();
    expect(clearBlocker).toBeDefined();
    expect(recordProgress).toBeDefined();
    if (!markBlocked || !clearBlocker || !recordProgress) return;

    Game.time = 110;
    markBlocked(result.task, "receiver_capacity");
    expect(result.task).toEqual(expect.objectContaining({ blockedReason: "receiver_capacity", blockedSince: 110 }));

    Game.time = 120;
    markBlocked(result.task, "receiver_capacity");
    expect((result.task as CreatedTask & { blockedSince?: number }).blockedSince).toBe(110);

    Game.time = 130;
    markBlocked(result.task, "source_depleted");
    expect(result.task).toEqual(expect.objectContaining({ blockedReason: "source_depleted", blockedSince: 130 }));

    Game.time = 135;
    clearBlocker(result.task);
    expect(result.task).toEqual(expect.objectContaining({ blockedReason: undefined, blockedSince: undefined }));

    Game.time = 140;
    markBlocked(result.task, "insufficient_terminal_resource_or_fee");
    recordProgress(result.task);
    expect(result.task).toEqual(
      expect.objectContaining({
        blockedReason: undefined,
        blockedSince: undefined,
        lastProgressAt: 140,
        updatedAt: 140,
      }),
    );
  });

  it("counts retry blockers as reservations but excludes depleted incoming supply after grace", () => {
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    expect(markBlocked).toBeDefined();
    if (!markBlocked) return;

    const capacity = createResourceTransferTask("W1N1", "W9N9", RESOURCE_HYDROGEN, 100, "capacity");
    const staging = createResourceTransferTask("W2N1", "W9N9", RESOURCE_HYDROGEN, 200, "staging");
    const depleted = createResourceTransferTask("W3N1", "W9N9", RESOURCE_HYDROGEN, 300, "depleted");
    if (typeof capacity === "string" || typeof staging === "string" || typeof depleted === "string") {
      throw new Error("unexpected task creation failure");
    }

    Game.time = 200;
    markBlocked(capacity.task, "receiver_capacity");
    markBlocked(staging.task, "insufficient_terminal_resource_or_fee");
    markBlocked(depleted.task, "source_depleted");
    (depleted.task as CreatedTask & { blockedSince?: number }).blockedSince = 101;

    expect(getIncomingResourceTransferAmount("W9N9", RESOURCE_HYDROGEN)).toBe(600);

    Game.time = 201;
    const index = createResourceTransferTaskAmountIndex();
    expect(index.getIncoming("W9N9", RESOURCE_HYDROGEN)).toBe(300);
    expect(index.getPendingIncoming("W9N9", RESOURCE_HYDROGEN)).toBe(600);
    expect(index.getOutgoing("W3N1", RESOURCE_HYDROGEN)).toBe(300);
  });

  it("cancels stalled automatic tasks while retaining equally old manual tasks", () => {
    const createAutomatic = taskHealthApi.createAutomaticResourceTransferTask;
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    const reconcile = taskHealthApi.reconcileResourceTransferTasks;
    expect(createAutomatic).toBeDefined();
    expect(markBlocked).toBeDefined();
    expect(reconcile).toBeDefined();
    if (!createAutomatic || !markBlocked || !reconcile) return;

    const noProgress = createAutomatic("W1N1", "W9N9", RESOURCE_HYDROGEN, 100, "hub:import:H");
    const sourceDepleted = createAutomatic("W2N1", "W9N9", RESOURCE_UTRIUM, 100, "synthesis:direct:U");
    const manual = createResourceTransferTask("W3N1", "W9N9", RESOURCE_LEMERGIUM, 100, "operator-request");
    if (typeof noProgress === "string" || typeof sourceDepleted === "string" || typeof manual === "string") {
      throw new Error("unexpected task creation failure");
    }

    Game.time = 6_001;
    (noProgress.task as CreatedTask & { lastProgressAt: number }).lastProgressAt = 1_000;
    (sourceDepleted.task as CreatedTask & { lastProgressAt: number }).lastProgressAt = 6_000;
    (manual.task as CreatedTask & { lastProgressAt: number }).lastProgressAt = 0;
    markBlocked(sourceDepleted.task, "source_depleted");
    (sourceDepleted.task as CreatedTask & { blockedSince?: number }).blockedSince = 5_900;
    markBlocked(manual.task, "source_depleted");
    (manual.task as CreatedTask & { blockedSince?: number }).blockedSince = 0;

    expect(reconcile()).toBe(2);
    expect(noProgress.task).toEqual(
      expect.objectContaining({ status: "cancelled", lastError: "automatic_no_progress_timeout", updatedAt: 6_001 }),
    );
    expect(sourceDepleted.task).toEqual(
      expect.objectContaining({ status: "cancelled", lastError: "automatic_source_depleted_timeout", updatedAt: 6_001 }),
    );
    expect(manual.task.status).toBe("pending");
  });

  it("retains newly cancelled automatic records until the existing terminal-record TTL elapses", () => {
    const createAutomatic = taskHealthApi.createAutomaticResourceTransferTask;
    const reconcile = taskHealthApi.reconcileResourceTransferTasks;
    expect(createAutomatic).toBeDefined();
    expect(reconcile).toBeDefined();
    if (!createAutomatic || !reconcile) return;

    const result = createAutomatic("W1N1", "W2N1", RESOURCE_ENERGY, 500, "energy-support");
    if (typeof result === "string") throw new Error("unexpected task creation failure");
    (result.task as CreatedTask & { lastProgressAt: number }).lastProgressAt = 0;
    Game.time = 5_001;
    reconcile();

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    expect(cleanupResourceTransferTaskStore(ownedRooms, 200)).toBe(0);
    expect(ensureResourceTransferTaskStore()[result.task.id]).toBeDefined();

    Game.time = 5_202;
    expect(cleanupResourceTransferTaskStore(ownedRooms, 200)).toBe(1);
    expect(ensureResourceTransferTaskStore()[result.task.id]).toBeUndefined();
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
