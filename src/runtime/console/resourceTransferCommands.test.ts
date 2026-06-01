import { addResourceTransferTasksRaw } from "@/runtime/console/resourceTransferCommands";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

describe("addResourceTransferTasksRaw", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("creates a batch of manual transfer tasks from one source room", () => {
    const result = addResourceTransferTasksRaw(
      "W1N1",
      [
        ["W2N1", RESOURCE_HYDROGEN, 100],
        { toRoomName: "W3N1", resource: RESOURCE_KEANIUM, amount: 250, reason: "manual:k" },
      ],
      "manual:default",
    );

    expect(result).toEqual({
      ok: true,
      fromRoomName: "W1N1",
      created: [
        expect.objectContaining({
          fromRoomName: "W1N1",
          toRoomName: "W2N1",
          resource: RESOURCE_HYDROGEN,
          amount: 100,
          reason: "manual:default",
        }),
        expect.objectContaining({
          fromRoomName: "W1N1",
          toRoomName: "W3N1",
          resource: RESOURCE_KEANIUM,
          amount: 250,
          reason: "manual:k",
        }),
      ],
      errors: [],
    });
    expect(Object.values(ensureResourceTransferTaskStore())).toHaveLength(2);
  });

  it("reports invalid requests without blocking valid ones", () => {
    const result = addResourceTransferTasksRaw("W1N1", [
      ["W2N1", RESOURCE_HYDROGEN, 100],
      ["W3N1", RESOURCE_KEANIUM, 0],
    ]);

    expect(result).toEqual({
      ok: true,
      fromRoomName: "W1N1",
      created: [expect.objectContaining({ resource: RESOURCE_HYDROGEN, amount: 100 })],
      errors: [
        expect.objectContaining({
          index: 1,
          error: "ERR_INVALID_AMOUNT",
        }),
      ],
    });
    expect(Object.values(ensureResourceTransferTaskStore())).toHaveLength(1);
  });
});
