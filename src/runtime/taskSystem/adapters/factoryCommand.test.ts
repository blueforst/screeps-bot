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
  test("maps every lifecycle state while preserving identity and authorities", () => {
    for (const [status, activity] of [
      ["pending", "available"],
      ["loading", "running"],
      ["producing", "running"],
      ["unloading", "running"],
      ["done", "terminal"],
      ["cancelled", "terminal"],
    ] as const) {
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
    }
  });

  test("projects writer-shaped active and terminal records without inventing blockers", () => {
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

  test("fails closed for lifecycle conflicts while preserving key-proven refs", () => {
    for (const [status, overrides, issueCode] of [
      ["done", { remainingBatteryAmount: 50 }, "factory-command-done-remaining-conflict"],
      ["done", { completedAt: undefined }, "factory-command-completed-at-required"],
      ["cancelled", { completedAt: undefined }, "factory-command-completed-at-required"],
      ["failed", { completedAt: undefined }, "factory-command-completed-at-required"],
      ["loading", { completedAt: 25 }, "factory-command-active-completed-at-conflict"],
      ["done", { completedAt: 21 }, "factory-command-timestamp-conflict"],
    ] as const) {
      const id = `factory:conflict:${status}:${issueCode}`;
      const result = factoryCommandAdapter.snapshot({
        tasks: { [id]: command(id, "E4N58", status, overrides) },
      });
      expect(result.entries[0].activity).toBe("unknown");
      expect(result.entries[0].sourceState).toBe(status);
      expect(result.entries[0].issues.map((issue) => issue.code)).toContain(issueCode);
    }

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

  test("does not ensure or mutate missing, malformed, or valid source stores", () => {
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
    const malformedSource = Object.freeze([command("factory:pending", "E4N58", "pending")]);

    expect(factoryCommandAdapter.snapshot({ tasks: malformedSource })).toEqual({
      entries: [],
      invalidCount: 1,
      issues: [{
        code: "factory-command-source-malformed",
        message: expect.any(String),
        field: "tasks",
      }],
    });
    expect(malformedSource).toHaveLength(1);
  });
});
