// ---------------------------------------------------------------------------
// Body tier definitions per RCL
// ---------------------------------------------------------------------------

export interface PowerBankBodyTier {
  attacker: BodyPartConstant[];
  healer: BodyPartConstant[];
}

/** RCL 6: attacker cost 2190 (38 parts), healer cost 2100 (14 parts) */
export const POWER_BANK_BODY_RCL6: PowerBankBodyTier = {
  attacker: [
    TOUGH, TOUGH, TOUGH, TOUGH,
    ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
    MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
  ],
  healer: [
    HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL,
    MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
  ],
};

/** RCL 7: attacker cost 2320 (40 parts), healer cost 2100 (14 parts) */
export const POWER_BANK_BODY_RCL7: PowerBankBodyTier = {
  attacker: [
    TOUGH, TOUGH, TOUGH, TOUGH,
    ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
    MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
  ],
  healer: [
    HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL,
    MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
  ],
};

/** RCL 8: attacker cost 2320 (40 parts), healer cost 7500 (50 parts) */
export const POWER_BANK_BODY_RCL8: PowerBankBodyTier = {
  attacker: [
    TOUGH, TOUGH, TOUGH, TOUGH,
    ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
    MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
  ],
  healer: [
    HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL,
    MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
  ],
};

export const POWER_BANK_BODY_TIERS: Record<number, PowerBankBodyTier> = {
  6: POWER_BANK_BODY_RCL6,
  7: POWER_BANK_BODY_RCL7,
  8: POWER_BANK_BODY_RCL8,
};

// ---------------------------------------------------------------------------
// Patrol rooms — highway rooms where power banks can spawn
// ---------------------------------------------------------------------------

export const POWER_BANK_PATROL_ROOMS: string[] = [
  "E0N60", "E1N60", "E2N60", "E3N60", "E4N60",
  "E5N60", "E6N60", "E7N60", "E8N60", "E9N60",
];

export function isPowerBankPatrolRoom(roomName: string): boolean {
  return POWER_BANK_PATROL_ROOMS.includes(roomName);
}

// ---------------------------------------------------------------------------
// Task status constants
// ---------------------------------------------------------------------------

export const POWER_BANK_STATUS = {
  DISCOVERED: "discovered",
  PREPARING_BOOSTS: "preparing_boosts",
  SPAWNING: "spawning",
  BOOSTING: "boosting",
  RENEWING: "renewing",
  TRAVELLING: "travelling",
  ATTACKING: "attacking",
  HAULING: "hauling",
  COMPLETE: "complete",
  FAILED: "failed",
  ABORTED: "aborted",
} as const;

// ---------------------------------------------------------------------------
// Boost requirements per tier
// ---------------------------------------------------------------------------

export const POWER_BANK_BOOST_REQUIREMENTS: Record<number, {
  attacker: ResourceConstant[];
  healer: ResourceConstant[];
}> = {
  6: {
    attacker: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE, RESOURCE_CATALYZED_UTRIUM_ACID],
    healer: [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE],
  },
  7: {
    attacker: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE, RESOURCE_CATALYZED_UTRIUM_ACID],
    healer: [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE],
  },
  8: {
    attacker: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE, RESOURCE_CATALYZED_UTRIUM_ACID],
    healer: [], // RCL8 healer is unboosted (25 heal + 25 move)
  },
};

// ---------------------------------------------------------------------------
// Config naming helper
// ---------------------------------------------------------------------------

export type PowerBankRole = "scout" | "attacker" | "healer" | "hauler";

/**
 * Produce a compact deterministic owner token without persisting the full task
 * id in every config name.  FNV-1a keeps the implementation available in the
 * Screeps runtime while the full task id remains the authoritative owner in
 * config/creep memory.
 */
export function getPowerBankTaskToken(taskId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < taskId.length; index += 1) {
    hash ^= taskId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36).padStart(7, "0");
}

export function getPowerBankConfigName(
  sourceRoom: string,
  targetRoom: string,
  role: PowerBankRole,
  index: number,
  taskId?: string,
  generation?: number,
): string {
  const legacyName = `${sourceRoom}:powerbank:${targetRoom}:${role}:${index}`;
  if (taskId === undefined) {
    return legacyName;
  }

  const normalizedGeneration = generation !== undefined && Number.isFinite(generation) && generation >= 0
    ? Math.floor(generation)
    : 0;
  return `${legacyName}:owner:${getPowerBankTaskToken(taskId)}:g${normalizedGeneration}`;
}
