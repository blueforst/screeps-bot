import type { CreepConfig } from "@/types/system";

export type SourceWorkforceRole = "harvester" | "miner" | "mineralHarvester";
export type SlotWorkforceRole = "carrier" | "worker";
export type RoomWorkforceRole = SourceWorkforceRole | SlotWorkforceRole;

export type RoomWorkforceConfigIdentity =
  | {
      readonly roomName: string;
      readonly role: SourceWorkforceRole;
      readonly discriminator: string;
    }
  | {
      readonly roomName: string;
      readonly role: SlotWorkforceRole;
      readonly discriminator: number;
    };

const ROOM_NAME_PATTERN = /^(?:sim|[WE]\d+[NS]\d+)$/;
const CANONICAL_SLOT_PATTERN = /^(?:0|[1-9]\d*)$/;
const SOURCE_WORKFORCE_ROLES = new Set<SourceWorkforceRole>([
  "harvester",
  "miner",
  "mineralHarvester",
]);
const SLOT_WORKFORCE_ROLES = new Set<SlotWorkforceRole>(["carrier", "worker"]);

function isSourceWorkforceRole(value: string): value is SourceWorkforceRole {
  return SOURCE_WORKFORCE_ROLES.has(value as SourceWorkforceRole);
}

function isSlotWorkforceRole(value: string): value is SlotWorkforceRole {
  return SLOT_WORKFORCE_ROLES.has(value as SlotWorkforceRole);
}

function assertCanonicalRoomName(roomName: string): void {
  if (!ROOM_NAME_PATTERN.test(roomName)) {
    throw new Error(`Invalid workforce room name: ${roomName}`);
  }
}

function assertSourceDiscriminator(discriminator: string): void {
  if (discriminator.length === 0 || discriminator.includes(":")) {
    throw new Error(`Invalid workforce source discriminator: ${discriminator}`);
  }
}

function assertSlotDiscriminator(discriminator: number): void {
  if (!Number.isSafeInteger(discriminator) || discriminator < 0) {
    throw new Error(`Invalid workforce slot discriminator: ${discriminator}`);
  }
}

export function formatRoomWorkforceConfigName(
  roomName: string,
  role: SourceWorkforceRole,
  discriminator: string,
): string;
export function formatRoomWorkforceConfigName(
  roomName: string,
  role: SlotWorkforceRole,
  discriminator: number,
): string;
export function formatRoomWorkforceConfigName(
  roomName: string,
  role: RoomWorkforceRole,
  discriminator: string | number,
): string;
export function formatRoomWorkforceConfigName(
  roomName: string,
  role: RoomWorkforceRole,
  discriminator: string | number,
): string {
  assertCanonicalRoomName(roomName);

  if (isSourceWorkforceRole(role)) {
    if (typeof discriminator !== "string") {
      throw new Error(`Invalid ${role} discriminator type`);
    }
    assertSourceDiscriminator(discriminator);
    return `${roomName}:${role}:${discriminator}`;
  }

  if (typeof discriminator !== "number") {
    throw new Error(`Invalid ${role} discriminator type`);
  }
  assertSlotDiscriminator(discriminator);
  return `${roomName}:${role}:${discriminator}`;
}

export function parseRoomWorkforceConfigIdentity(
  configName: string,
): RoomWorkforceConfigIdentity | undefined {
  const parts = configName.split(":");
  if (parts.length !== 3) {
    return undefined;
  }

  const [roomName, role, rawDiscriminator] = parts;
  if (!ROOM_NAME_PATTERN.test(roomName)) {
    return undefined;
  }

  if (isSourceWorkforceRole(role)) {
    if (rawDiscriminator.length === 0) {
      return undefined;
    }
    return { roomName, role, discriminator: rawDiscriminator };
  }

  if (!isSlotWorkforceRole(role) || !CANONICAL_SLOT_PATTERN.test(rawDiscriminator)) {
    return undefined;
  }

  const discriminator = Number(rawDiscriminator);
  if (!Number.isSafeInteger(discriminator)) {
    return undefined;
  }
  return { roomName, role, discriminator };
}

export function getOwnedRoomWorkforceConfigIdentity(
  configName: string,
  config: CreepConfig,
): RoomWorkforceConfigIdentity | undefined {
  const identity = parseRoomWorkforceConfigIdentity(configName);
  if (!identity || config.role !== identity.role) {
    return undefined;
  }

  if (config.roomName !== undefined && config.roomName !== identity.roomName) {
    return undefined;
  }

  if (!Array.isArray(config.args)) {
    return undefined;
  }

  if (isSourceWorkforceRole(identity.role)) {
    return config.args.length === 1 && config.args[0] === identity.discriminator
      ? identity
      : undefined;
  }

  return config.args.length === 0 ? identity : undefined;
}
