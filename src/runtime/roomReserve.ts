/**
 * Reserve mode: room produces no workers.
 * Activate by placing a flag named RESERVE_<roomName> anywhere,
 * or a flag named RESERVE placed inside the target room.
 * Remove the flag to deactivate.
 */
export function isRoomInReserveMode(roomName: string): boolean {
  if (Game.flags[`RESERVE_${roomName}`]) return true;
  const generic = Game.flags["RESERVE"];
  return !!generic && generic.pos.roomName === roomName;
}
