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

  describe("computeTOUGHSustainability", () => {

    it("uses explicit TTK for sustainability threshold", () => {
      const sustainable = computeTOUGHSustainability(4, 0.3, 900, 100, 2);
      expect(sustainable.sustainable).toBe(true);

      const unsustainable = computeTOUGHSustainability(4, 0.3, 900, 100, 3);
      expect(unsustainable.sustainable).toBe(false);
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

    it("fails with insufficient_energy_capacity", () => {
      const result = assessViability(viableInput({ energyCapacity: 1000 }));
      expect(result.viable).toBe(false);
      expect(result.reasons).toContain("insufficient_energy_capacity");
    });
  });
});
