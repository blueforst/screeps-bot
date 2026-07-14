import {
  createReceiverCapacityLedger,
  type ReceiverCapacityRoomView,
} from "@/runtime/logistics/receiverCapacityLedger";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

function createTask(
  id: string,
  resource: ResourceConstant,
  remainingAmount: number,
  overrides: Partial<ResourceTransferTask> = {},
): ResourceTransferTask {
  return {
    id,
    resource,
    fromRoomName: "W1N1",
    toRoomName: "W1N2",
    amount: remainingAmount,
    remainingAmount,
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    origin: "manual",
    lastProgressAt: 1,
    ...overrides,
  };
}

function createReceiver(
  roomName = "W1N2",
  terminalResourceFree: Partial<Record<ResourceConstant, number>> = {},
): ReceiverCapacityRoomView {
  return {
    roomName,
    storageFreeCapacity: 150_000,
    terminalFreeCapacity: 90_000,
    getTerminalResourceFreeCapacity: (resource) => terminalResourceFree[resource] ?? 90_000,
  };
}

function createLedger(
  tasks: ResourceTransferTask[] = [],
  receivers: ReceiverCapacityRoomView[] = [
    createReceiver("W1N2", {
      [RESOURCE_KEANIUM]: 70_000,
      [RESOURCE_HYDROGEN]: 80_000,
    }),
  ],
) {
  return createReceiverCapacityLedger({
    receivers,
    tasks,
    storageSafetyReserve: 100_000,
    terminalSafetyReserve: 40_000,
    isTaskEndpointValid: (task) => task.fromRoomName === "W1N1" && task.toRoomName === "W1N2",
    isTaskHealthy: (task) => task.status === "pending" && task.blockedReason !== "receiver_capacity",
  });
}

describe("receiver capacity ledger", () => {
  it("shares total headroom across resources and excludes exactly the selected task", () => {
    const potassium = createTask("task-k", RESOURCE_KEANIUM, 30_000);
    const hydrogen = createTask("task-h", RESOURCE_HYDROGEN, 10_000);
    const ledger = createLedger([potassium, hydrogen]);

    expect(ledger.getAvailableAmount("W1N2", RESOURCE_KEANIUM)).toBe(10_000);
    expect(ledger.getAvailableAmount("W1N2", RESOURCE_KEANIUM, potassium.id)).toBe(40_000);
    expect(ledger.getAvailableAmount("W1N2", RESOURCE_HYDROGEN, hydrogen.id)).toBe(20_000);

    expect(ledger.getAvailability("W1N2", RESOURCE_KEANIUM, potassium.id)).toMatchObject({
      totalCommitted: 10_000,
      resourceCommitted: 0,
      excludedTaskAmount: 30_000,
      storageRemaining: 40_000,
      terminalTotalRemaining: 40_000,
      terminalResourceRemaining: 70_000,
      available: 40_000,
    });
  });

  it("keeps same-tick reservations idempotent and absorbs them when the task is registered", () => {
    const ledger = createLedger();

    expect(ledger.reserve("task-new", "W1N2", RESOURCE_KEANIUM, 20_000)).toBe(20_000);
    expect(ledger.reserve("task-new", "W1N2", RESOURCE_KEANIUM, 20_000)).toBe(20_000);
    expect(ledger.getAvailability("W1N2", RESOURCE_KEANIUM)).toMatchObject({
      reservationTotal: 20_000,
      reservationResource: 20_000,
      available: 30_000,
    });

    const task = createTask("task-new", RESOURCE_KEANIUM, 20_000);
    ledger.registerTask(task);
    expect(ledger.getAvailability("W1N2", RESOURCE_KEANIUM)).toMatchObject({
      totalCommitted: 20_000,
      resourceCommitted: 20_000,
      reservationTotal: 0,
      available: 30_000,
    });

    task.blockedReason = "receiver_capacity";
    ledger.syncTask(task);
    expect(ledger.getAvailableAmount("W1N2", RESOURCE_KEANIUM)).toBe(50_000);

    task.blockedReason = undefined;
    ledger.syncTask(task);
    expect(ledger.getAvailableAmount("W1N2", RESOURCE_KEANIUM)).toBe(30_000);

    ledger.releaseTask(task.id);
    expect(ledger.getAvailableAmount("W1N2", RESOURCE_KEANIUM)).toBe(50_000);
  });

  it("consumes physical capacity and the sending task commitment by the same amount", () => {
    const task = createTask("task-k", RESOURCE_KEANIUM, 20_000);
    const ledger = createLedger([task]);

    expect(ledger.getAvailableAmount("W1N2", RESOURCE_KEANIUM)).toBe(30_000);
    ledger.applySend("W1N2", RESOURCE_KEANIUM, 10_000, task.id);

    expect(ledger.getAvailability("W1N2", RESOURCE_KEANIUM)).toMatchObject({
      storageSafeCapacity: 40_000,
      terminalTotalSafeCapacity: 40_000,
      terminalResourceFreeCapacity: 60_000,
      totalCommitted: 10_000,
      resourceCommitted: 10_000,
      available: 30_000,
    });
    expect(ledger.getAvailableAmount("W1N2", RESOURCE_KEANIUM, task.id)).toBe(40_000);
  });

  it("does not count unhealthy or invalid-endpoint tasks and reports why they were excluded", () => {
    const blocked = createTask("blocked", RESOURCE_KEANIUM, 20_000, {
      blockedReason: "receiver_capacity",
    });
    const invalid = createTask("invalid", RESOURCE_HYDROGEN, 15_000, {
      fromRoomName: "W9N9",
    });
    const missingReceiver = createTask("missing", RESOURCE_OXYGEN, 12_000, {
      toRoomName: "W8N8",
    });
    const ledger = createLedger([blocked, invalid, missingReceiver]);

    expect(ledger.getAvailableAmount("W1N2", RESOURCE_KEANIUM)).toBe(50_000);
    expect(ledger.getExclusionSummary()).toEqual({
      unhealthy_commitment: { taskCount: 1, amount: 20_000 },
      invalid_endpoint: { taskCount: 1, amount: 15_000 },
      missing_receiver: { taskCount: 1, amount: 12_000 },
    });
  });

  it("does not turn an unfinished terminal offload draft into receiver capacity", () => {
    const receiver = createReceiver("W1N2", { [RESOURCE_KEANIUM]: 50_000 });
    receiver.terminalFreeCapacity = 50_000;
    const ledger = createLedger([], [receiver]);

    // Carrier offload intent is deliberately absent from the physical room view:
    // capacity only changes after an observed physical delta or applySend.
    expect(ledger.getAvailability("W1N2", RESOURCE_KEANIUM)).toMatchObject({
      storageSafeCapacity: 50_000,
      terminalTotalSafeCapacity: 10_000,
      terminalResourceFreeCapacity: 50_000,
      available: 10_000,
    });
  });
});
