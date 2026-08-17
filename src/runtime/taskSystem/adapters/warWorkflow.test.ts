import warWorkflowAdapter, {
  snapshotWarWorkflow,
} from "@/runtime/taskSystem/adapters/warWorkflow";

type MutableRecord = Record<string, unknown>;

function warTask(overrides: MutableRecord = {}): MutableRecord {
  return {
    targetRoom: "W2N2",
    sourceRoom: "W1N1",
    status: "clearing",
    reason: "manual",
    squad: "t3Duo",
    oneShot: false,
    attempts: 1,
    createdAt: 100,
    updatedAt: 120,
    ...overrides,
  };
}

function installWarStore(store: unknown): void {
  Memory.data = { war: store } as unknown as NonNullable<Memory["data"]>;
}

describe("warWorkflowAdapter", () => {
  beforeEach(() => {
    Memory.data = undefined;
  });

  test("fails closed on unknown or conflicting fields without borrowing another identity", () => {
    installWarStore({
      W2N2: warTask({ status: "future" }),
      W3N3: warTask({ targetRoom: "W4N4" }),
      W5N5: warTask({ targetRoom: "W5N5", sourceRoom: undefined }),
      W6N6: 42,
      "": warTask(),
      W7N7: Object.create(warTask({ targetRoom: "W7N7" })),
    });

    const result = snapshotWarWorkflow();
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.ref.localId)).toEqual(["W2N2", "W3N3"]);
    expect(result.entries.every((entry) => entry.activity === "unknown")).toBe(true);
    expect(result.entries[0].issues).toContainEqual(expect.objectContaining({
      code: "war-unknown-status",
      field: "status",
    }));
    expect(result.entries[1]).toEqual(expect.objectContaining({
      ref: expect.objectContaining({
        scope: {
          kind: "cross_room",
          fromRoomName: "W1N1",
          toRoomName: "W4N4",
        },
        localId: "W3N3",
      }),
      activity: "unknown",
    }));
    expect(result.entries[1].issues).toContainEqual(expect.objectContaining({
      code: "war-store-key-mismatch",
      field: "targetRoom",
    }));
    expect(result.invalidCount).toBe(4);
    expect(result.issues.map((projectionIssue) => projectionIssue.code)).toEqual([
      "war-unprojectable-identity",
      "war-unprojectable-record",
      "war-unprojectable-identity",
      "war-unprojectable-identity",
    ]);
  });

  test("returns deeply isolated output and leaves source identities unchanged", () => {
    const configNames = Object.freeze({
      meleeAttacker: "W1N1:war:W2N2:g3:meleeAttacker:0",
      healer: "W1N1:war:W2N2:g3:healer:0",
    });
    const activeGeneration = Object.freeze({
      id: 3,
      phase: "assembling",
      createdAt: 110,
      boostTaskId: "war:W1N1:W2N2:g3",
      configNames,
    });
    const sourceTask = Object.freeze(warTask({ activeGeneration }));
    const store = Object.freeze({ W2N2: sourceTask });
    const data = { war: store };
    Memory.data = data as unknown as NonNullable<Memory["data"]>;
    const before = JSON.stringify(data);

    const first = warWorkflowAdapter.snapshot(undefined);
    const mutableEntry = first.entries[0] as any;
    mutableEntry.ref.scope.fromRoomName = "changed";
    mutableEntry.authorities[0].id = "changed";
    mutableEntry.issues.push({ code: "changed", message: "changed" });

    expect(JSON.stringify(data)).toBe(before);
    expect(Memory.data).toBe(data);
    expect((Memory.data as unknown as MutableRecord).war).toBe(store);
    expect(store.W2N2).toBe(sourceTask);
    expect(sourceTask.activeGeneration).toBe(activeGeneration);
    expect(activeGeneration.configNames).toBe(configNames);
    expect(warWorkflowAdapter.snapshot(undefined).entries[0]).toEqual(expect.objectContaining({
      ref: expect.objectContaining({
        scope: {
          kind: "cross_room",
          fromRoomName: "W1N1",
          toRoomName: "W2N2",
        },
      }),
      authorities: expect.arrayContaining([
        { role: "producer", id: "warControl" },
      ]),
      issues: [],
    }));
  });
});
