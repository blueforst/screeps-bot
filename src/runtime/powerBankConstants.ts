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

export function getPowerBankConfigName(
  sourceRoom: string,
  targetRoom: string,
  role: PowerBankRole,
  index: number,
): string {
  return `${sourceRoom}:powerbank:${targetRoom}:${role}:${index}`;
}
