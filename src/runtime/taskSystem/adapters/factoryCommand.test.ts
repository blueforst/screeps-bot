import factoryCommandAdapter from "@/runtime/taskSystem/adapters/factoryCommand";

function command(
  id: string,
  roomName: string,
  status: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const terminalFields = status === "done"
    ? { remainingBatteryAmount: 0, completedAt: 20 }
    : status === "cancelled" || status === "failed"
      ? { completedAt: 20 }
      : {};
  return {
    id,
    roomName,
    type: "decompress_battery",
    status,
    requestedBatteryAmount: 100,
    remainingBatteryAmount: 50,
    producedEnergyAmount: 500,
    createdAt: 10,
    updatedAt: 20,
    ...terminalFields,
    ...overrides,
  };
}

describe("factoryCommandAdapter", () => {
  test.each([
    ["pending", "available"],
    ["loading", "running"],
    ["producing", "running"],
    ["unloading", "running"],
    ["done", "terminal"],
    ["cancelled", "terminal"],
  ] as const)("maps %s to %s without replacing sourceState", (status, activity) => {
    const id = `factory:${status}`;
    const result = factoryCommandAdapter.snapshot({
      tasks: { [id]: command(id, "E4N58", status) },
    });

    expect(result).toEqual({
      entries: [expect.objectContaining({
        ref: {
          system: "factory-command",
          namespace: "factoryControl",
          scope: { kind: "room", roomName: "E4N58" },
          localId: id,
        },
        activity,
        sourceState: status,
        authorities: [
          { role: "workflow_owner", id: "factoryControl" },
          { role: "executor", id: "factoryControl" },
        ],
        createdAt: 10,
        updatedAt: 20,
        issues: [],
      })],
      invalidCount: 0,
      issues: [],
    });
  });

  test("keeps failed terminal while exposing the market-protection ambiguity", () => {
    const id = "factory:failed";
    const result = factoryCommandAdapter.snapshot({
      tasks: {
        [id]: command(id, "E4N58", "failed", {
          lastError: "produce_-10",
        }),
      },
    });

    expect(result.entries[0]).toEqual(expect.objectContaining({
      activity: "terminal",
      sourceState: "failed",
      blocker: "produce_-10",
      issues: [{
        code: "factory-failed-protection-ambiguous",
        message: expect.stringContaining("market-sale protection"),
        field: "status",
      }],
    }));
    expect(result.entries[0].retryAt).toBeUndefined();
    expect(result.entries[0].deadlineAt).toBeUndefined();
  });

  test.each([
    "pending",
    "loading",
    "producing",
    "unloading",
  ])("does not infer a current blocker from active %s with a retained lastError", (status) => {
    const id = `factory:blocked:${status}`;
    const result = factoryCommandAdapter.snapshot({
      tasks: {
        [id]: command(id, "E4N58", status, {
          lastError: "no_battery_source",
        }),
      },
    });

    const entry = result.entries[0];
    expect(entry).toEqual(expect.objectContaining({
      activity: status === "pending" ? "available" : "running",
      sourceState: status,
    }));
    expect(entry).not.toHaveProperty("blocker");
    expect(entry.issues).toContainEqual(expect.objectContaining({
      code: "factory-active-last-error-ambiguous",
    }));
  });

  test.each(["done", "cancelled", "failed"])(
    "keeps terminal %s terminal when lastError is present",
    (status) => {
      const id = `factory:terminal:${status}`;
      const result = factoryCommandAdapter.snapshot({
        tasks: {
          [id]: command(id, "E4N58", status, { lastError: "writer_error" }),
        },
      });

      expect(result.entries[0]).toEqual(expect.objectContaining({
        activity: "terminal",
        sourceState: status,
        blocker: "writer_error",
      }));
    },
  );

  test.each([
    ["done with remaining work", "done", { remainingBatteryAmount: 50 }, "factory-command-done-remaining-conflict"],
    ["done without completedAt", "done", { completedAt: undefined }, "factory-command-completed-at-required"],
    ["cancelled without completedAt", "cancelled", { completedAt: undefined }, "factory-command-completed-at-required"],
    ["failed without completedAt", "failed", { completedAt: undefined }, "factory-command-completed-at-required"],
    ["active with completedAt", "loading", { completedAt: 25 }, "factory-command-active-completed-at-conflict"],
    ["completion after latest update", "done", { completedAt: 21 }, "factory-command-timestamp-conflict"],
  ] as const)("fails closed for %s", (_label, status, overrides, issueCode) => {
    const id = `factory:conflict:${status}:${issueCode}`;
    const result = factoryCommandAdapter.snapshot({
      tasks: { [id]: command(id, "E4N58", status, overrides) },
    });

    expect(result.entries[0].activity).toBe("unknown");
    expect(result.entries[0].sourceState).toBe(status);
    expect(result.entries[0].issues.map((issue) => issue.code)).toContain(issueCode);
  });

  test("projects exact writer-shaped pending, blocked, done, and failed records", () => {
    const writerRecords = {
      "factory_task:E4N58:decompress_battery:100": {
        id: "factory_task:E4N58:decompress_battery:100",
        roomName: "E4N58",
        type: "decompress_battery",
        status: "pending",
        requestedBatteryAmount: 100,
        remainingBatteryAmount: 100,
        producedEnergyAmount: 0,
        createdAt: 100,
        updatedAt: 100,
      },
      "factory_task:E5N58:decompress_battery:100": {
        id: "factory_task:E5N58:decompress_battery:100",
        roomName: "E5N58",
        type: "decompress_battery",
        status: "loading",
        requestedBatteryAmount: 100,
        remainingBatteryAmount: 100,
        producedEnergyAmount: 0,
        createdAt: 100,
        updatedAt: 101,
        lastError: "no_battery_source",
      },
      "factory_task:E6N58:decompress_battery:100": {
        id: "factory_task:E6N58:decompress_battery:100",
        roomName: "E6N58",
        type: "decompress_battery",
        status: "done",
        requestedBatteryAmount: 100,
        remainingBatteryAmount: 0,
        producedEnergyAmount: 1000,
        createdAt: 100,
        updatedAt: 102,
        completedAt: 102,
      },
      "factory_task:E7N58:decompress_battery:100": {
        id: "factory_task:E7N58:decompress_battery:100",
        roomName: "E7N58",
        type: "decompress_battery",
        status: "failed",
        requestedBatteryAmount: 100,
        remainingBatteryAmount: 50,
        producedEnergyAmount: 500,
        createdAt: 100,
        updatedAt: 103,
        completedAt: 103,
        lastError: "produce_-10",
      },
    };

    const result = factoryCommandAdapter.snapshot({ tasks: writerRecords });
    const byRoom = Object.fromEntries(result.entries.map((entry) => [
      entry.ref.scope.kind === "room" ? entry.ref.scope.roomName : "",
      entry,
    ]));

    expect(byRoom.E4N58.activity).toBe("available");
    expect(byRoom.E5N58.activity).toBe("running");
    expect(byRoom.E5N58.blocker).toBeUndefined();
    expect(byRoom.E5N58.issues.map((issue) => issue.code)).toEqual([
      "factory-active-last-error-ambiguous",
    ]);
    expect(byRoom.E6N58.activity).toBe("terminal");
    expect(byRoom.E7N58.activity).toBe("terminal");
    expect(byRoom.E7N58.issues.map((issue) => issue.code)).toEqual([
      "factory-failed-protection-ambiguous",
    ]);
  });

  test("uses the store key for a provable ref and fails closed on malformed domain fields", () => {
    const result = factoryCommandAdapter.snapshot({
      tasks: {
        "command:known": command("command:other", "E4N58", "constructor", {
          requestedBatteryAmount: 10,
          remainingBatteryAmount: 20,
          updatedAt: 5,
        }),
        "command:no-room": { id: "command:no-room", status: "pending" },
        "command:not-object": 1,
      },
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].ref.localId).toBe("command:known");
    expect(result.entries[0].activity).toBe("unknown");
    expect(result.entries[0].sourceState).toBe("constructor");
    expect(result.entries[0].issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "factory-command-id-mismatch",
      "factory-command-status-invalid",
      "factory-command-amount-conflict",
      "factory-command-timestamp-conflict",
    ]));
    expect(result.invalidCount).toBe(2);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "factory-command-room-invalid",
      "factory-command-record-malformed",
    ]);
  });

  test("reads missing stores without ensure or migration and returns isolated output", () => {
    expect(factoryCommandAdapter.snapshot({})).toEqual({
      entries: [],
      invalidCount: 0,
      issues: [],
    });

    const id = "factory:pending";
    const sourceTask = command(id, "E4N58", "pending");
    const source = Object.freeze({ [id]: Object.freeze(sourceTask) });
    const before = JSON.parse(JSON.stringify(source));
    const first = factoryCommandAdapter.snapshot({ tasks: source });

    const mutableEntry = first.entries[0] as any;
    mutableEntry.ref.scope.roomName = "changed";
    mutableEntry.authorities[0].id = "changed";
    mutableEntry.issues.push({ code: "changed", message: "changed" });

    expect(source).toEqual(before);
    expect(factoryCommandAdapter.snapshot({ tasks: source }).entries[0]).toEqual(
      expect.objectContaining({
        ref: expect.objectContaining({
          scope: { kind: "room", roomName: "E4N58" },
        }),
        authorities: [
          { role: "workflow_owner", id: "factoryControl" },
          { role: "executor", id: "factoryControl" },
        ],
        issues: [],
      }),
    );
  });

  test("reports malformed store shape without mutating it", () => {
    const source = Object.freeze([command("factory:pending", "E4N58", "pending")]);

    expect(factoryCommandAdapter.snapshot({ tasks: source })).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [{
        code: "factory-command-source-malformed",
        message: expect.any(String),
        field: "tasks",
      }],
    });
    expect(source).toHaveLength(1);
  });
});
