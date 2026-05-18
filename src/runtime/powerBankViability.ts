export const ATTACK_POWER = 30;
export const HEAL_POWER = 12;
export const CREEP_SPAWN_TIME = 3;
export const POWER_BANK_HIT_BACK = 0.5;
export const BOOST_ATTACK_MULTIPLIER = 4;
export const BOOST_HEAL_MULTIPLIER = 4;
export const BOOST_TOUGH_DAMAGE_FACTOR = 0.3;
export const POWER_BANK_ROOM_TRAVEL_TICKS = 50;

const TOUGH_HITS = 100;

type TierKind = "rcl6" | "rcl7" | "rcl8";

interface BodyTier {
  attacker: { tough: number; attack: number; move: number; cost: number };
  healer: { heal: number; move: number; cost: number };
}

const BODY_TIERS: Record<TierKind, BodyTier> = {
  rcl6: {
    attacker: { tough: 4, attack: 15, move: 19, cost: 2190 },
    healer: { heal: 7, move: 7, cost: 2100 },
  },
  rcl7: {
    attacker: { tough: 4, attack: 16, move: 20, cost: 2320 },
    healer: { heal: 7, move: 7, cost: 2100 },
  },
  rcl8: {
    attacker: { tough: 4, attack: 16, move: 20, cost: 2320 },
    healer: { heal: 25, move: 25, cost: 7500 },
  },
};

const TIER_ORDER: TierKind[] = ["rcl8", "rcl7", "rcl6"];

export function selectBodyTier(
  energyCapacity: number,
): { attackerTier: TierKind; healerTier: TierKind } | null {
  for (const tier of TIER_ORDER) {
    const t = BODY_TIERS[tier];
    if (energyCapacity >= t.attacker.cost && energyCapacity >= t.healer.cost) {
      return { attackerTier: tier, healerTier: tier };
    }
  }
  return null;
}

export function computeBoostedDPS(attackCount: number, boostMultiplier: number): number {
  return attackCount * ATTACK_POWER * boostMultiplier;
}

export function computeHealerHPS(healCount: number, boostMultiplier: number): number {
  return healCount * HEAL_POWER * boostMultiplier;
}

export function computeHitbackDPS(dps: number): number {
  return dps * POWER_BANK_HIT_BACK;
}

export function computeTOUGHSustainability(
  toughCount: number,
  toughBoostReduction: number,
  hitbackDPS: number,
  healerHPS: number,
  estimatedTTK = 5000,
): { ticksUntilTOUGHBreaks: number; sustainable: boolean } {
  const toughTotalHP = toughCount * TOUGH_HITS;
  const effectiveDPSPerTick = Math.max(0, hitbackDPS * toughBoostReduction - healerHPS);

  const ticksUntilTOUGHBreaks =
    effectiveDPSPerTick > 0 ? toughTotalHP / effectiveDPSPerTick : Infinity;

  return {
    ticksUntilTOUGHBreaks,
    sustainable: ticksUntilTOUGHBreaks > estimatedTTK,
  };
}

export function computeTimeToKill(
  bankHits: number,
  dps: number,
  freeTiles: number,
): number {
  if (freeTiles === 0) return Infinity;
  return Math.ceil(bankHits / (dps * freeTiles));
}

export function computeTimeBudget(params: {
  routeDistance: number;
  spawnTime: number;
  boostPrepTime: number;
  renewalBuffer: number;
  ttk: number;
  haulTime: number;
}): number {
  const routeTravel = params.routeDistance * POWER_BANK_ROOM_TRAVEL_TICKS;
  return (
    params.spawnTime +
    params.boostPrepTime +
    params.renewalBuffer +
    routeTravel +
    params.ttk +
    params.haulTime
  );
}

export function computeHaulerCount(power: number, haulerCapacity: number): number {
  return Math.ceil(power / haulerCapacity);
}

export function computeHaulerDepartureTick(
  ttk: number,
  haulTravelTime: number,
  currentTick: number,
  haulerBatchSpawnTime = 0,
): number {
  return currentTick + Math.max(0, ttk - haulTravelTime - haulerBatchSpawnTime);
}

function computeHaulerSpawnTime(haulerCapacity: number): number {
  const carryParts = Math.max(1, Math.ceil(haulerCapacity / CARRY_CAPACITY));
  return carryParts * 2 * CREEP_SPAWN_TIME;
}

function computeHaulerBatchSpawnTime(haulerCount: number, haulerCapacity: number, spawnCount: number): number {
  const activeSpawnCount = Math.max(1, spawnCount);
  return Math.ceil((haulerCount * computeHaulerSpawnTime(haulerCapacity)) / activeSpawnCount);
}

export interface TimeEstimates {
  ttk: number;
  dps: number;
  hitbackDPS: number;
  healerHPS: number;
  timeBudget: number;
  haulerCount: number;
  haulDepartTick: number;
}

export interface ViabilityInput {
  energyCapacity: number;
  bankHits: number;
  bankPower: number;
  ticksToDecay: number;
  freeTiles: number;
  routeDistance: number;
  currentTick: number;
  hasCompounds: { xgho2: boolean; xuh2o: boolean; xlho2: boolean };
  isDefenseMode: boolean;
  haulerCapacity: number;
  spawnCount?: number;
}

export interface ViabilityResult {
  viable: boolean;
  reasons: string[];
  estimates: TimeEstimates;
}

export function assessViability(params: ViabilityInput): ViabilityResult {
  const reasons: string[] = [];

  if (params.isDefenseMode) {
    reasons.push("defense_mode_active");
  }

  const tier = selectBodyTier(params.energyCapacity);
  if (!tier) {
    reasons.push("insufficient_energy_capacity");
  }

  if (!params.hasCompounds.xuh2o || !params.hasCompounds.xgho2 || !params.hasCompounds.xlho2) {
    reasons.push("insufficient_boost_compound");
  }

  if (params.freeTiles === 0) {
    reasons.push("no_free_adjacent_tiles");
  }

  const tierData = tier ? BODY_TIERS[tier.attackerTier] : BODY_TIERS.rcl6;
  const attackCount = tierData.attacker.attack;
  const healCount = tierData.healer.heal;
  const toughCount = tierData.attacker.tough;

  const attackBoost = params.hasCompounds.xuh2o ? BOOST_ATTACK_MULTIPLIER : 1;
  const healBoost = params.hasCompounds.xlho2 ? BOOST_HEAL_MULTIPLIER : 1;
  const toughReduction = params.hasCompounds.xgho2 ? BOOST_TOUGH_DAMAGE_FACTOR : 1;

  const dps = computeBoostedDPS(attackCount, attackBoost);
  const hitbackDPS = computeHitbackDPS(dps);
  const healerHPS = computeHealerHPS(healCount, healBoost);

  const ttk = computeTimeToKill(params.bankHits, dps, params.freeTiles);
  if (ttk === Infinity) {
    reasons.push("cannot_reach_bank");
  }

  const spawnParts =
    tierData.attacker.tough + tierData.attacker.attack + tierData.attacker.move;
  const spawnTime = spawnParts * CREEP_SPAWN_TIME;

  if (tier && params.hasCompounds.xgho2) {
    const sustainability = computeTOUGHSustainability(
      toughCount,
      toughReduction,
      hitbackDPS,
      healerHPS,
      ttk === Infinity ? 0 : ttk,
    );
    if (!sustainability.sustainable) {
      reasons.push("tough_layer_unsustainable");
    }
  }

  const haulTravelTime = params.routeDistance * POWER_BANK_ROOM_TRAVEL_TICKS;
  const timeBudget = computeTimeBudget({
    routeDistance: params.routeDistance,
    spawnTime,
    boostPrepTime: 20,
    renewalBuffer: 50,
    ttk: ttk === Infinity ? 0 : ttk,
    haulTime: haulTravelTime,
  });

  if (timeBudget > params.ticksToDecay) {
    reasons.push("decay_too_soon");
  }

  const haulerCount = computeHaulerCount(params.bankPower, params.haulerCapacity);
  const haulerBatchSpawnTime = computeHaulerBatchSpawnTime(
    haulerCount,
    params.haulerCapacity,
    params.spawnCount ?? 1,
  );
  const haulDepartTick = computeHaulerDepartureTick(
    ttk === Infinity ? 0 : ttk,
    haulTravelTime,
    params.currentTick,
    haulerBatchSpawnTime,
  );
  const haulArrivalTick = haulDepartTick + haulerBatchSpawnTime + haulTravelTime;
  const killTick =
    params.currentTick +
    spawnTime +
    20 +
    50 +
    params.routeDistance * POWER_BANK_ROOM_TRAVEL_TICKS +
    (ttk === Infinity ? 0 : ttk);

  const bankDespawnTick = params.currentTick + params.ticksToDecay;
  if (haulArrivalTick > bankDespawnTick) {
    reasons.push("insufficient_hauler_timing");
  }

  return {
    viable: reasons.length === 0,
    reasons,
    estimates: {
      ttk: ttk === Infinity ? Infinity : ttk,
      dps,
      hitbackDPS,
      healerHPS,
      timeBudget,
      haulerCount,
      haulDepartTick,
    },
  };
}
