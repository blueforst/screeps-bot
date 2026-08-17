import resourceTransferAdapter, {
  RESOURCE_TRANSFER_NAMESPACE,
} from "@/runtime/taskSystem/adapters/resourceTransfer";

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


describe("resourceTransferAdapter", () => {
  beforeEach(() => {
    Memory.data = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (global as RuntimeGlobal).__runtimeServices;
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
});
