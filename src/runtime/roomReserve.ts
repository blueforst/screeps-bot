export function isRoomInReserveMode(roomName: string): boolean {
  for (const flag of Object.values(Game.flags)) {
    if ((flag.name === "RESERVE" || flag.name.startsWith("RESERVE_")) && flag.pos.roomName === roomName) {
      return true;
    }
  }
  return false;
}
