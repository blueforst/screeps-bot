import { POWER_BANK_PATROL_ROOMS } from "@/runtime/powerBankConstants";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";

const OBSERVER_RANGE = 10;

interface PowerBankObserverRuntime {
  patrolIndex: number;
  updatedAt: number;
  lastObservedRooms: string[];
  coveredRooms: string[];
}

function getRuntimeState(): PowerBankObserverRuntime {
  const runtime = getMemoryService().ensureRuntime() as NonNullable<Memory["runtime"]> & {
    powerBankObserver?: PowerBankObserverRuntime;
  };
  if (!runtime.powerBankObserver) {
    runtime.powerBankObserver = {
      patrolIndex: 0,
      updatedAt: Game.time,
      lastObservedRooms: [],
      coveredRooms: [],
    };
  }

  return runtime.powerBankObserver;
}

function getActiveObservers(): StructureObserver[] {
  const observers: StructureObserver[] = [];
  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    const context = tickContext.getRoomContext(room);
    const roomObservers = context?.getMyStructures().filter(
      (structure): structure is StructureObserver =>
        structure.structureType === STRUCTURE_OBSERVER &&
        (typeof structure.isActive !== "function" || structure.isActive()),
    ) ?? [];
    observers.push(...roomObservers);
  }

  return observers;
}

function canObserve(observer: StructureObserver, roomName: string): boolean {
  return Game.map.getRoomLinearDistance(observer.room.name, roomName) <= OBSERVER_RANGE;
}

function scanVisiblePatrolRooms(): void {
  for (const roomName of POWER_BANK_PATROL_ROOMS) {
    const room = Game.rooms[roomName];
    if (!room) continue;

    const banks = room.find(FIND_STRUCTURES).filter(
      (structure): structure is StructurePowerBank => structure.structureType === STRUCTURE_POWER_BANK,
    );
    for (const bank of banks) {
      recordPowerBankDiscovery(bank);
    }
  }
}

function getCoveredPatrolRooms(observers: StructureObserver[]): string[] {
  return POWER_BANK_PATROL_ROOMS.filter((roomName) =>
    observers.some((observer) => canObserve(observer, roomName)),
  );
}

function selectNextRoom(observer: StructureObserver, assignedRooms: Set<string>, startIndex: number): string | null {
  for (let offset = 0; offset < POWER_BANK_PATROL_ROOMS.length; offset += 1) {
    const roomName = POWER_BANK_PATROL_ROOMS[(startIndex + offset) % POWER_BANK_PATROL_ROOMS.length];
    if (assignedRooms.has(roomName)) continue;
    if (!canObserve(observer, roomName)) continue;
    return roomName;
  }

  return null;
}

function scheduleNextObservations(observers: StructureObserver[], state: PowerBankObserverRuntime): void {
  const assignedRooms = new Set<string>();
  const observedRooms: string[] = [];
  let nextIndex = state.patrolIndex;

  for (const observer of observers) {
    const roomName = selectNextRoom(observer, assignedRooms, nextIndex);
    if (!roomName) continue;

    if (observer.observeRoom(roomName) === OK) {
      assignedRooms.add(roomName);
      observedRooms.push(roomName);
      nextIndex = (POWER_BANK_PATROL_ROOMS.indexOf(roomName) + 1) % POWER_BANK_PATROL_ROOMS.length;
    }
  }

  state.patrolIndex = nextIndex;
  state.lastObservedRooms = observedRooms;
}

export function hasPowerBankObserverCoverage(): boolean {
  if (POWER_BANK_PATROL_ROOMS.length === 0) return false;
  const observers = getActiveObservers();
  if (observers.length === 0) return false;

  const coveredRooms = getCoveredPatrolRooms(observers);
  return coveredRooms.length === POWER_BANK_PATROL_ROOMS.length;
}

export function runPowerBankObserver(): void {
  scanVisiblePatrolRooms();

  const observers = getActiveObservers();
  const state = getRuntimeState();
  state.updatedAt = Game.time;
  state.coveredRooms = getCoveredPatrolRooms(observers);

  if (observers.length === 0) {
    state.lastObservedRooms = [];
    return;
  }

  scheduleNextObservations(observers, state);
}
