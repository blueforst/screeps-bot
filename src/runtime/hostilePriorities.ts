export function getBoundaryDefensePriority(hostile: Creep): number {
  return (
    hostile.getActiveBodyparts(WORK) * 5 +
    hostile.getActiveBodyparts(RANGED_ATTACK) * 4 +
    hostile.getActiveBodyparts(ATTACK) * 4 +
    hostile.getActiveBodyparts(HEAL)
  );
}

export function getInsideDefensePriority(hostile: Creep): number {
  return (
    hostile.getActiveBodyparts(HEAL) * 5 +
    hostile.getActiveBodyparts(WORK) * 4 +
    hostile.getActiveBodyparts(RANGED_ATTACK) * 3 +
    hostile.getActiveBodyparts(ATTACK) * 3
  );
}

export function chooseInsideBurstTarget(hostiles: Creep[]): Creep | null {
  let best: Creep | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const hostile of hostiles) {
    const score = getInsideDefensePriority(hostile) * 100 - hostile.hits * 0.1;
    if (score > bestScore) {
      best = hostile;
      bestScore = score;
    }
  }

  return best;
}

export function chooseBoundaryBurstEngagement(
  hostiles: Creep[],
  ramparts: StructureRampart[],
  occupiedRampartIds?: Set<Id<StructureRampart>>,
): { hostile: Creep; rampart: StructureRampart } | null {
  let bestHostile: Creep | null = null;
  let bestRampart: StructureRampart | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const hostile of hostiles) {
    let closestRampart: StructureRampart | null = null;
    let closestRange = Infinity;
    let closestFreeRampart: StructureRampart | null = null;
    let closestFreeRange = Infinity;

    for (const rampart of ramparts) {
      const range = rampart.pos.getRangeTo(hostile.pos);
      if (range < closestRange) {
        closestRange = range;
        closestRampart = rampart;
      }

       if (!occupiedRampartIds?.has(rampart.id) && range < closestFreeRange) {
         closestFreeRange = range;
         closestFreeRampart = rampart;
       }
    }

    const chosenRampart = closestFreeRampart || closestRampart;
    const chosenRange = closestFreeRampart ? closestFreeRange : closestRange;
    if (!chosenRampart) continue;

    const score = getBoundaryDefensePriority(hostile) - chosenRange * 100;
    if (score > bestScore) {
      bestScore = score;
      bestHostile = hostile;
      bestRampart = chosenRampart;
    }
  }

  if (!bestHostile || !bestRampart) return null;
  return { hostile: bestHostile, rampart: bestRampart };
}
