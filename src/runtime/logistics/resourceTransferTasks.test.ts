import {
  cancelResourceTransferTask,
  cleanupResourceTransferTaskStore,
  createResourceTransferTaskAmountIndex,
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
  getIncomingResourceTransferAmount,
  getOutgoingResourceTransferAmount,
} from "@/runtime/logistics/resourceTransferTasks";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

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

  it("indexes only supplyable pending transfer amounts", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "healthy");
    const cancelled = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 300, "cancelled");
    const blocked = createResourceTransferTask("W3N1", "W2N1", RESOURCE_ENERGY, 200, "blocked");
    if (typeof cancelled === "string" || typeof blocked === "string") throw new Error("unexpected task creation failure");
    cancelResourceTransferTask(cancelled.task.id);
    ensureResourceTransferTaskStore()[blocked.task.id].lastError = "insufficient_terminal_resource_or_fee";

    const index = createResourceTransferTaskAmountIndex();

    expect(index.getOutgoing("W1N1", RESOURCE_ENERGY)).toBe(500);
    expect(index.getIncoming("W2N1", RESOURCE_ENERGY)).toBe(500);
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

  it("keeps blocked pending hub exports in the raw pending index", () => {
    const task = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "hub:export:energy");
    if (typeof task === "string") throw new Error("unexpected task creation failure");
    ensureResourceTransferTaskStore()[task.task.id].lastError = "insufficient_terminal_resource_or_fee";

    const index = createResourceTransferTaskAmountIndex();

    expect(index.getIncoming("W2N1", RESOURCE_ENERGY, "hub:export:")).toBe(0);
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

  it("removes pending tasks with blocking errors past TTL", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const store = ensureResourceTransferTaskStore();
    store[r.task.id].lastError = "insufficient_terminal_resource_or_fee";
    store[r.task.id].createdAt = 50; // created 50 ticks ago, TTL=10
    store[r.task.id].updatedAt = 99; // resourceControl keeps refreshing updatedAt

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);

    expect(removed).toBe(1);
    expect(store[r.task.id]).toBeUndefined();
  });

  it("keeps pending tasks with blocking errors within TTL", () => {
    const r = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    if (typeof r === "string") throw new Error("unexpected error");
    const store = ensureResourceTransferTaskStore();
    store[r.task.id].lastError = "insufficient_terminal_resource_or_fee";
    // createdAt=95, Game.time=100, diff=5 < TTL=10
    store[r.task.id].createdAt = 95;
    store[r.task.id].updatedAt = 99;

    const ownedRooms = new Set(["W1N1", "W2N1"]);
    const removed = cleanupResourceTransferTaskStore(ownedRooms, 10);

    expect(removed).toBe(0);
    expect(store[r.task.id]).toBeDefined();
  });

  it("keeps blocking pending tasks on their longer TTL", () => {
    const terminal = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "terminal");
    const blocked = createResourceTransferTask("W1N1", "W2N1", RESOURCE_HYDROGEN, 500, "blocked");
    if (typeof terminal === "string" || typeof blocked === "string") throw new Error("unexpected task creation failure");
    const store = ensureResourceTransferTaskStore();
    store[terminal.task.id].status = "cancelled";
    store[terminal.task.id].updatedAt = 50;
    store[blocked.task.id].lastError = "insufficient_terminal_resource_or_fee";
    store[blocked.task.id].createdAt = 50;

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

  it("excludes pending task blocked by insufficient terminal resource or fee", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    const store = ensureResourceTransferTaskStore();
    const task = Object.values(store)[0];
    task.lastError = "insufficient_terminal_resource_or_fee";

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_ENERGY)).toBe(0);
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

  it("excludes visible-source pending task when source has none of the resource", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_HYDROGEN, 500, "test");
    const task = Object.values(ensureResourceTransferTaskStore())[0];
    task.createdAt = Game.time - 100;
    Game.rooms.W1N1 = {
      name: "W1N1",
      terminal: { store: { getUsedCapacity: jest.fn(() => 0) } },
      storage: { store: { getUsedCapacity: jest.fn(() => 0) } },
    } as unknown as Room;

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_HYDROGEN)).toBe(0);
  });

  it("includes visible-source pending task when source storage can still feed terminal", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_HYDROGEN, 500, "test");
    const task = Object.values(ensureResourceTransferTaskStore())[0];
    task.createdAt = Game.time - 100;
    Game.rooms.W1N1 = {
      name: "W1N1",
      terminal: { store: { getUsedCapacity: jest.fn(() => 0) } },
      storage: { store: { getUsedCapacity: jest.fn(() => 500) } },
    } as unknown as Room;

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_HYDROGEN)).toBe(500);
  });

  it("includes pending task with non-blocking lastError", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "test");
    const store = ensureResourceTransferTaskStore();
    const task = Object.values(store)[0];
    task.lastError = "cooldown";

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_ENERGY)).toBe(500);
  });

  it("sums multiple healthy tasks but excludes blocked ones", () => {
    createResourceTransferTask("W1N1", "W2N1", RESOURCE_HYDROGEN, 1000, "a");
    createResourceTransferTask("W3N1", "W2N1", RESOURCE_HYDROGEN, 1000, "b");
    createResourceTransferTask("W4N1", "W2N1", RESOURCE_HYDROGEN, 5000, "c");

    const store = ensureResourceTransferTaskStore();
    const tasks = Object.values(store);
    const blockedTask = tasks.find((t) => t.reason === "c")!;
    blockedTask.lastError = "insufficient_terminal_resource_or_fee";

    expect(getIncomingResourceTransferAmount("W2N1", RESOURCE_HYDROGEN)).toBe(2000);
  });
});
