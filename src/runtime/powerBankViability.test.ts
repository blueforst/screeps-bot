import {
  HEAL_POWER,
  POWER_BANK_ROOM_TRAVEL_TICKS,
  assessViability,
  computeCombatPairSpawnTime,
  computeHaulerCount,
  computeTOUGHSustainability,
  computeTimeToKill,
  derivePowerBankTierProfile,
  planPowerBankTimeline,
  selectBodyTier,
  type ViabilityInput,
} from "@/runtime/powerBankViability";

describe("powerBankViability", () => {
  it("derives tier profiles and the exact RCL6 capacity boundary from runtime constants", () => {
    expect(POWER_BANK_ROOM_TRAVEL_TICKS).toBe(50);
    expect(selectBodyTier(2190)).toEqual({ attackerTier: "rcl6", healerTier: "rcl6" });

    const cases = [
      { tier: 6, attackParts: 15, healParts: 7, dps: 1800, hps: 336, attackerSpawn: 114, healerSpawn: 42, healCompound: 210 },
      { tier: 7, attackParts: 16, healParts: 7, dps: 1920, hps: 336, attackerSpawn: 120, healerSpawn: 42, healCompound: 210 },
      { tier: 8, attackParts: 16, healParts: 25, dps: 1920, hps: 300, attackerSpawn: 120, healerSpawn: 150, healCompound: undefined },
    ] as const;
    for (const expected of cases) {
      const profile = derivePowerBankTierProfile(expected.tier);
      expect(profile).not.toBeNull();
      expect(profile).toMatchObject({
        dpsPerAttacker: expected.dps,
        healerHPS: expected.hps,
        attacker: { attackParts: expected.attackParts, spawnTime: expected.attackerSpawn },
        healer: { healParts: expected.healParts, spawnTime: expected.healerSpawn },
      });
      expect(profile?.requiredCompounds.get(RESOURCE_CATALYZED_GHODIUM_ALKALIDE))
        .toBe(4 * LAB_BOOST_MINERAL);
      expect(profile?.requiredCompounds.get(RESOURCE_CATALYZED_UTRIUM_ACID))
        .toBe(expected.attackParts * LAB_BOOST_MINERAL);
      expect(profile?.requiredCompounds.get(RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE))
        .toBe(expected.healCompound);
    }
    expect(derivePowerBankTierProfile(8)?.attacker.cost).toBe(2320);
    expect(derivePowerBankTierProfile(8)?.healer.cost).toBe(7500);
  });

  it("keeps sustainability, attacker-count, free-tile, and hauler rounding boundaries explicit", () => {
    expect(computeTOUGHSustainability(4, 0.3, 900, 100, 2).sustainable).toBe(true);
    expect(computeTOUGHSustainability(4, 0.3, 900, 100, 3).sustainable).toBe(false);
    for (const freeTiles of [1, 2, 4, 8]) {
      expect(computeTimeToKill(2_000_000, 1920, freeTiles)).toBe(1042);
    }
    expect(computeTimeToKill(2_000_000, 1920, 2, 3)).toBe(521);
    expect(computeTimeToKill(2_000_000, 1920, 0, 1)).toBe(Infinity);
    expect(computeHaulerCount(1000, 2000)).toBe(1);
  });

  it("uses complete combat-pair queues and route travel in the unified deadline", () => {
    for (const { spawnReadyIn, expected } of [
      { spawnReadyIn: [0], expected: 270 },
      { spawnReadyIn: [0, 0], expected: 150 },
      { spawnReadyIn: [40, 10], expected: 160 },
      { spawnReadyIn: [100], expected: 370 },
    ]) {
      expect(computeCombatPairSpawnTime(120, 150, spawnReadyIn)).toBe(expected);
    }

    const profile = derivePowerBankTierProfile(8);
    if (!profile) throw new Error("missing RCL8 profile");
    for (const { spawnCount, pairSpawnTime, killTick } of [
      { spawnCount: 1, pairSpawnTime: 270, killTick: 1632 },
      { spawnCount: 2, pairSpawnTime: 150, killTick: 1512 },
    ]) {
      const plan = planPowerBankTimeline({
        profile,
        currentTick: 100,
        bankHits: 2_000_000,
        bankPower: 2500,
        freeTiles: 8,
        routeDistance: 3,
        haulerCapacity: 1250,
        spawnCount,
      });
      expect(plan).toMatchObject({ attackerCount: 1, pairSpawnTime, ttk: 1042, killTick });
      expect(plan.haulerArrivalTick).toBe(killTick);
    }

    const queuedPlan = planPowerBankTimeline({
      profile,
      currentTick: 100,
      bankHits: 192_000,
      bankPower: 1250,
      freeTiles: 4,
      routeDistance: 1,
      haulerCapacity: 1250,
      spawnReadyIn: [40, 10],
    });
    expect(queuedPlan).toMatchObject({
      pairSpawnTime: 160,
      combatReadyTick: 330,
      combatArrivalTick: 380,
      killTick: 480,
    });
  });

  it("accepts healthy inputs and fails closed at compound-independent deadline and capacity boundaries", () => {
    const viableInput = (overrides: Partial<ViabilityInput> = {}): ViabilityInput => ({
      energyCapacity: 7500,
      bankHits: 2_000_000,
      bankPower: 5000,
      ticksToDecay: 5000,
      freeTiles: 2,
      routeDistance: 3,
      currentTick: 100,
      hasCompounds: { xgho2: true, xuh2o: true, xlho2: true },
      isDefenseMode: false,
      haulerCapacity: 2000,
      ...overrides,
    });

    const healthy = assessViability(viableInput());
    expect(healthy.viable).toBe(true);
    expect(healthy.reasons).toEqual([]);

    const unboostedHealer = assessViability(viableInput({
      freeTiles: 8,
      hasCompounds: { xgho2: true, xuh2o: true, xlho2: false },
    }));
    expect(unboostedHealer.viable).toBe(true);
    expect(unboostedHealer.reasons).not.toContain("insufficient_boost_compound");
    expect(unboostedHealer.estimates.healerHPS).toBe(25 * HEAL_POWER);
    expect(unboostedHealer.estimates.ttk).toBe(1042);

    const tooLate = assessViability(viableInput({
      bankPower: 2500,
      haulerCapacity: 1250,
      ticksToDecay: 1800,
      freeTiles: 8,
      routeDistance: 10,
      spawnCount: 1,
      hasCompounds: { xgho2: true, xuh2o: true, xlho2: false },
    }));
    expect(tooLate.viable).toBe(false);
    expect(tooLate.reasons).toContain("decay_too_soon");
    expect(tooLate.estimates.timeBudget).toBe(1882);

    const underCapacity = assessViability(viableInput({ energyCapacity: 1000 }));
    expect(underCapacity.viable).toBe(false);
    expect(underCapacity.reasons).toContain("insufficient_energy_capacity");
  });
});
