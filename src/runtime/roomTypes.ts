import type { RoomType } from "@/types/system";

export const DEFAULT_ROOM_TYPE: RoomType = "normal";
export const ROOM_TYPES: readonly RoomType[] = ["normal", "reserved", "industrial"];

export function isRoomType(value: unknown): value is RoomType {
  return typeof value === "string" && (ROOM_TYPES as readonly string[]).includes(value);
}

export function getRoomType(roomName: string): RoomType {
  const configuredType = Memory.cfg?.rooms?.[roomName]?.type;
  return isRoomType(configuredType) ? configuredType : DEFAULT_ROOM_TYPE;
}

export function isOwnedRoomType(roomType: RoomType): boolean {
  return roomType === "normal" || roomType === "industrial";
}

export function isOwnedManagedRoom(roomName: string): boolean {
  return isOwnedRoomType(getRoomType(roomName));
}
