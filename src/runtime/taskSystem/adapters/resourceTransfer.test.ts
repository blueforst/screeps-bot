import resourceTransferAdapter, {
  RESOURCE_TRANSFER_NAMESPACE,
  type ResourceTransferWorkStatusView,
} from "@/runtime/taskSystem/adapters/resourceTransfer";
import * as resourceTransferTasks from "@/runtime/logistics/resourceTransferTasks";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

type MutableRecord = Record<string, unknown>;
type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };

function task(overrides: MutableRecord = {}): MutableRecord {
  return {
    id: "transfer-1",
    resource: "energy",
    fromRoomName: "W1N1",
    toRoomName: "W2N2",
    amount: 1_000,
    remainingAmount: 400,
    status: "pending",
    createdAt: 100,
    updatedAt: 120,
    origin: "automatic",
    lastProgressAt: 115,
    reason: "hub:export:energy",
    ...overrides,
  };
}

function installStore(
  tasks: unknown,
  taskSchemaVersion: unknown = 2,
): MutableRecord {
  const resourceControl: MutableRecord = { tasks };
  if (taskSchemaVersion !== undefined) {
    resourceControl.taskSchemaVersion = taskSchemaVersion;
  }
  Memory.data = { resourceControl } as unknown as NonNullable<Memory["data"]>;
  return resourceControl;
}

function snapshotEntries(): readonly ResourceTransferWorkStatusView[] {
  return resourceTransferAdapter.snapshot({ observedAt: 999 }).entries;
}

describe("resourceTransferAdapter", () => {
  beforeEach(() => {
    Memory.data = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (global as RuntimeGlobal).__runtimeServices;
  });

  test("exports the canonical adapter and leaves an absent or empty store absent", () => {
    expect(resourceTransferAdapter.system).toBe("resource-transfer");
    expect(resourceTransferAdapter.snapshot(undefined)).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });
    expect(Memory.data).toBeUndefined();

    Memory.data = {} as NonNullable<Memory["data"]>;
    const data = Memory.data;
    expect(resourceTransferAdapter.snapshot(undefined)).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });
    expect(Memory.data).toBe(data);
    expect((Memory.data as unknown as MutableRecord).resourceControl).toBeUndefined();

    const resourceControl = installStore({}, 2);
    const tasks = resourceControl.tasks;
    expect(resourceTransferAdapter.snapshot(undefined)).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });
    expect((Memory.data as unknown as MutableRecord).resourceControl).toBe(resourceControl);
    expect(resourceControl.tasks).toBe(tasks);

    Memory.data = { resourceControl: { tasks: null } } as unknown as NonNullable<Memory["data"]>;
    expect(resourceTransferAdapter.snapshot(undefined)).toEqual(expect.objectContaining({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({ code: "resource-transfer-store-shape" })],
    }));
  });

  test("projects cross-room identity, origin/executor authority, lifecycle, quantities, and times", () => {
    const tasks = {
      terminal: task({
        id: "terminal",
        status: "done",
        remainingAmount: 0,
        origin: "manual",
        updatedAt: 140,
        lastProgressAt: 140,
      }),
      blocked: task({
        id: "blocked",
        fromRoomName: "W3N3",
        toRoomName: "W4N4",
        resource: "H",
        amount: 500,
        remainingAmount: 250,
        updatedAt: 121,
        blockedReason: "receiver_capacity",
        blockedSince: 121,
      }),
      available: task({
        id: "available",
        origin: "manual",
        reason: "operator-request",
      }),
      cancelled: task({
        id: "cancelled",
        status: "cancelled",
        remainingAmount: 400,
        lastError: "cancelled_by_command",
      }),
      failed: task({
        id: "failed",
        status: "failed",
        remainingAmount: 400,
        lastError: "ERR_INVALID_TARGET",
      }),
    };
    installStore(tasks);

    const entries = snapshotEntries();
    expect(entries.map((entry) => entry.ref.localId)).toEqual([
      "available",
      "cancelled",
      "failed",
      "terminal",
      "blocked",
    ]);

    const available = entries.find((entry) => entry.ref.localId === "available");
    expect(available).toEqual(expect.objectContaining({
      ref: {
        system: "resource-transfer",
        namespace: RESOURCE_TRANSFER_NAMESPACE,
        scope: {
          kind: "cross_room",
          fromRoomName: "W1N1",
          toRoomName: "W2N2",
        },
        localId: "available",
      },
      activity: "available",
      sourceState: "pending",
      authorities: [
        { role: "producer", id: "manual" },
        { role: "executor", id: "resourceControl" },
      ],
      resource: "energy",
      amount: 1_000,
      remainingAmount: 400,
      origin: "manual",
      createdAt: 100,
      updatedAt: 120,
      lastProgressAt: 115,
      reason: "operator-request",
      issues: [],
    }));

    const blocked = entries.find((entry) => entry.ref.localId === "blocked");
    expect(blocked).toEqual(expect.objectContaining({
      activity: "blocked",
      sourceState: "pending",
      blocker: "receiver_capacity",
      blockedSince: 121,
      authorities: [
        { role: "producer", id: "automatic" },
        { role: "executor", id: "resourceControl" },
      ],
      resource: "H",
      amount: 500,
      remainingAmount: 250,
    }));

    for (const localId of ["terminal", "cancelled", "failed"]) {
      const projected = entries.find((entry) => entry.ref.localId === localId);
      expect(projected?.activity).toBe("terminal");
      expect(projected?.sourceState).toBe(tasks[localId as keyof typeof tasks].status);
    }
  });

  test("keeps an automatically cancelled task terminal when reconcile retains its historical blocker", () => {
    delete (global as RuntimeGlobal).__runtimeServices;
    registerRuntimeServices();
    Game.time = 100;

    const created = resourceTransferTasks.createAutomaticResourceTransferTask(
      "W1N1",
      "W2N2",
      RESOURCE_ENERGY,
      500,
      "hub:automatic-cancel-fixture",
    );
    if (typeof created === "string") throw new Error(created);
    resourceTransferTasks.markResourceTransferTaskBlocked(created.task, "source_depleted");

    const pending = resourceTransferAdapter.snapshot(undefined).entries[0];
    expect(pending).toEqual(expect.objectContaining({
      activity: "blocked",
      sourceState: "pending",
      blocker: "source_depleted",
      blockedSince: 100,
      issues: [],
    }));

    Game.time = 110;
    expect(resourceTransferTasks.reconcileResourceTransferTasks({
      sourceDepletedGraceTicks: 10,
      automaticTaskNoProgressTtl: 1_000,
    })).toBe(1);
    expect(created.task).toEqual(expect.objectContaining({
      status: "cancelled",
      blockedReason: "source_depleted",
      blockedSince: 100,
      lastError: "automatic_source_depleted_timeout",
    }));

    const terminal = resourceTransferAdapter.snapshot(undefined).entries[0];
    expect(terminal).toEqual(expect.objectContaining({
      activity: "terminal",
      sourceState: "cancelled",
      blocker: "source_depleted",
      blockedSince: 100,
    }));
    expect(terminal.issues).toEqual([
      expect.objectContaining({
        code: "resource-transfer-historical-retained-blocker",
        field: "blockedReason",
      }),
    ]);
  });

  test("reads legacy records without migration or origin inference", () => {
    const legacyTask = task({
      id: "legacy",
      origin: undefined,
      updatedAt: undefined,
      lastProgressAt: undefined,
      reason: "hub:import:H",
    });
    const tasks = { legacy: legacyTask };
    const resourceControl: MutableRecord = { tasks };
    Memory.data = { resourceControl } as unknown as NonNullable<Memory["data"]>;
    const before = JSON.stringify(Memory.data);

    const result = resourceTransferAdapter.snapshot(undefined);

    expect(result.invalidCount).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual(expect.objectContaining({
      activity: "available",
      sourceState: "pending",
      authorities: [{ role: "executor", id: "resourceControl" }],
      updatedAt: undefined,
      lastProgressAt: undefined,
      origin: undefined,
    }));
    expect(result.entries[0].issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "resource-transfer-legacy-schema",
      "resource-transfer-legacy-field-missing",
    ]));
    expect(JSON.stringify(Memory.data)).toBe(before);
    expect(resourceControl).not.toHaveProperty("taskSchemaVersion");
    expect(resourceControl.tasks).toBe(tasks);
    expect(tasks.legacy).toBe(legacyTask);
  });

  test("fails closed for malformed store/items and only counts records without provable identity", () => {
    installStore([task()], 2);
    expect(resourceTransferAdapter.snapshot(undefined)).toEqual(expect.objectContaining({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({ code: "resource-transfer-store-shape" })],
    }));

    const identifiable = task({ id: "identifiable", amount: Number.NaN });
    const quantityConflict = task({ id: "quantityConflict", status: "done", remainingAmount: 1 });
    const inherited = Object.create(task({ id: "inherited" })) as MutableRecord;
    const tasks = {
      nonObject: 42,
      missingScope: task({ id: "missingScope", fromRoomName: undefined }),
      inherited,
      identifiable,
      quantityConflict,
    };
    installStore(tasks, 2);

    const result = resourceTransferAdapter.snapshot(undefined);

    expect(result.invalidCount).toBe(3);
    expect(result.entries).toHaveLength(2);
    const identifiableEntry = result.entries.find((entry) => entry.ref.localId === "identifiable");
    expect(identifiableEntry).toEqual(expect.objectContaining({
      ref: expect.objectContaining({ localId: "identifiable" }),
      activity: "unknown",
      sourceState: "pending",
      amount: undefined,
    }));
    expect(identifiableEntry?.issues).toContainEqual(expect.objectContaining({
      code: "resource-transfer-invalid-field",
      field: "amount",
    }));
    expect(result.entries.find((entry) => entry.ref.localId === "quantityConflict"))
      .toEqual(expect.objectContaining({
        activity: "unknown",
        sourceState: "done",
        remainingAmount: 1,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "resource-transfer-quantity-conflict" }),
        ]),
      }));
  });

  test("fails closed for a resource outside RESOURCES_ALL without affecting legal siblings", () => {
    const tasks = {
      legal: task({ id: "legal", resource: RESOURCE_ENERGY }),
      unknown: task({ id: "unknown", resource: "definitely-not-a-resource" }),
    };
    installStore(tasks, 2);

    const result = resourceTransferAdapter.snapshot(undefined);

    expect(result.invalidCount).toBe(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.find((entry) => entry.ref.localId === "legal")).toEqual(
      expect.objectContaining({
        activity: "available",
        sourceState: "pending",
        resource: RESOURCE_ENERGY,
        issues: [],
      }),
    );
    expect(result.entries.find((entry) => entry.ref.localId === "unknown")).toEqual(
      expect.objectContaining({
        activity: "unknown",
        sourceState: "pending",
        resource: "definitely-not-a-resource",
        issues: [expect.objectContaining({
          code: "resource-transfer-unknown-resource",
          field: "resource",
        })],
      }),
    );
  });

  test("does not treat unknown status, blocker, origin, or schema as active or terminal", () => {
    const tasks = {
      status: task({ id: "status", status: "paused" }),
      blocker: task({ id: "blocker", blockedReason: "terminal_busy", blockedSince: 120 }),
      origin: task({ id: "origin", origin: "planner" }),
      idConflict: task({ id: "some-other-id" }),
    };
    installStore(tasks, 99);

    const result = resourceTransferAdapter.snapshot(undefined);

    expect(result.invalidCount).toBe(0);
    expect(result.entries).toHaveLength(4);
    for (const entry of result.entries) {
      expect(entry.activity).toBe("unknown");
      expect(entry.issues).toContainEqual(expect.objectContaining({
        code: "resource-transfer-unknown-schema",
      }));
    }
    expect(result.entries.find((entry) => entry.ref.localId === "status")?.sourceState).toBe("paused");
    expect(result.entries.find((entry) => entry.ref.localId === "status")?.issues)
      .toContainEqual(expect.objectContaining({ code: "resource-transfer-unknown-status" }));
    expect(result.entries.find((entry) => entry.ref.localId === "blocker")?.issues)
      .toContainEqual(expect.objectContaining({ code: "resource-transfer-unknown-blocker" }));
    expect(result.entries.find((entry) => entry.ref.localId === "origin")?.issues)
      .toContainEqual(expect.objectContaining({ code: "resource-transfer-unknown-origin" }));
    expect(result.entries.find((entry) => entry.ref.localId === "idConflict")?.issues)
      .toContainEqual(expect.objectContaining({ code: "resource-transfer-identity-conflict" }));
  });

  test("isolates returned refs, authorities, issues, and quantities from the source", () => {
    const sourceTask = task({
      id: "isolated",
      blockedReason: "source_depleted",
      blockedSince: 119,
    });
    const tasks = { isolated: sourceTask };
    installStore(tasks, 2);
    const before = JSON.stringify(sourceTask);

    const first = resourceTransferAdapter.snapshot(undefined);
    const mutableEntry = first.entries[0] as unknown as {
      ref: { namespace: string; scope: { fromRoomName: string } };
      authorities: Array<{ id: string }>;
      issues: Array<{ code: string; message: string }>;
      amount: number;
    };
    mutableEntry.ref.namespace = "mutated";
    mutableEntry.ref.scope.fromRoomName = "W9N9";
    mutableEntry.authorities[0].id = "mutated";
    mutableEntry.issues.push({ code: "mutated", message: "mutated" });
    mutableEntry.amount = 1;

    expect(JSON.stringify(sourceTask)).toBe(before);
    expect(tasks.isolated).toBe(sourceTask);

    const second = resourceTransferAdapter.snapshot(undefined);
    expect(second.entries[0]).toEqual(expect.objectContaining({
      ref: expect.objectContaining({
        namespace: RESOURCE_TRANSFER_NAMESPACE,
        scope: expect.objectContaining({ fromRoomName: "W1N1" }),
      }),
      authorities: [
        { role: "producer", id: "automatic" },
        { role: "executor", id: "resourceControl" },
      ],
      amount: 1_000,
    }));
    expect(second.entries[0].issues).not.toContainEqual(expect.objectContaining({ code: "mutated" }));
  });

  test("does not call ensure/migrate paths or change Memory/private globals/source references", () => {
    const ensureSpy = jest.spyOn(resourceTransferTasks, "ensureResourceTransferTaskStore");
    const listSpy = jest.spyOn(resourceTransferTasks, "getResourceTransferTaskListSorted");
    const sourceTask = task({ id: "side-effect" });
    const tasks = { "side-effect": sourceTask };
    const resourceControl = installStore(tasks, 2);
    const data = Memory.data;
    const beforeJson = JSON.stringify(Memory.data);
    const beforePrivateGlobals = Object.getOwnPropertyNames(global)
      .filter((key) => key.startsWith("__"))
      .sort();

    resourceTransferAdapter.snapshot(undefined);

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(Memory.data)).toBe(beforeJson);
    expect(Memory.data).toBe(data);
    expect((Memory.data as unknown as MutableRecord).resourceControl).toBe(resourceControl);
    expect(resourceControl.tasks).toBe(tasks);
    expect(tasks["side-effect"]).toBe(sourceTask);
    expect(Object.getOwnPropertyNames(global).filter((key) => key.startsWith("__")).sort())
      .toEqual(beforePrivateGlobals);
  });
});
