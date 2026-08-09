export const STANDARD_CARRIER_MAX_CAPACITY = 1_000;

const CARRIER_PAIR_PART_COUNT = 2;

export function buildStandardCarrierBody(energyBudget: number): BodyPartConstant[] {
  const pairCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const maxPairsByCapacity = Math.floor(STANDARD_CARRIER_MAX_CAPACITY / CARRY_CAPACITY);
  const maxPairsByBodySize = Math.floor(MAX_CREEP_SIZE / CARRIER_PAIR_PART_COUNT);
  const affordablePairs = Math.floor(Math.max(0, energyBudget) / pairCost);
  const pairCount = Math.min(maxPairsByCapacity, maxPairsByBodySize, affordablePairs);
  const body: BodyPartConstant[] = [];

  for (let i = 0; i < pairCount; i++) {
    body.push(CARRY, MOVE);
  }

  return body;
}
