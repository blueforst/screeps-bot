import {
  clearCarrierTaskBoardForTest,
  type CarrierTaskBoardSnapshot,
} from "@/runtime/carrierTaskBoard";
import carrierLogisticsAdapter from "@/runtime/taskSystem/adapters/carrierLogistics";

function step(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    resource: RESOURCE_ENERGY,
    fromKind: "storage",
    toKind: "terminal",
    fromId: `${id}:from`,
    toId: `${id}:to`,
    amount: 100,
    ...overrides,
  };
}

function task(
  id: string,
  producer: string,
  roomName: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    producer,
    roomName,
    type: "terminal_feed",
    priority: 100,
    steps: [step(`${id}:step`)],
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function ref(
  namespace: string,
  localId: string,
  roomName = "W1N1",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    system: "carrier-logistics",
    namespace,
    scope: { kind: "room", roomName },
    localId,
    ...overrides,
  };
}

function readEntry(
  namespace: string,
  localId: string,
  roomName = "W1N1",
  taskOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ref: ref(namespace, localId, roomName),
    task: task(localId, namespace, roomName, taskOverrides),
  };
}

function asBoard(value: unknown): CarrierTaskBoardSnapshot {
  return value as CarrierTaskBoardSnapshot;
}

describe("carrierLogisticsAdapter", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    Game.time = 100;
  });

  test("uses explicit refs and canonically projects equal localIds across producers", () => {
    const board = asBoard({
      W1N1: [
        readEntry("producer:z->owner", "shared:id", "W1N1", {
          dispatchClass: "capacity_relief",
          steps: [
            step("step:z", { resource: RESOURCE_HYDROGEN, amount: 25 }),
            step("step:a", { amount: 50 }),
          ],
        }),
        readEntry("producer:a:owner", "shared:id"),
      ],
    });

    const result = carrierLogisticsAdapter.snapshot({ board });

    expect(result.invalidCount).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.entries.map((entry) => [
      entry.ref.namespace,
      entry.ref.localId,
    ])).toEqual([
      ["producer:a:owner", "shared:id"],
      ["producer:z->owner", "shared:id"],
    ]);

    const projected = result.entries[1];
    expect(projected).toEqual(expect.objectContaining({
      ref: {
        system: "carrier-logistics",
        namespace: "producer:z->owner",
        scope: { kind: "room", roomName: "W1N1" },
        localId: "shared:id",
      },
      activity: "available",
      sourceState: "published",
      authorities: [{ role: "producer", id: "producer:z->owner" }],
      createdAt: 10,
      updatedAt: 20,
      taskType: "terminal_feed",
      priority: 100,
      dispatchClass: "capacity_relief",
      issues: [],
    }));
    expect(projected.facts).toEqual([
      expect.objectContaining({ kind: "transport", stepId: "step:a", amount: 50 }),
      expect.objectContaining({ kind: "transport", stepId: "step:z", amount: 25 }),
    ]);
    expect(projected).not.toHaveProperty("progress");
    expect(projected).not.toHaveProperty("completedAt");
    expect(projected).not.toHaveProperty("deadlineAt");
  });

  test("fails closed for unknown resources without losing legal facts or siblings", () => {
    const result = carrierLogisticsAdapter.snapshot({
      board: asBoard({
        W1N1: [
          readEntry("producer", "mixed", "W1N1", {
            steps: [
              step("unknown-resource", {
                resource: "definitely-not-a-screeps-resource",
              }),
              step("legal-step", { resource: RESOURCE_HYDROGEN }),
            ],
          }),
          readEntry("producer", "legal", "W1N1", {
            steps: [step("legal-sibling", { resource: RESOURCE_ENERGY })],
          }),
        ],
      }),
    });

    expect(result.invalidCount).toBe(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.find((entry) => entry.ref.localId === "legal"))
      .toEqual(expect.objectContaining({
        activity: "available",
        facts: [expect.objectContaining({
          stepId: "legal-sibling",
          resource: RESOURCE_ENERGY,
        })],
        issues: [],
      }));
    expect(result.entries.find((entry) => entry.ref.localId === "mixed"))
      .toEqual(expect.objectContaining({
        activity: "unknown",
        facts: [expect.objectContaining({
          stepId: "legal-step",
          resource: RESOURCE_HYDROGEN,
        })],
        issues: [expect.objectContaining({
          code: "carrier-transport-step-resource-invalid",
          field: "steps.resource",
        })],
      }));
  });
});
