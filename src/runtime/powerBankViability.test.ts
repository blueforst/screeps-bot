import {
  ATTACK_POWER,
  HEAL_POWER,
  CREEP_SPAWN_TIME,
  POWER_BANK_HIT_BACK,
  BOOST_ATTACK_MULTIPLIER,
  BOOST_HEAL_MULTIPLIER,
  BOOST_TOUGH_DAMAGE_FACTOR,
  POWER_BANK_ROOM_TRAVEL_TICKS,
  selectBodyTier,
  computeBoostedDPS,
  computeHealerHPS,
  computeHitbackDPS,
  computeTOUGHSustainability,
  computeTimeToKill,
  computeTimeBudget,
  computeHaulerCount,
  computeHaulerDepartureTick,
  computeCombatPairSpawnTime,
  derivePowerBankTierProfile,
  planPowerBankTimeline,
  assessViability,
  type ViabilityInput,
} from "@/runtime/powerBankViability";

describe("powerBankViability", () => {
  describe("exported constants", () => {
    it("budgets power bank travel per room, not per linear step", () => {
      expect(POWER_BANK_ROOM_TRAVEL_TICKS).toBe(50);
    });
  });

  describe("selectBodyTier", () => {
    it("returns rcl6 at exactly 2190 energy", () => {
      expect(selectBodyTier(2190)).toEqual({
        attackerTier: "rcl6",
        healerTier: "rcl6",
      });
    });
  });

  describe("derivePowerBankTierProfile", () => {
    it.each([
      {
        tier: 6,
        attackParts: 15,
        healParts: 7,
        dps: 1800,
        hps: 336,
        attackerSpawnTime: 114,
        healerSpawnTime: 42,
        healCompound: 210,
      },
      {
        tier: 7,
        attackParts: 16,
        healParts: 7,
        dps: 1920,
        hps: 336,
        attackerSpawnTime: 120,
        healerSpawnTime: 42,
        healCompound: 210,
      },
      {
        tier: 8,
        attackParts: 16,
        healParts: 25,
        dps: 1920,
        hps: 300,
        attackerSpawnTime: 120,
        healerSpawnTime: 150,
        healCompound: undefined,
      },
    ])(
      "derives RCL$tier combat values and resource needs from runtime constants",
      ({
        tier,
        attackParts,
        healParts,
        dps,
        hps,
        attackerSpawnTime,
        healerSpawnTime,
        healCompound,
      }) => {
        const profile = derivePowerBankTierProfile(tier);
        expect(profile).not.toBeNull();
        expect(profile?.attacker.attackParts).toBe(attackParts);
        expect(profile?.healer.healParts).toBe(healParts);
        expect(profile?.dpsPerAttacker).toBe(dps);
        expect(profile?.healerHPS).toBe(hps);
        expect(profile?.attacker.spawnTime).toBe(attackerSpawnTime);
        expect(profile?.healer.spawnTime).toBe(healerSpawnTime);
        expect(
          profile?.requiredCompounds.get(RESOURCE_CATALYZED_GHODIUM_ALKALIDE),
        ).toBe(4 * LAB_BOOST_MINERAL);
        expect(
          profile?.requiredCompounds.get(RESOURCE_CATALYZED_UTRIUM_ACID),
        ).toBe(attackParts * LAB_BOOST_MINERAL);
        expect(
          profile?.requiredCompounds.get(RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE),
        ).toBe(healCompound);
      },
    );

    it("derives body costs instead of keeping a second tier cost table", () => {
      const rcl8 = derivePowerBankTierProfile(8);
      expect(rcl8?.attacker.cost).toBe(2320);
      expect(rcl8?.healer.cost).toBe(7500);
    });
  });

  describe("computeTOUGHSustainability", () => {
    it("uses explicit TTK for sustainability threshold", () => {
      const sustainable = computeTOUGHSustainability(4, 0.3, 900, 100, 2);
      expect(sustainable.sustainable).toBe(true);

      const unsustainable = computeTOUGHSustainability(4, 0.3, 900, 100, 3);
      expect(unsustainable.sustainable).toBe(false);
    });
  });

  describe("computeTimeToKill", () => {
    it.each([1, 2, 4, 8])(
      "does not multiply a single attacker's DPS across %i free tiles",
      (freeTiles) => {
        expect(computeTimeToKill(2_000_000, 1920, freeTiles)).toBe(1042);
      },
    );

    it("uses free tiles only to cap an explicitly requested attacker count", () => {
      expect(computeTimeToKill(2_000_000, 1920, 2, 3)).toBe(521);
      expect(computeTimeToKill(2_000_000, 1920, 0, 1)).toBe(Infinity);
    });
  });

  describe("combat pair timeline", () => {
    const rcl8 = (): NonNullable<ReturnType<typeof derivePowerBankTierProfile>> => {
      const profile = derivePowerBankTierProfile(8);
      if (!profile) throw new Error("missing RCL8 profile");
      return profile;
    };

    it.each([
      { spawnReadyIn: [0], expected: 270 },
      { spawnReadyIn: [0, 0], expected: 150 },
      { spawnReadyIn: [40, 10], expected: 160 },
      { spawnReadyIn: [100], expected: 370 },
    ])(
      "finishes the complete pair in $expected ticks for queues $spawnReadyIn",
      ({ spawnReadyIn, expected }) => {
        expect(computeCombatPairSpawnTime(120, 150, spawnReadyIn)).toBe(expected);
      },
    );

    it.each([
      { spawnCount: 1, expectedPairTime: 270, expectedKillTick: 1632 },
      { spawnCount: 2, expectedPairTime: 150, expectedKillTick: 1512 },
    ])(
      "accounts for a full RCL8 pair with $spawnCount Spawn(s)",
      ({ spawnCount, expectedPairTime, expectedKillTick }) => {
        const plan = planPowerBankTimeline({
          profile: rcl8(),
          currentTick: 100,
          bankHits: 2_000_000,
          bankPower: 2500,
          freeTiles: 8,
          routeDistance: 3,
          haulerCapacity: 1250,
          spawnCount,
        });

        expect(plan.attackerCount).toBe(1);
        expect(plan.pairSpawnTime).toBe(expectedPairTime);
        expect(plan.ttk).toBe(1042);
        expect(plan.killTick).toBe(expectedKillTick);
        expect(plan.haulerArrivalTick).toBe(expectedKillTick);
      },
    );

    it("includes per-Spawn queue readiness in the combat deadline", () => {
      const plan = planPowerBankTimeline({
        profile: rcl8(),
        currentTick: 100,
        bankHits: 192_000,
        bankPower: 1250,
        freeTiles: 4,
        routeDistance: 1,
        haulerCapacity: 1250,
        spawnReadyIn: [40, 10],
      });

      expect(plan.pairSpawnTime).toBe(160);
      expect(plan.combatReadyTick).toBe(330);
      expect(plan.combatArrivalTick).toBe(380);
      expect(plan.killTick).toBe(480);
    });
  });

  describe("computeHaulerCount", () => {
    it("under capacity: ceil(1000 / 2000) = 1", () => {
      expect(computeHaulerCount(1000, 2000)).toBe(1);
    });
  });

  describe("assessViability", () => {
    function viableInput(overrides: Partial<ViabilityInput> = {}): ViabilityInput {
      return {
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
      };
    }

    it("returns viable for a healthy scenario", () => {
      const result = assessViability(viableInput());
      expect(result.viable).toBe(true);
      expect(result.reasons).toHaveLength(0);
      expect(result.estimates).toBeDefined();
    });

    it("accepts RCL8 without XLHO2 and reports the actual unboosted healer HPS", () => {
      const result = assessViability(
        viableInput({
          freeTiles: 8,
          hasCompounds: { xgho2: true, xuh2o: true, xlho2: false },
        }),
      );

      expect(result.viable).toBe(true);
      expect(result.reasons).not.toContain("insufficient_boost_compound");
      expect(result.estimates.healerHPS).toBe(25 * HEAL_POWER);
      expect(result.estimates.ttk).toBe(1042);
    });

    it("rejects a long route when the unified pair timeline misses decay", () => {
      const result = assessViability(
        viableInput({
          bankPower: 2500,
          haulerCapacity: 1250,
          ticksToDecay: 1800,
          freeTiles: 8,
          routeDistance: 10,
          spawnCount: 1,
          hasCompounds: { xgho2: true, xuh2o: true, xlho2: false },
        }),
      );

      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("decay_too_soon");
      expect(result.estimates.timeBudget).toBe(1882);
    });

    it("fails with insufficient_energy_capacity", () => {
      const result = assessViability(viableInput({ energyCapacity: 1000 }));
      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("insufficient_energy_capacity");
    });
  });
});
