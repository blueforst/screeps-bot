const RESERVATION_TTL = 12;

type PickupTargetKind = "resource" | "structure";
type PickupTarget = Resource | AnyStoreStructure;

interface PickupReservationClaim {
  amount: number;
  until: number;
}

interface PickupTargetReservation {
  kind: PickupTargetKind;
  claims: Record<string, PickupReservationClaim>;
}

function getTargetKind(target: PickupTarget): PickupTargetKind {
  return (target as Resource).amount !== undefined ? "resource" : "structure";
}

export function getPickupTargetEnergyAmount(target: PickupTarget): number {
  if ((target as Resource).amount !== undefined) {
    return (target as Resource).amount;
  }

  return (target as AnyStoreStructure).store.getUsedCapacity(RESOURCE_ENERGY);
}

function ensureRoomReservationStore(roomName: string): Record<string, PickupTargetReservation> {
  Memory.rooms = Memory.rooms || {};
  Memory.rooms[roomName] = Memory.rooms[roomName] || {};
  const roomMemory = Memory.rooms[roomName] as RoomMemory;
  roomMemory.pickupReservations = roomMemory.pickupReservations || {};
  return roomMemory.pickupReservations;
}

function cleanupClaims(entry: PickupTargetReservation): void {
  for (const [creepName, claim] of Object.entries(entry.claims)) {
    if (claim.until < Game.time || !Game.creeps[creepName]) {
      delete entry.claims[creepName];
    }
  }
}

function ensureReservationEntry(
  roomName: string,
  targetId: string,
  kind: PickupTargetKind,
): PickupTargetReservation {
  const store = ensureRoomReservationStore(roomName);
  let entry = store[targetId];
  if (!entry || entry.kind !== kind) {
    entry = {
      kind,
      claims: {},
    };
    store[targetId] = entry;
  }
  cleanupClaims(entry);
  return entry;
}

function clearTargetEntryIfEmpty(roomName: string, targetId: string): void {
  const roomStore = Memory.rooms?.[roomName]?.pickupReservations;
  if (!roomStore) {
    return;
  }

  const entry = roomStore[targetId];
  if (!entry) {
    return;
  }

  if (Object.keys(entry.claims).length === 0) {
    delete roomStore[targetId];
  }
}

export function clearPickupReservationTargetMemory(creep: Creep): void {
  delete creep.memory.energyPickupTargetId;
  delete creep.memory.energyPickupTargetKind;
}

export function releasePickupReservation(creep: Creep, targetId?: string): void {
  const roomStore = Memory.rooms?.[creep.room.name]?.pickupReservations as
    | Record<string, PickupTargetReservation>
    | undefined;
  if (roomStore) {
    if (targetId) {
      const entry = roomStore[targetId];
      if (entry?.claims[creep.name]) {
        delete entry.claims[creep.name];
        clearTargetEntryIfEmpty(creep.room.name, targetId);
      }
    } else {
      for (const [id, entry] of Object.entries(roomStore)) {
        if (entry.claims[creep.name]) {
          delete entry.claims[creep.name];
          clearTargetEntryIfEmpty(creep.room.name, id);
        }
      }
    }
  }

  clearPickupReservationTargetMemory(creep);
}

function setReservedTargetMemory(creep: Creep, target: PickupTarget): void {
  creep.memory.energyPickupTargetId = target.id;
  creep.memory.energyPickupTargetKind = getTargetKind(target);
}

export function reservePickupTarget(creep: Creep, target: PickupTarget, desiredAmount: number): boolean {
  const available = getPickupTargetEnergyAmount(target);
  if (available <= 0) {
    return false;
  }

  const targetKind = getTargetKind(target);
  const entry = ensureReservationEntry(creep.room.name, target.id, targetKind);

  let reservedByOthers = 0;
  for (const [creepName, claim] of Object.entries(entry.claims)) {
    if (creepName !== creep.name) {
      reservedByOthers += claim.amount;
    }
  }

  const availableForThisCreep = Math.max(0, available - reservedByOthers);
  const wanted = Math.max(0, desiredAmount);
  const claimAmount = Math.min(wanted, availableForThisCreep);
  if (claimAmount <= 0) {
    return false;
  }

  entry.claims[creep.name] = {
    amount: claimAmount,
    until: Game.time + RESERVATION_TTL,
  };
  setReservedTargetMemory(creep, target);
  return true;
}

export function getReservedPickupTarget(creep: Creep): PickupTarget | null {
  const targetId = creep.memory.energyPickupTargetId;
  const targetKind = creep.memory.energyPickupTargetKind;
  if (!targetId || !targetKind) {
    return null;
  }

  let target: PickupTarget | null = null;
  if (targetKind === "resource") {
    target = Game.getObjectById(targetId as Id<Resource>);
  } else {
    target = Game.getObjectById(targetId as Id<AnyStoreStructure>);
  }

  if (!target || getPickupTargetEnergyAmount(target) <= 0) {
    releasePickupReservation(creep, targetId);
    return null;
  }

  return target;
}
