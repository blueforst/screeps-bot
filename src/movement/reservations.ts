import { getPosKey, isExitTile } from "@/movement/common";

interface TileReservation {
  creepName: string;
  roomName: string;
  x: number;
  y: number;
  until: number;
}

const TILE_RESERVATION_TTL = 5;
const tileReservationsByPos = new Map<string, TileReservation>();
const tileReservationByCreep = new Map<string, string>();

function pruneExpiredReservations(): void {
  for (const [posKey, reservation] of tileReservationsByPos.entries()) {
    if (reservation.until <= Game.time) {
      tileReservationsByPos.delete(posKey);
      if (tileReservationByCreep.get(reservation.creepName) === posKey) {
        tileReservationByCreep.delete(reservation.creepName);
      }
    }
  }
}

export function reserveNextTile(creep: Creep, pos: RoomPosition): boolean {
  pruneExpiredReservations();
  if (isExitTile(pos)) {
    return true;
  }

  const posKey = getPosKey(pos);
  const current = tileReservationsByPos.get(posKey);
  if (current && current.creepName !== creep.name && current.until > Game.time) {
    return false;
  }

  releaseTileReservation(creep.name);
  tileReservationsByPos.set(posKey, {
    creepName: creep.name,
    roomName: pos.roomName,
    x: pos.x,
    y: pos.y,
    until: Game.time + TILE_RESERVATION_TTL,
  });
  tileReservationByCreep.set(creep.name, posKey);
  return true;
}

export function releaseTileReservation(creepOrName: Creep | string): void {
  pruneExpiredReservations();
  const creepName = typeof creepOrName === "string" ? creepOrName : creepOrName.name;
  const posKey = tileReservationByCreep.get(creepName);
  if (!posKey) {
    return;
  }

  tileReservationByCreep.delete(creepName);
  const current = tileReservationsByPos.get(posKey);
  if (current?.creepName === creepName) {
    tileReservationsByPos.delete(posKey);
  }
}

export function isTileReserved(pos: RoomPosition, excludeCreepName?: string): boolean {
  pruneExpiredReservations();
  const current = tileReservationsByPos.get(getPosKey(pos));
  if (!current) {
    return false;
  }
  return current.creepName !== excludeCreepName;
}

export function clearTileReservationsForTest(): void {
  tileReservationsByPos.clear();
  tileReservationByCreep.clear();
}
