import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

export interface ReceiverCapacityRoomView {
  roomName: string;
  storageFreeCapacity: number;
  terminalFreeCapacity: number;
  getTerminalResourceFreeCapacity(resource: ResourceConstant): number;
}

export type ReceiverCapacityExclusionReason =
  | "missing_receiver"
  | "invalid_endpoint"
  | "unhealthy_commitment";

export interface ReceiverCapacityLedgerOptions {
  receivers: Iterable<ReceiverCapacityRoomView>;
  tasks: Iterable<ResourceTransferTask>;
  storageSafetyReserve: number;
  terminalSafetyReserve: number;
  isTaskEndpointValid(task: ResourceTransferTask): boolean;
  isTaskHealthy(task: ResourceTransferTask): boolean;
}

export interface ReceiverCapacityAvailability {
  roomName: string;
  resource: ResourceConstant;
  storageSafeCapacity: number;
  terminalTotalSafeCapacity: number;
  terminalResourceFreeCapacity: number;
  totalCommitted: number;
  resourceCommitted: number;
  reservationTotal: number;
  reservationResource: number;
  ownedReservationTotal: number;
  ownedReservationResource: number;
  excludedTaskAmount: number;
  storageRemaining: number;
  terminalTotalRemaining: number;
  terminalResourceRemaining: number;
  available: number;
}

export interface ReceiverCapacityReservationOptions {
  /**
   * Associates this allocation with an existing task commitment. Owned
   * reservations are sub-allocations of that commitment and therefore do not
   * consume receiver headroom a second time.
   */
  ownerTaskId?: string;
  /** Temporarily returns this task's commitment while calculating the grant. */
  excludeTaskId?: string;
  /** Allows a critical shipment to use real terminal headroom below safety reserves. */
  allowTerminalSafetyReserve?: boolean;
}

export interface ReceiverCapacityExclusionSummaryEntry {
  taskCount: number;
  amount: number;
}

interface ReceiverState {
  view: ReceiverCapacityRoomView;
  storageSafeCapacity: number;
  terminalTotalSafeCapacity: number;
  receivedAmount: number;
  initialTerminalResourceFree: Map<ResourceConstant, number>;
}

interface CapacityEntry {
  id: string;
  roomName: string;
  resource: ResourceConstant;
  amount: number;
  ownerTaskId?: string;
}

interface ExcludedTaskEntry {
  reason: ReceiverCapacityExclusionReason;
  amount: number;
}

function roomResourceKey(roomName: string, resource: ResourceConstant): string {
  return `${roomName}\u0000${resource}`;
}

function normalizedAmount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function addIndexedAmount(index: Map<string, number>, key: string, delta: number): void {
  const next = Math.max(0, (index.get(key) || 0) + delta);
  if (next > 0) {
    index.set(key, next);
  } else {
    index.delete(key);
  }
}

export class ReceiverCapacityLedger {
  private readonly receivers = new Map<string, ReceiverState>();
  private readonly taskCommitments = new Map<string, CapacityEntry>();
  private readonly reservations = new Map<string, CapacityEntry>();
  private readonly taskTotalByRoom = new Map<string, number>();
  private readonly taskByRoomResource = new Map<string, number>();
  private readonly reservationTotalByRoom = new Map<string, number>();
  private readonly reservationByRoomResource = new Map<string, number>();
  private readonly ownedReservationTotalByRoom = new Map<string, number>();
  private readonly ownedReservationByRoomResource = new Map<string, number>();
  private readonly reservationIdsByOwnerTask = new Map<string, Set<string>>();
  private readonly excludedTasks = new Map<string, ExcludedTaskEntry>();

  public constructor(private readonly options: ReceiverCapacityLedgerOptions) {
    const storageSafetyReserve = normalizedAmount(options.storageSafetyReserve);
    const terminalSafetyReserve = normalizedAmount(options.terminalSafetyReserve);
    for (const view of options.receivers) {
      this.receivers.set(view.roomName, {
        view,
        storageSafeCapacity: Math.max(0, normalizedAmount(view.storageFreeCapacity) - storageSafetyReserve),
        terminalTotalSafeCapacity: Math.max(0, normalizedAmount(view.terminalFreeCapacity) - terminalSafetyReserve),
        receivedAmount: 0,
        initialTerminalResourceFree: new Map<ResourceConstant, number>(),
      });
    }
    for (const task of options.tasks) {
      this.syncTask(task);
    }
  }

  public getAvailableAmount(
    roomName: string,
    resource: ResourceConstant,
    excludeTaskId?: string,
  ): number {
    return this.getAvailability(roomName, resource, excludeTaskId).available;
  }

  public getTerminalAvailableAmount(
    roomName: string,
    resource: ResourceConstant,
    excludeTaskId?: string,
  ): number {
    const receiver = this.receivers.get(roomName);
    if (!receiver) return 0;

    const availability = this.getAvailability(roomName, resource, excludeTaskId);
    const terminalTotalFreeCapacity = Math.max(
      0,
      normalizedAmount(receiver.view.terminalFreeCapacity) - receiver.receivedAmount,
    );
    const terminalTotalRemaining = Math.max(
      0,
      terminalTotalFreeCapacity
        - availability.totalCommitted
        - availability.reservationTotal,
    );
    return Math.min(terminalTotalRemaining, availability.terminalResourceRemaining);
  }

  public getAvailability(
    roomName: string,
    resource: ResourceConstant,
    excludeTaskId?: string,
  ): ReceiverCapacityAvailability {
    const receiver = this.receivers.get(roomName);
    if (!receiver) {
      return {
        roomName,
        resource,
        storageSafeCapacity: 0,
        terminalTotalSafeCapacity: 0,
        terminalResourceFreeCapacity: 0,
        totalCommitted: 0,
        resourceCommitted: 0,
        reservationTotal: 0,
        reservationResource: 0,
        ownedReservationTotal: 0,
        ownedReservationResource: 0,
        excludedTaskAmount: 0,
        storageRemaining: 0,
        terminalTotalRemaining: 0,
        terminalResourceRemaining: 0,
        available: 0,
      };
    }

    const resourceKey = roomResourceKey(roomName, resource);
    const taskTotal = this.taskTotalByRoom.get(roomName) || 0;
    const taskResource = this.taskByRoomResource.get(resourceKey) || 0;
    const reservationTotal = this.reservationTotalByRoom.get(roomName) || 0;
    const reservationResource = this.reservationByRoomResource.get(resourceKey) || 0;
    const ownedReservationTotal = this.ownedReservationTotalByRoom.get(roomName) || 0;
    const ownedReservationResource = this.ownedReservationByRoomResource.get(resourceKey) || 0;
    const excludedTask = excludeTaskId ? this.taskCommitments.get(excludeTaskId) : undefined;
    const excludedReservation = excludeTaskId ? this.reservations.get(excludeTaskId) : undefined;
    const excludedTaskAmount = excludedTask?.roomName === roomName ? excludedTask.amount : 0;
    const excludedTaskResourceAmount = excludedTask?.roomName === roomName && excludedTask.resource === resource
      ? excludedTask.amount
      : 0;
    const excludedReservationAmount =
      excludedReservation?.ownerTaskId === undefined && excludedReservation?.roomName === roomName
        ? excludedReservation.amount
        : 0;
    const excludedReservationResourceAmount =
      excludedReservation?.ownerTaskId === undefined &&
      excludedReservation?.roomName === roomName &&
      excludedReservation.resource === resource
        ? excludedReservation.amount
        : 0;
    const effectiveTaskTotal = Math.max(0, taskTotal - excludedTaskAmount);
    const effectiveTaskResource = Math.max(0, taskResource - excludedTaskResourceAmount);
    const effectiveReservationTotal = Math.max(0, reservationTotal - excludedReservationAmount);
    const effectiveReservationResource = Math.max(0, reservationResource - excludedReservationResourceAmount);
    let initialResourceFree = receiver.initialTerminalResourceFree.get(resource);
    if (initialResourceFree === undefined) {
      initialResourceFree = normalizedAmount(receiver.view.getTerminalResourceFreeCapacity(resource));
      receiver.initialTerminalResourceFree.set(resource, initialResourceFree);
    }
    const terminalResourceFreeCapacity = Math.max(0, initialResourceFree - receiver.receivedAmount);
    const storageRemaining = Math.max(
      0,
      receiver.storageSafeCapacity - effectiveTaskTotal - effectiveReservationTotal,
    );
    const terminalTotalRemaining = Math.max(
      0,
      receiver.terminalTotalSafeCapacity - effectiveTaskTotal - effectiveReservationTotal,
    );
    const terminalResourceRemaining = Math.max(
      0,
      terminalResourceFreeCapacity - effectiveTaskResource - effectiveReservationResource,
    );

    return {
      roomName,
      resource,
      storageSafeCapacity: receiver.storageSafeCapacity,
      terminalTotalSafeCapacity: receiver.terminalTotalSafeCapacity,
      terminalResourceFreeCapacity,
      totalCommitted: effectiveTaskTotal,
      resourceCommitted: effectiveTaskResource,
      reservationTotal: effectiveReservationTotal,
      reservationResource: effectiveReservationResource,
      ownedReservationTotal,
      ownedReservationResource,
      excludedTaskAmount,
      storageRemaining,
      terminalTotalRemaining,
      terminalResourceRemaining,
      available: Math.min(storageRemaining, terminalTotalRemaining, terminalResourceRemaining),
    };
  }

  public reserve(
    reservationId: string,
    roomName: string,
    resource: ResourceConstant,
    requestedAmount: number,
    optionsValue?: ReceiverCapacityReservationOptions | string,
  ): number {
    const options = typeof optionsValue === "string"
      ? { excludeTaskId: optionsValue }
      : optionsValue || {};
    const requested = normalizedAmount(requestedAmount);
    const existing = this.reservations.get(reservationId);
    if (existing) {
      this.removeReservation(existing);
    }
    if (requested <= 0) {
      return 0;
    }

    const ownerTaskId = options.ownerTaskId;
    const getAvailable = (excludeTaskId?: string): number =>
      options.allowTerminalSafetyReserve
        ? this.getTerminalAvailableAmount(roomName, resource, excludeTaskId)
        : this.getAvailableAmount(roomName, resource, excludeTaskId);
    let amount: number;
    if (ownerTaskId) {
      const commitment = this.taskCommitments.get(ownerTaskId);
      if (
        !commitment ||
        commitment.roomName !== roomName ||
        commitment.resource !== resource
      ) {
        return 0;
      }
      const otherOwnedAmount = this.getOwnedReservationAmount(ownerTaskId);
      const selfExcludedAvailable = getAvailable(ownerTaskId);
      amount = Math.min(
        requested,
        Math.max(0, commitment.amount - otherOwnedAmount),
        Math.max(0, selfExcludedAvailable - otherOwnedAmount),
      );
    } else {
      amount = Math.min(
        requested,
        getAvailable(options.excludeTaskId),
      );
    }
    if (amount <= 0) {
      return 0;
    }
    this.addReservation({ id: reservationId, roomName, resource, amount, ownerTaskId });
    return amount;
  }

  public registerTask(task: ResourceTransferTask): void {
    this.syncTask(task);
  }

  public syncTask(task: ResourceTransferTask): void {
    this.removeTaskCommitment(task.id);
    this.excludedTasks.delete(task.id);

    const amount = normalizedAmount(task.remainingAmount);
    if (amount <= 0) {
      this.releaseReservationsOwnedBy(task.id);
      this.releaseProvisionalReservation(task.id);
      return;
    }
    const receiver = this.receivers.get(task.toRoomName);
    if (!receiver) {
      this.releaseReservationsOwnedBy(task.id);
      this.releaseProvisionalReservation(task.id);
      this.excludedTasks.set(task.id, { reason: "missing_receiver", amount });
      return;
    }
    if (!this.options.isTaskEndpointValid(task)) {
      this.releaseReservationsOwnedBy(task.id);
      this.releaseProvisionalReservation(task.id);
      this.excludedTasks.set(task.id, { reason: "invalid_endpoint", amount });
      return;
    }
    if (!this.options.isTaskHealthy(task)) {
      this.releaseReservationsOwnedBy(task.id);
      this.releaseProvisionalReservation(task.id);
      this.excludedTasks.set(task.id, { reason: "unhealthy_commitment", amount });
      return;
    }
    const entry = {
      id: task.id,
      roomName: task.toRoomName,
      resource: task.resource,
      amount,
    };
    this.addTaskCommitment(entry);

    const sameIdReservation = this.reservations.get(task.id);
    if (sameIdReservation && !sameIdReservation.ownerTaskId) {
      const provisionalAmount = sameIdReservation.amount;
      this.reserve(task.id, entry.roomName, entry.resource, provisionalAmount, {
        ownerTaskId: task.id,
      });
    }
    this.clampReservationsOwnedBy(task.id);
  }

  public releaseTask(taskId: string): void {
    this.removeTaskCommitment(taskId);
    this.releaseReservationsOwnedBy(taskId);
    this.releaseProvisionalReservation(taskId);
    this.excludedTasks.delete(taskId);
  }

  public applySend(
    roomName: string,
    resource: ResourceConstant,
    amountValue: number,
    taskId?: string,
  ): void {
    const amount = normalizedAmount(amountValue);
    if (amount <= 0) return;

    const receiver = this.receivers.get(roomName);
    if (receiver) {
      receiver.storageSafeCapacity = Math.max(0, receiver.storageSafeCapacity - amount);
      receiver.terminalTotalSafeCapacity = Math.max(0, receiver.terminalTotalSafeCapacity - amount);
      receiver.receivedAmount += amount;
    }

    if (!taskId) return;
    const commitment = this.taskCommitments.get(taskId);
    if (commitment?.roomName === roomName && commitment.resource === resource) {
      this.removeTaskCommitment(taskId);
      const remaining = Math.max(0, commitment.amount - amount);
      if (remaining > 0) {
        const next = { ...commitment, amount: remaining };
        this.addTaskCommitment(next);
      }
      this.consumeOwnedReservations(taskId, roomName, resource, amount);
    }
  }

  public getExclusionSummary(): Partial<
    Record<ReceiverCapacityExclusionReason, ReceiverCapacityExclusionSummaryEntry>
  > {
    const summary: Partial<Record<ReceiverCapacityExclusionReason, ReceiverCapacityExclusionSummaryEntry>> = {};
    for (const entry of this.excludedTasks.values()) {
      const aggregate = summary[entry.reason] || { taskCount: 0, amount: 0 };
      aggregate.taskCount += 1;
      aggregate.amount += entry.amount;
      summary[entry.reason] = aggregate;
    }
    return summary;
  }

  private addTaskCommitment(entry: CapacityEntry): void {
    this.taskCommitments.set(entry.id, entry);
    addIndexedAmount(this.taskTotalByRoom, entry.roomName, entry.amount);
    addIndexedAmount(
      this.taskByRoomResource,
      roomResourceKey(entry.roomName, entry.resource),
      entry.amount,
    );
  }

  private removeTaskCommitment(taskId: string): void {
    const commitment = this.taskCommitments.get(taskId);
    if (!commitment) return;
    this.taskCommitments.delete(taskId);
    addIndexedAmount(this.taskTotalByRoom, commitment.roomName, -commitment.amount);
    addIndexedAmount(
      this.taskByRoomResource,
      roomResourceKey(commitment.roomName, commitment.resource),
      -commitment.amount,
    );
  }

  private addReservation(entry: CapacityEntry): void {
    this.reservations.set(entry.id, entry);
    const resourceKey = roomResourceKey(entry.roomName, entry.resource);
    if (entry.ownerTaskId) {
      addIndexedAmount(this.ownedReservationTotalByRoom, entry.roomName, entry.amount);
      addIndexedAmount(this.ownedReservationByRoomResource, resourceKey, entry.amount);
      const ids = this.reservationIdsByOwnerTask.get(entry.ownerTaskId) || new Set<string>();
      ids.add(entry.id);
      this.reservationIdsByOwnerTask.set(entry.ownerTaskId, ids);
      return;
    }
    addIndexedAmount(this.reservationTotalByRoom, entry.roomName, entry.amount);
    addIndexedAmount(this.reservationByRoomResource, resourceKey, entry.amount);
  }

  private removeReservation(entry: CapacityEntry): void {
    this.reservations.delete(entry.id);
    const resourceKey = roomResourceKey(entry.roomName, entry.resource);
    if (entry.ownerTaskId) {
      addIndexedAmount(this.ownedReservationTotalByRoom, entry.roomName, -entry.amount);
      addIndexedAmount(this.ownedReservationByRoomResource, resourceKey, -entry.amount);
      const ids = this.reservationIdsByOwnerTask.get(entry.ownerTaskId);
      ids?.delete(entry.id);
      if (ids?.size === 0) {
        this.reservationIdsByOwnerTask.delete(entry.ownerTaskId);
      }
      return;
    }
    addIndexedAmount(this.reservationTotalByRoom, entry.roomName, -entry.amount);
    addIndexedAmount(
      this.reservationByRoomResource,
      resourceKey,
      -entry.amount,
    );
  }

  private resizeReservation(entry: CapacityEntry, amountValue: number): void {
    const amount = normalizedAmount(amountValue);
    this.removeReservation(entry);
    if (amount > 0) {
      this.addReservation({ ...entry, amount });
    }
  }

  private getOwnedReservationAmount(ownerTaskId: string): number {
    let total = 0;
    for (const reservationId of this.reservationIdsByOwnerTask.get(ownerTaskId) || []) {
      total += this.reservations.get(reservationId)?.amount || 0;
    }
    return total;
  }

  private releaseReservationsOwnedBy(ownerTaskId: string): void {
    const reservationIds = [...(this.reservationIdsByOwnerTask.get(ownerTaskId) || [])];
    for (const reservationId of reservationIds) {
      const reservation = this.reservations.get(reservationId);
      if (reservation) this.removeReservation(reservation);
    }
  }

  private releaseProvisionalReservation(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (reservation && !reservation.ownerTaskId) {
      this.removeReservation(reservation);
    }
  }

  private clampReservationsOwnedBy(ownerTaskId: string): void {
    const commitment = this.taskCommitments.get(ownerTaskId);
    if (!commitment) {
      this.releaseReservationsOwnedBy(ownerTaskId);
      return;
    }
    let remainingGrant = Math.min(
      commitment.amount,
      this.getAvailableAmount(commitment.roomName, commitment.resource, ownerTaskId),
    );
    const reservationIds = [...(this.reservationIdsByOwnerTask.get(ownerTaskId) || [])];
    for (const reservationId of reservationIds) {
      const reservation = this.reservations.get(reservationId);
      if (!reservation) continue;
      if (
        reservation.roomName !== commitment.roomName ||
        reservation.resource !== commitment.resource
      ) {
        this.removeReservation(reservation);
        continue;
      }
      const amount = Math.min(reservation.amount, remainingGrant);
      remainingGrant -= amount;
      if (amount !== reservation.amount) {
        this.resizeReservation(reservation, amount);
      }
    }
  }

  private consumeOwnedReservations(
    ownerTaskId: string,
    roomName: string,
    resource: ResourceConstant,
    amountValue: number,
  ): void {
    let remaining = normalizedAmount(amountValue);
    const reservationIds = [...(this.reservationIdsByOwnerTask.get(ownerTaskId) || [])];
    for (const reservationId of reservationIds) {
      if (remaining <= 0) break;
      const reservation = this.reservations.get(reservationId);
      if (
        !reservation ||
        reservation.roomName !== roomName ||
        reservation.resource !== resource
      ) {
        continue;
      }
      const consumed = Math.min(remaining, reservation.amount);
      remaining -= consumed;
      this.resizeReservation(reservation, reservation.amount - consumed);
    }
  }
}

export function createReceiverCapacityLedger(
  options: ReceiverCapacityLedgerOptions,
): ReceiverCapacityLedger {
  return new ReceiverCapacityLedger(options);
}
