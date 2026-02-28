export type CrossShardTravelerKind = "claimer" | "harvester" | "worker";

export interface CrossShardTravelerNameParts {
  targetShard: string;
  targetRoom: string;
  portalRoom: string;
  destinationRoom?: string;
  nonce: string;
}

export interface DecodedCrossShardTravelerName extends CrossShardTravelerNameParts {
  kind: CrossShardTravelerKind;
}

const ROOM_PATTERN = "[WE]\\d+[NS]\\d+";
const SHARD_PATTERN = "[A-Za-z0-9-]+";
const NONCE_PATTERN = "[A-Za-z0-9]+";

const PREFIX_BY_KIND: Record<CrossShardTravelerKind, string> = {
  claimer: "xshc",
  harvester: "xshh",
  worker: "xshw",
};

const KIND_BY_PREFIX = Object.entries(PREFIX_BY_KIND).reduce((acc, [kind, prefix]) => {
  acc[prefix] = kind as CrossShardTravelerKind;
  return acc;
}, {} as Record<string, CrossShardTravelerKind>);

const encodedRegex = new RegExp(
  `^(${Object.values(PREFIX_BY_KIND).join("|")})-(${SHARD_PATTERN})-(${ROOM_PATTERN})-(${ROOM_PATTERN})-(${ROOM_PATTERN}|X)-(${NONCE_PATTERN})$`,
);

export function encodeCrossShardTravelerName(
  kind: CrossShardTravelerKind,
  parts: CrossShardTravelerNameParts,
): string {
  const prefix = PREFIX_BY_KIND[kind];
  const destinationRoom = parts.destinationRoom || "X";
  return `${prefix}-${parts.targetShard}-${parts.targetRoom}-${parts.portalRoom}-${destinationRoom}-${parts.nonce}`;
}

export function decodeCrossShardTravelerName(name: string): DecodedCrossShardTravelerName | null {
  const match = encodedRegex.exec(name);
  if (!match) {
    return null;
  }

  const kind = KIND_BY_PREFIX[match[1]];
  if (!kind) {
    return null;
  }

  return {
    kind,
    targetShard: match[2],
    targetRoom: match[3],
    portalRoom: match[4],
    destinationRoom: match[5] === "X" ? undefined : match[5],
    nonce: match[6],
  };
}
