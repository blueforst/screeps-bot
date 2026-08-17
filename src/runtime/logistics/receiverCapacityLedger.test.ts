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

  it("keeps owned reservations inside one task commitment throughout the send lifecycle", () => {
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
      ownedReservationTotal: 20_000,
      ownedReservationResource: 20_000,
      available: 30_000,
    });
    expect(ledger.getAvailability("W1N2", RESOURCE_KEANIUM, task.id)).toMatchObject({
      totalCommitted: 0,
      resourceCommitted: 0,
      excludedTaskAmount: 20_000,
      ownedReservationTotal: 20_000,
      ownedReservationResource: 20_000,
      available: 50_000,
    });

    expect(
      ledger.reserve(task.id, "W1N2", RESOURCE_KEANIUM, 20_000, {
        ownerTaskId: task.id,
      }),
    ).toBe(20_000);
    ledger.applySend("W1N2", RESOURCE_KEANIUM, 10_000, task.id);
    expect(ledger.getAvailability("W1N2", RESOURCE_KEANIUM)).toMatchObject({
      storageSafeCapacity: 40_000,
      terminalTotalSafeCapacity: 40_000,
      terminalResourceFreeCapacity: 60_000,
      totalCommitted: 10_000,
      resourceCommitted: 10_000,
      reservationTotal: 0,
      ownedReservationTotal: 10_000,
      ownedReservationResource: 10_000,
      available: 30_000,
    });
    expect(ledger.getAvailableAmount("W1N2", RESOURCE_KEANIUM, task.id)).toBe(40_000);

    task.blockedReason = "receiver_capacity";
    ledger.syncTask(task);
    expect(ledger.getAvailability("W1N2", RESOURCE_KEANIUM)).toMatchObject({
      totalCommitted: 0,
      reservationTotal: 0,
      ownedReservationTotal: 0,
      available: 40_000,
    });

    ledger.releaseTask(task.id);
    expect(ledger.getAvailableAmount("W1N2", RESOURCE_KEANIUM)).toBe(40_000);
  });

  it("limits new reservations to the 20000 left after a healthy 30000 commitment", () => {
    const committed = createTask("committed", RESOURCE_KEANIUM, 30_000);
    const ledger = createLedger([committed]);

    expect(
      ledger.reserve("draft-a", "W1N2", RESOURCE_HYDROGEN, 15_000),
    ).toBe(15_000);
    expect(
      ledger.reserve("draft-b", "W1N2", RESOURCE_HYDROGEN, 15_000),
    ).toBe(5_000);
    expect(
      ledger.reserve("draft-c", "W1N2", RESOURCE_HYDROGEN, 1),
    ).toBe(0);
    expect(ledger.getAvailability("W1N2", RESOURCE_HYDROGEN)).toMatchObject({
      totalCommitted: 30_000,
      reservationTotal: 20_000,
      available: 0,
    });
  });
});
