import { normalizeNumber } from "@/runtime/configNormalize";

export interface RoomEnergyPolicy {
  energyFloor: number;
  energyTarget: number;
  energyExportStart: number;
  terminalEnergyReserve: number;
}

const DEFAULT_ROOM_ENERGY_POLICY: RoomEnergyPolicy = {
  energyFloor: 120_000,
  energyTarget: 200_000,
  energyExportStart: 250_000,
  terminalEnergyReserve: 20_000,
};

export function resolveRoomEnergyPolicy(value: unknown): RoomEnergyPolicy {
  const raw = value && typeof value === "object"
    ? (value as Partial<RoomEnergyPolicy>)
    : {};
  const energyFloor = normalizeNumber(
    raw.energyFloor,
    DEFAULT_ROOM_ENERGY_POLICY.energyFloor,
    0,
    3_000_000,
  );
  const energyTarget = Math.max(
    energyFloor,
    normalizeNumber(
      raw.energyTarget,
      DEFAULT_ROOM_ENERGY_POLICY.energyTarget,
      0,
      3_000_000,
    ),
  );
  const energyExportStart = Math.max(
    energyTarget,
    normalizeNumber(
      raw.energyExportStart,
      DEFAULT_ROOM_ENERGY_POLICY.energyExportStart,
      0,
      3_000_000,
    ),
  );

  return {
    energyFloor,
    energyTarget,
    energyExportStart,
    terminalEnergyReserve: normalizeNumber(
      raw.terminalEnergyReserve,
      DEFAULT_ROOM_ENERGY_POLICY.terminalEnergyReserve,
      0,
      300_000,
    ),
  };
}
