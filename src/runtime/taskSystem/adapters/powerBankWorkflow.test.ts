import powerBankWorkflowAdapter, {
  powerBankWorkflowAdapter as namedPowerBankWorkflowAdapter,
  snapshotPowerBankWorkflow,
} from "@/runtime/taskSystem/adapters/powerBankWorkflow";

type MutableRecord = Record<string, unknown>;

function powerBankTask(id: string, overrides: MutableRecord = {}): MutableRecord {
  return {
    id,
    status: "attacking",
    sourceRoom: "W1N1",
    targetRoom: "W2N2",
    bankId: `object:${id}`,
    bankPos: { x: 25, y: 25 },
    hits: 1_000_000,
    power: 4_000,
    ticksToDecay: 2_000,
    freeTiles: 4,
    discoveredTick: 100,
    lastSeenTick: 120,
    haulerIds: [],
    boostLabs: [],
    compoundTransferTaskIds: [],
    ...overrides,
  };
}

function installPowerBankStore(
  store: unknown,
  history?: unknown,
): Record<string, unknown> {
  const data: Record<string, unknown> = { powerBankHarvest: store };
  if (history !== undefined) data.powerBankHarvestHistory = history;
  Memory.data = data as unknown as NonNullable<Memory["data"]>;
  return data;
}

describe("powerBankWorkflowAdapter", () => {
  beforeEach(() => {
    Memory.data = undefined;
  });

  test("uses the real PowerBank fixture identity shape and preserves stage, deadline, owner, and generation facts", () => {
    const id = "pb-test";
    const bankId = "bank-0";
    installPowerBankStore({
      [id]: powerBankTask(id, {
        sourceRoom: "E5N55",
        targetRoom: "E0N60",
        bankId,
        stageEnteredAt: 110,
        lastProgressAt: 125,
        bankExpiresAt: 2_100,
        activeGeneration: 3,
        activeIndex: 0,
        primaryBoostOwnerId: `${id}:primary:g3`,
        attackerId: "active-attacker",
        healerId: "active-healer",
        reinforcement: {
          index: 1,
          generation: 4,
          stage: "travelling",
          boostOwnerId: `${id}:reinforcement:g4`,
          attackerId: "reinforcement-attacker",
          healerId: "reinforcement-healer",
        },
      }),
    });

    expect(powerBankWorkflowAdapter).toBe(namedPowerBankWorkflowAdapter);
    expect(powerBankWorkflowAdapter.system).toBe("power-bank-workflow");
    const result = powerBankWorkflowAdapter.snapshot(undefined);

    expect(result).toEqual({
      entries: [{
        ref: {
          system: "power-bank-workflow",
          namespace: "powerBankHarvest",
          scope: { kind: "object", objectId: bankId },
          localId: id,
        },
        activity: "running",
        sourceState: "attacking",
        authorities: [
          { role: "producer", id: "powerBankHarvest" },
          { role: "workflow_owner", id: "E5N55", component: "source-room" },
          {
            role: "workflow_owner",
            id: `${id}:primary:g3`,
            generation: 3,
            component: "active-generation",
          },
          {
            role: "lease_owner",
            id: `${id}:primary:g3`,
            generation: 3,
            component: "boost",
          },
          { role: "executor", id: "active-attacker", generation: 3, component: "attacker" },
          { role: "executor", id: "active-healer", generation: 3, component: "healer" },
          {
            role: "workflow_owner",
            id: `${id}:reinforcement:g4`,
            generation: 4,
            component: "reinforcement",
          },
          {
            role: "lease_owner",
            id: `${id}:reinforcement:g4`,
            generation: 4,
            component: "boost",
          },
          {
            role: "executor",
            id: "reinforcement-attacker",
            generation: 4,
            component: "attacker",
          },
          {
            role: "executor",
            id: "reinforcement-healer",
            generation: 4,
            component: "healer",
          },
        ],
        createdAt: 100,
        updatedAt: 110,
        lastProgressAt: 125,
        blocker: undefined,
        retryAt: undefined,
        deadlineAt: 2_100,
        issues: [],
      }],
      invalidCount: 0,
      issues: [],
    });
  });

  test("keeps legacy generation optional and allows discovered tasks without a source room", () => {
    const id = "bank:discovered";
    installPowerBankStore({
      [id]: powerBankTask(id, {
        status: "discovered",
        sourceRoom: "",
        activeGeneration: undefined,
        primaryBoostOwnerId: undefined,
      }),
    });

    const result = snapshotPowerBankWorkflow();
    expect(result.invalidCount).toBe(0);
    expect(result.entries[0]).toEqual(expect.objectContaining({
      activity: "available",
      sourceState: "discovered",
      authorities: [{ role: "producer", id: "powerBankHarvest" }],
      deadlineAt: undefined,
      issues: [],
    }));
  });

  test("keeps a legacy reinforcement generation absent without fabricating one", () => {
    const id = "pb-legacy-reinforcement";
    installPowerBankStore({
      [id]: powerBankTask(id, {
        activeGeneration: 0,
        activeIndex: 0,
        reinforcement: {
          index: 1,
          stage: "spawning",
          boostOwnerId: `${id}:reinforcement:legacy`,
        },
      }),
    });

    const entry = snapshotPowerBankWorkflow().entries[0];
    expect(entry.activity).toBe("running");
    expect(entry.issues).toEqual([expect.objectContaining({
      code: "power-bank-legacy-reinforcement-generation-missing",
      field: "reinforcement.generation",
    })]);
    expect(entry.authorities).toContainEqual({
      role: "workflow_owner",
      id: `${id}:reinforcement:legacy`,
      generation: undefined,
      component: "reinforcement",
    });
  });

  test("fails closed on invalid reinforcement indexes and non-increasing generations", () => {
    const missingIndexId = "pb-missing-index";
    const indexId = "pb-invalid-index";
    const indexConflictId = "pb-index-conflict";
    const generationId = "pb-generation-conflict";
    installPowerBankStore({
      [missingIndexId]: powerBankTask(missingIndexId, {
        activeGeneration: 0,
        activeIndex: 0,
        reinforcement: {
          generation: 1,
          stage: "spawning",
        },
      }),
      [indexId]: powerBankTask(indexId, {
        activeGeneration: 0,
        activeIndex: 0,
        reinforcement: {
          index: -1,
          generation: 1,
          stage: "spawning",
        },
      }),
      [indexConflictId]: powerBankTask(indexConflictId, {
        activeGeneration: 3,
        activeIndex: 1,
        reinforcement: {
          index: 1,
          generation: 4,
          stage: "attacking",
        },
      }),
      [generationId]: powerBankTask(generationId, {
        activeGeneration: 3,
        activeIndex: 0,
        reinforcement: {
          index: 1,
          generation: 3,
          stage: "attacking",
        },
      }),
    });

    const result = snapshotPowerBankWorkflow();
    const missingIndex = result.entries.find((entry) => entry.ref.localId === missingIndexId);
    expect(missingIndex?.activity).toBe("unknown");
    expect(missingIndex?.issues).toContainEqual(expect.objectContaining({
      code: "power-bank-invalid-reinforcement-index",
      field: "reinforcement.index",
    }));

    const invalidIndex = result.entries.find((entry) => entry.ref.localId === indexId);
    expect(invalidIndex?.activity).toBe("unknown");
    expect(invalidIndex?.issues).toContainEqual(expect.objectContaining({
      code: "power-bank-invalid-reinforcement-index",
      field: "reinforcement.index",
    }));

    const indexConflict = result.entries.find((entry) => entry.ref.localId === indexConflictId);
    expect(indexConflict?.activity).toBe("unknown");
    expect(indexConflict?.issues).toContainEqual(expect.objectContaining({
      code: "power-bank-reinforcement-index-conflict",
      field: "reinforcement.index",
    }));

    const conflict = result.entries.find((entry) => entry.ref.localId === generationId);
    expect(conflict?.activity).toBe("unknown");
    expect(conflict?.issues).toContainEqual(expect.objectContaining({
      code: "power-bank-reinforcement-generation-conflict",
      field: "reinforcement.generation",
    }));
  });

  test.each([
    "preparing_boosts",
    "spawning",
    "boosting",
    "renewing",
    "travelling",
    "attacking",
    "hauling",
    "complete",
  ])("fails closed when %s has no source room", (status) => {
    const id = `pb-no-source:${status}`;
    installPowerBankStore({
      [id]: powerBankTask(id, { status, sourceRoom: "" }),
    });

    const entry = snapshotPowerBankWorkflow().entries[0];
    expect(entry.activity).toBe("unknown");
    expect(entry.issues).toContainEqual(expect.objectContaining({
      code: "power-bank-source-room-required",
      field: "sourceRoom",
    }));
  });

  test.each([
    ["discovered", "available"],
    ["failed", "terminal"],
    ["aborted", "terminal"],
  ] as const)("allows an early %s workflow to omit source room", (status, activity) => {
    const id = `pb-early:${status}`;
    installPowerBankStore({
      [id]: powerBankTask(id, { status, sourceRoom: "" }),
    });

    const entry = snapshotPowerBankWorkflow().entries[0];
    expect(entry.activity).toBe(activity);
    expect(entry.issues).not.toContainEqual(expect.objectContaining({
      code: "power-bank-source-room-required",
    }));
  });

  test("fails closed when running work retains a terminal failReason", () => {
    const id = "pb-stale-fail-reason";
    installPowerBankStore({
      [id]: powerBankTask(id, {
        status: "attacking",
        failReason: "stale_terminal_reason",
      }),
    });

    const entry = snapshotPowerBankWorkflow().entries[0];
    expect(entry).toEqual(expect.objectContaining({
      activity: "unknown",
      sourceState: "attacking",
      blocker: "stale_terminal_reason",
      issues: [expect.objectContaining({
        code: "power-bank-stale-fail-reason",
        field: "failReason",
      })],
    }));
  });

  test("preserves blocker and hauling deadline while terminal active records stay distinct from history", () => {
    const haulingId = "bank:hauling";
    const failedId = "bank:failed";
    const history = [{
      taskId: "bank:history-only",
      status: "complete",
      terminalTick: 90,
    }];
    installPowerBankStore({
      [haulingId]: powerBankTask(haulingId, {
        status: "hauling",
        blocker: "waiting_haulers",
        nextAttemptAt: 140,
        bankExpiresAt: 200,
        haulingDeadlineAt: 800,
      }),
      [failedId]: powerBankTask(failedId, {
        status: "failed",
        failReason: "bank_expired",
        bankExpiresAt: 200,
        terminalTick: 201,
      }),
    }, history);

    const result = snapshotPowerBankWorkflow();
    const hauling = result.entries.find((entry) => entry.ref.localId === haulingId);
    expect(hauling).toEqual(expect.objectContaining({
      activity: "blocked",
      sourceState: "hauling",
      blocker: "waiting_haulers",
      retryAt: 140,
      deadlineAt: 800,
    }));

    const failed = result.entries.find((entry) => entry.ref.localId === failedId);
    expect(failed).toEqual(expect.objectContaining({
      activity: "terminal",
      sourceState: "failed",
      blocker: "bank_expired",
      deadlineAt: 200,
      issues: [expect.objectContaining({
        code: "power-bank-terminal-in-active-store",
        field: "status",
      })],
    }));
    expect(result.entries.some((entry) => entry.ref.localId === "bank:history-only")).toBe(false);
    expect((Memory.data as unknown as MutableRecord).powerBankHarvestHistory).toBe(history);
  });

  test("never promotes bounded history back into active work", () => {
    const history = Object.freeze([{ taskId: "bank:complete", status: "complete", terminalTick: 100 }]);
    const data = { powerBankHarvestHistory: history };
    Memory.data = data as unknown as NonNullable<Memory["data"]>;

    expect(powerBankWorkflowAdapter.snapshot(undefined)).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });
    expect(Memory.data).toBe(data);
    expect((Memory.data as unknown as MutableRecord).powerBankHarvestHistory).toBe(history);
  });

  test("fails closed on malformed and unknown active records while preserving key-proven refs", () => {
    installPowerBankStore({
      "pb-future": powerBankTask("pb-future", { status: "future" }),
      "pb-mismatch": powerBankTask("pb-mismatch", {
        id: "other-task",
      }),
      "pb-inherited": Object.create(powerBankTask("pb-inherited")),
      "pb-non-object": 42,
      "": powerBankTask("", { bankId: "bank-empty-key" }),
      "pb-missing-bank": powerBankTask("pb-missing-bank", { bankId: "" }),
    });

    const result = snapshotPowerBankWorkflow();
    expect(result.entries.map((entry) => entry.ref.localId)).toEqual([
      "pb-future",
      "pb-mismatch",
    ]);
    expect(result.entries.every((entry) => entry.activity === "unknown")).toBe(true);
    expect(result.entries.find((entry) => entry.ref.localId === "pb-future")?.issues).toContainEqual(
      expect.objectContaining({ code: "power-bank-unknown-status", field: "status" }),
    );
    expect(result.entries.find((entry) => entry.ref.localId === "pb-mismatch")).toEqual(
      expect.objectContaining({
        activity: "unknown",
        ref: {
          system: "power-bank-workflow",
          namespace: "powerBankHarvest",
          scope: { kind: "object", objectId: "object:pb-mismatch" },
          localId: "pb-mismatch",
        },
        issues: [expect.objectContaining({
          code: "power-bank-task-id-mismatch",
          field: "id",
        })],
      }),
    );
    expect(result.invalidCount).toBe(4);
    expect(result.issues.map((projectionIssue) => projectionIssue.code)).toEqual([
      "power-bank-unprojectable-identity",
      "power-bank-malformed-record",
      "power-bank-unprojectable-identity",
      "power-bank-unprojectable-identity",
    ]);
  });

  test("does not ensure missing stores and reports malformed data/store shapes", () => {
    expect(powerBankWorkflowAdapter.snapshot(undefined)).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });
    expect(Memory.data).toBeUndefined();

    (Memory as unknown as { data?: unknown }).data = [];
    expect(powerBankWorkflowAdapter.snapshot(undefined)).toEqual(expect.objectContaining({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({
        code: "power-bank-malformed-data",
        field: "Memory.data",
      })],
    }));

    installPowerBankStore([]);
    expect(powerBankWorkflowAdapter.snapshot(undefined)).toEqual(expect.objectContaining({
      entries: [],
      invalidCount: 1,
      issues: [expect.objectContaining({
        code: "power-bank-malformed-store",
        field: "Memory.data.powerBankHarvest",
      })],
    }));
  });

  test("returns deeply isolated output and leaves active/history source identities unchanged", () => {
    const id = "bank:isolated";
    const reinforcement = Object.freeze({
      index: 1,
      generation: 2,
      stage: "spawning",
      boostOwnerId: `${id}:reinforcement:g2`,
    });
    const sourceTask = Object.freeze(powerBankTask(id, {
      activeGeneration: 1,
      primaryBoostOwnerId: `${id}:primary:g1`,
      reinforcement,
    }));
    const store = Object.freeze({ [id]: sourceTask });
    const history = Object.freeze([{ taskId: "bank:old", status: "complete" }]);
    const data = { powerBankHarvest: store, powerBankHarvestHistory: history };
    Memory.data = data as unknown as NonNullable<Memory["data"]>;
    const before = JSON.stringify(data);

    const first = powerBankWorkflowAdapter.snapshot(undefined);
    const mutableEntry = first.entries[0] as any;
    mutableEntry.ref.scope.objectId = "changed";
    mutableEntry.authorities[0].id = "changed";
    mutableEntry.issues.push({ code: "changed", message: "changed" });

    expect(JSON.stringify(data)).toBe(before);
    expect(Memory.data).toBe(data);
    expect((Memory.data as unknown as MutableRecord).powerBankHarvest).toBe(store);
    expect((Memory.data as unknown as MutableRecord).powerBankHarvestHistory).toBe(history);
    expect(store[id]).toBe(sourceTask);
    expect(sourceTask.reinforcement).toBe(reinforcement);
    expect(powerBankWorkflowAdapter.snapshot(undefined).entries[0]).toEqual(expect.objectContaining({
      ref: expect.objectContaining({
        scope: { kind: "object", objectId: `object:${id}` },
      }),
      authorities: expect.arrayContaining([
        { role: "producer", id: "powerBankHarvest" },
      ]),
      issues: [],
    }));
  });
});
