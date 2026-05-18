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
  assessViability,
  type ViabilityInput,
} from "@/runtime/powerBankViability";

describe("powerBankViability", () => {
  describe("exported constants", () => {
    it("exports correct ATTACK_POWER", () => {
      expect(ATTACK_POWER).toBe(30);
    });
    it("exports correct HEAL_POWER", () => {
      expect(HEAL_POWER).toBe(12);
    });
    it("exports correct CREEP_SPAWN_TIME", () => {
      expect(CREEP_SPAWN_TIME).toBe(3);
    });
    it("exports correct POWER_BANK_HIT_BACK", () => {
      expect(POWER_BANK_HIT_BACK).toBe(0.5);
    });
    it("exports correct boost multipliers", () => {
      expect(BOOST_ATTACK_MULTIPLIER).toBe(4);
      expect(BOOST_HEAL_MULTIPLIER).toBe(4);
      expect(BOOST_TOUGH_DAMAGE_FACTOR).toBe(0.3);
    });

    it("budgets power bank travel per room, not per linear step", () => {
      expect(POWER_BANK_ROOM_TRAVEL_TICKS).toBe(50);
    });
  });

  describe("selectBodyTier", () => {
    it("returns null when energy is too low for any tier", () => {
      expect(selectBodyTier(2189)).toBeNull();
    });

    it("returns rcl6 at exactly 2190 energy", () => {
      expect(selectBodyTier(2190)).toEqual({
        attackerTier: "rcl6",
        healerTier: "rcl6",
      });
    });

    it("returns rcl7 at 2320 energy", () => {
      expect(selectBodyTier(2320)).toEqual({
        attackerTier: "rcl7",
        healerTier: "rcl7",
      });
    });

    it("returns rcl8 at 7500 energy", () => {
      expect(selectBodyTier(7500)).toEqual({
        attackerTier: "rcl8",
        healerTier: "rcl8",
      });
    });

    it("returns rcl7 when energy covers rcl7 but not rcl8 healer", () => {
      expect(selectBodyTier(7499)).toEqual({
        attackerTier: "rcl7",
        healerTier: "rcl7",
      });
    });
  });

  describe("computeBoostedDPS", () => {
    it("15 attacks * 30 * 4 = 1800", () => {
      expect(computeBoostedDPS(15, 4)).toBe(1800);
    });

    it("16 attacks * 30 * 4 = 1920", () => {
      expect(computeBoostedDPS(16, 4)).toBe(1920);
    });

    it("unboosted: 15 * 30 * 1 = 450", () => {
      expect(computeBoostedDPS(15, 1)).toBe(450);
    });
  });

  describe("computeHealerHPS", () => {
    it("7 heals * 12 * 4 = 336", () => {
      expect(computeHealerHPS(7, 4)).toBe(336);
    });

    it("25 heals * 12 * 4 = 1200", () => {
      expect(computeHealerHPS(25, 4)).toBe(1200);
    });
  });

  describe("computeHitbackDPS", () => {
    it("1800 * 0.5 = 900", () => {
      expect(computeHitbackDPS(1800)).toBe(900);
    });

    it("1920 * 0.5 = 960", () => {
      expect(computeHitbackDPS(1920)).toBe(960);
    });
  });

  describe("computeTOUGHSustainability", () => {
    it("sustainable when healer HPS exceeds effective hitback", () => {
      const result = computeTOUGHSustainability(4, 0.3, 900, 336);
      expect(result.ticksUntilTOUGHBreaks).toBe(Infinity);
      expect(result.sustainable).toBe(true);
    });

    it("unsustainable when hitback overwhelms healer with default TTK", () => {
      const result = computeTOUGHSustainability(4, 0.3, 900, 0);
      expect(result.ticksUntilTOUGHBreaks).toBeCloseTo(400 / 270, 1);
      expect(result.sustainable).toBe(false);
    });

    it("uses explicit TTK for sustainability threshold", () => {
      const sustainable = computeTOUGHSustainability(4, 0.3, 900, 100, 2);
      expect(sustainable.sustainable).toBe(true);

      const unsustainable = computeTOUGHSustainability(4, 0.3, 900, 100, 3);
      expect(unsustainable.sustainable).toBe(false);
    });
  });

  describe("computeTimeToKill", () => {
    it("returns Infinity when freeTiles is 0", () => {
      expect(computeTimeToKill(2_000_000, 1800, 0)).toBe(Infinity);
    });

    it("ceil(2M / (1800 * 1)) = 1112", () => {
      expect(computeTimeToKill(2_000_000, 1800, 1)).toBe(1112);
    });

    it("ceil(2M / (1800 * 2)) = 556", () => {
      expect(computeTimeToKill(2_000_000, 1800, 2)).toBe(556);
    });
  });

  describe("computeTimeBudget", () => {
    it("sums all phases including room-route travel", () => {
      const budget = computeTimeBudget({
        routeDistance: 5,
        spawnTime: 114,
        boostPrepTime: 20,
        renewalBuffer: 50,
        ttk: 1112,
        haulTime: 100,
      });
      expect(budget).toBe(1646);
    });

    it("handles zero-distance routes", () => {
      expect(
        computeTimeBudget({
          routeDistance: 0,
          spawnTime: 0,
          boostPrepTime: 0,
          renewalBuffer: 0,
          ttk: 100,
          haulTime: 0,
        }),
      ).toBe(100);
    });
  });

  describe("computeHaulerCount", () => {
    it("ceil(5000 / 2000) = 3", () => {
      expect(computeHaulerCount(5000, 2000)).toBe(3);
    });

    it("exact fit: ceil(2000 / 2000) = 1", () => {
      expect(computeHaulerCount(2000, 2000)).toBe(1);
    });

    it("under capacity: ceil(1000 / 2000) = 1", () => {
      expect(computeHaulerCount(1000, 2000)).toBe(1);
    });
  });

  describe("computeHaulerDepartureTick", () => {
    it("departs early enough to arrive before kill", () => {
      expect(computeHaulerDepartureTick(1000, 200, 500)).toBe(1300);
    });

    it("departs immediately when haul time exceeds TTK", () => {
      expect(computeHaulerDepartureTick(100, 200, 500)).toBe(500);
    });

    it("starts spawning early enough for the hauler batch to finish before travel", () => {
      expect(computeHaulerDepartureTick(1000, 200, 500, 300)).toBe(1000);
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

    it("fails with defense_mode_active", () => {
      const result = assessViability(viableInput({ isDefenseMode: true }));
      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("defense_mode_active");
    });

    it("fails with insufficient_energy_capacity", () => {
      const result = assessViability(viableInput({ energyCapacity: 1000 }));
      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("insufficient_energy_capacity");
    });

    it("fails with insufficient_boost_compound when missing xuh2o", () => {
      const result = assessViability(
        viableInput({ hasCompounds: { xgho2: true, xuh2o: false, xlho2: true } }),
      );
      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("insufficient_boost_compound");
    });

    it("fails with insufficient_boost_compound when missing xgho2", () => {
      const result = assessViability(
        viableInput({ hasCompounds: { xgho2: false, xuh2o: true, xlho2: true } }),
      );
      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("insufficient_boost_compound");
    });

    it("fails with no_free_adjacent_tiles", () => {
      const result = assessViability(viableInput({ freeTiles: 0 }));
      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("no_free_adjacent_tiles");
    });

    it("fails with decay_too_soon", () => {
      const result = assessViability(viableInput({ ticksToDecay: 100 }));
      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("decay_too_soon");
    });

    it("fails with tough_layer_unsustainable without xgho2", () => {
      const result = assessViability(
        viableInput({
          energyCapacity: 2190,
          hasCompounds: { xgho2: false, xuh2o: true, xlho2: true },
        }),
      );
      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("insufficient_boost_compound");
    });

    it("fails with insufficient_hauler_timing when haulers can't arrive in time", () => {
      const result = assessViability(
        viableInput({
          routeDistance: 100,
          ticksToDecay: 100,
          bankHits: 10_000,
        }),
      );
      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("insufficient_hauler_timing");
    });

    it("accounts for parallel spawns when estimating hauler timing", () => {
      const singleSpawn = assessViability(
        viableInput({
          bankHits: 100_000,
          bankPower: 5000,
          haulerCapacity: 800,
          routeDistance: 3,
          ticksToDecay: 600,
          spawnCount: 1,
        }),
      );
      const threeSpawns = assessViability(
        viableInput({
          bankHits: 100_000,
          bankPower: 5000,
          haulerCapacity: 800,
          routeDistance: 3,
          ticksToDecay: 600,
          spawnCount: 3,
        }),
      );

      expect(singleSpawn.reasons).toContain("insufficient_hauler_timing");
      expect(threeSpawns.reasons).not.toContain("insufficient_hauler_timing");
    });
  });
});
