/**
 * Safe zone computation for home defense.
 * The safe zone is the set of tiles enclosed by (and including) the planned rampart ring.
 * Computed via flood fill from spawn positions in the room planner layout.
 * Results are cached in the heap and invalidated when the layout's savedAt changes.
 */

const safeZoneCache = new Map<string, { savedAt: number; zone: Set<number> }>();

const FLOOD_FILL_NEIGHBORS: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

function computeSafeZone(
  roomName: string,
  rampartPositions: { x: number; y: number }[],
  spawnPositions: { x: number; y: number }[],
): Set<number> {
  if (spawnPositions.length === 0) return new Set();

  const terrain = Game.map.getRoomTerrain(roomName);
  const rampartSet = new Set(rampartPositions.map((p) => p.x * 50 + p.y));
  const safeZone = new Set<number>();
  const visited = new Set<number>();
  const queue: number[] = spawnPositions.map((p) => p.x * 50 + p.y);

  while (queue.length > 0) {
    const encoded = queue.shift()!;
    if (visited.has(encoded)) continue;
    visited.add(encoded);

    const x = Math.floor(encoded / 50);
    const y = encoded % 50;

    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

    safeZone.add(encoded);

    // Rampart tiles are the boundary: include in safe zone but do not expand through them.
    if (rampartSet.has(encoded)) continue;

    for (const [dx, dy] of FLOOD_FILL_NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
      const next = nx * 50 + ny;
      if (!visited.has(next)) queue.push(next);
    }
  }

  return safeZone;
}

export function getSafeZone(roomName: string): Set<number> {
  const plannerData = Memory.data?.roomPlanner?.[roomName];
  if (!plannerData) return new Set();

  const cached = safeZoneCache.get(roomName);
  if (cached?.savedAt === plannerData.savedAt) {
    return cached.zone;
  }

  const rampartPositions = plannerData.layout[STRUCTURE_RAMPART] ?? [];
  const spawnPositions = plannerData.layout[STRUCTURE_SPAWN] ?? [];
  const zone = computeSafeZone(roomName, rampartPositions, spawnPositions);
  safeZoneCache.set(roomName, { savedAt: plannerData.savedAt, zone });
  return zone;
}
