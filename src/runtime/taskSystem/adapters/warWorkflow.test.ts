import warWorkflowAdapter, {
  snapshotWarWorkflow,
  warWorkflowAdapter as namedWarWorkflowAdapter,
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

  test("exports the canonical adapter and projects target/source plus generation authorities", () => {
    installWarStore({
      W2N2: warTask({
        activeGeneration: {
          id: 2,
          phase: "deployed",
          createdAt: 105,
          boostTaskId: "war:W1N1:W2N2:g2",
          configNames: {
            meleeAttacker: "W1N1:war:W2N2:g2:meleeAttacker:0",
            healer: "W1N1:war:W2N2:g2:healer:0",
          },
        },
      }),
    });

    expect(warWorkflowAdapter).toBe(namedWarWorkflowAdapter);
    expect(warWorkflowAdapter.system).toBe("war-workflow");
    const result = warWorkflowAdapter.snapshot(undefined);

    expect(result).toEqual({
      entries: [{
        ref: {
          system: "war-workflow",
          namespace: "warControl",
          scope: {
            kind: "cross_room",
            fromRoomName: "W1N1",
            toRoomName: "W2N2",
          },
          localId: "W2N2",
        },
        activity: "running",
        sourceState: "clearing",
        authorities: [
          { role: "producer", id: "warControl" },
          { role: "workflow_owner", id: "W1N1", component: "source-room" },
          {
            role: "lease_owner",
            id: "war:W1N1:W2N2:g2",
            generation: 2,
            component: "boost",
          },
          {
            role: "executor",
            id: "W1N1:war:W2N2:g2:meleeAttacker:0",
            generation: 2,
            component: "meleeAttacker",
          },
          {
            role: "executor",
            id: "W1N1:war:W2N2:g2:healer:0",
            generation: 2,
            component: "healer",
          },
        ],
        createdAt: 100,
        updatedAt: 120,
        blocker: undefined,
        retryAt: undefined,
        issues: [],
      }],
      invalidCount: 0,
      issues: [],
    });
  });

  test("recognizes the real legacy T3 fixture shape without reporting standard pairing", () => {
    const attackerConfig = "E1N57:war:E3N57:g1:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:g1:healer:0";
    installWarStore({
      E3N57: warTask({
        targetRoom: "E3N57",
        sourceRoom: "E1N57",
        status: "clearing",
        squad: undefined,
        boostTier: "t3",
        activeGeneration: {
          id: 1,
          phase: "deployed",
          createdAt: 900,
          deployedAt: 950,
          boostTaskId: "war:E1N57:E3N57:g1",
          configNames: {
            meleeAttacker: attackerConfig,
            healer: healerConfig,
          },
        },
      }),
    });

    const entry = snapshotWarWorkflow().entries[0];
    expect(entry).toEqual(expect.objectContaining({
      ref: {
        system: "war-workflow",
        namespace: "warControl",
        scope: {
          kind: "cross_room",
          fromRoomName: "E1N57",
          toRoomName: "E3N57",
        },
        localId: "E3N57",
      },
      activity: "running",
      issues: [],
    }));
    expect(entry.authorities).toEqual(expect.arrayContaining([
      { role: "executor", id: attackerConfig, generation: 1, component: "meleeAttacker" },
      { role: "executor", id: healerConfig, generation: 1, component: "healer" },
    ]));
  });

  test("fails closed when generation components share one config identity", () => {
    const sharedConfig = "W1N1:war:W2N2:g2:shared:0";
    installWarStore({
      W2N2: warTask({
        activeGeneration: {
          id: 2,
          phase: "assembling",
          createdAt: 110,
          boostTaskId: "war:W1N1:W2N2:g2",
          configNames: {
            meleeAttacker: sharedConfig,
            healer: sharedConfig,
          },
        },
      }),
    });

    const entry = snapshotWarWorkflow().entries[0];
    expect(entry.activity).toBe("unknown");
    expect(entry.issues).toContainEqual(expect.objectContaining({
      code: "war-generation-component-identity-conflict",
      field: "activeGeneration.configNames",
    }));
  });

  test("keeps legacy fields optional and exposes only the bounded lifecycle ambiguities", () => {
    installWarStore({
      W2N2: warTask({
        status: "done",
        reason: "npc_reservation",
        squad: "standard",
        oneShot: true,
        activeGeneration: undefined,
      }),
    });

    const result = snapshotWarWorkflow();
    expect(result.entries[0]).toEqual(expect.objectContaining({
      activity: "terminal",
      sourceState: "done",
      retryAt: undefined,
    }));
    expect(result.entries[0].issues.map((projectionIssue) => projectionIssue.code)).toEqual([
      "war-raw-delete-cleanup-ambiguity",
      "war-standard-pairing-ambiguity",
      "war-one-shot-generation-loss-ambiguity",
      "war-terminal-config-retention-ambiguity",
    ]);
    expect(result.entries[0].issues).toHaveLength(4);
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

  test("does not ensure missing stores and reports malformed data/store shapes", () => {
    expect(warWorkflowAdapter.snapshot(undefined)).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });
    expect(Memory.data).toBeUndefined();

    (Memory as unknown as { data?: unknown }).data = [];
    expect(warWorkflowAdapter.snapshot(undefined)).toEqual(expect.objectContaining({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({ code: "war-malformed-data", field: "Memory.data" })],
    }));

    installWarStore([]);
    expect(warWorkflowAdapter.snapshot(undefined)).toEqual(expect.objectContaining({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({
        code: "war-malformed-store",
        field: "Memory.data.war",
      })],
    }));
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
