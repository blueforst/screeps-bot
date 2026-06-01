/**
 * Canonical reaction lookup helpers shared between synthesisControl and hubPlanner.
 * All product→reagent mappings derive from the Screeps `REACTIONS` constant.
 */

/** Round `amount` up to the nearest `LAB_REACTION_AMOUNT` multiple. */
export function roundUpReactionAmount(amount: number): number {
  return Math.ceil(amount / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT;
}

let productReagentCache: Partial<Record<ResourceConstant, [ResourceConstant, ResourceConstant]>> | undefined;

/**
 * Returns the cached product → [reagentA, reagentB] map derived from REACTIONS.
 */
export function getProductReagentMap(): Partial<Record<ResourceConstant, [ResourceConstant, ResourceConstant]>> {
  if (productReagentCache) {
    return productReagentCache;
  }

  const map: Partial<Record<ResourceConstant, [ResourceConstant, ResourceConstant]>> = {};
  const raw = REACTIONS as unknown as Record<string, Record<string, string>>;
  for (const [reagentA, children] of Object.entries(raw)) {
    for (const [reagentB, product] of Object.entries(children)) {
      map[product as ResourceConstant] = [reagentA as ResourceConstant, reagentB as ResourceConstant];
    }
  }

  productReagentCache = map;
  return map;
}

/** Returns reagents for `product`, or null for base minerals / unknowns. */
export function getProductReagents(product: ResourceConstant): [ResourceConstant, ResourceConstant] | null {
  const map = getProductReagentMap();
  return map[product] || null;
}
