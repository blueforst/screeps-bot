import { getDefaultHubConfig, getDefaultHubRuntime } from "@/runtime/hubPlanner";

export function runHubByFlag(): void {
  const flag = Game.flags["HUB"];
  if (!flag) return;

  const roomName = flag.pos.roomName;
  const room = Game.rooms[roomName];

  if (!room || !room.controller?.my) {
    Memory.runtime ??= {};
    Memory.runtime.hub ??= getDefaultHubRuntime();
    Memory.runtime.hub.status = "blocked";
    return;
  }

  const existingHubRoom = Memory.cfg?.hub?.hubRoomName;
  if (existingHubRoom && existingHubRoom !== "" && existingHubRoom !== roomName) {
    Memory.runtime ??= {};
    Memory.runtime.hub ??= getDefaultHubRuntime();
    Memory.runtime.hub.status = "blocked";
    return;
  }

  const defaults = getDefaultHubConfig();
  const existing = Memory.cfg?.hub ?? {};

  Memory.cfg ??= {};
  Memory.cfg.hub = {
    enabled: true,
    hubRoomName: roomName,
    planInterval: existing.planInterval ?? defaults.planInterval,
    reservePerRoom: existing.reservePerRoom ?? defaults.reservePerRoom,
    hubReservePerCompound: existing.hubReservePerCompound ?? defaults.hubReservePerCompound,
    targetCompounds: existing.targetCompounds ?? defaults.targetCompounds,
    storagePauseFreeCapacity: existing.storagePauseFreeCapacity ?? defaults.storagePauseFreeCapacity,
    surplusThreshold: existing.surplusThreshold ?? defaults.surplusThreshold,
    internalOnly: existing.internalOnly ?? defaults.internalOnly,
  };

  Memory.runtime ??= {};
  Memory.runtime.hub = {
    ...getDefaultHubRuntime(),
    needsPlan: true,
  };

  flag.remove();
}
