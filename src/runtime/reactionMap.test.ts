import { roundUpReactionAmount, getProductReagentMap, getProductReagents } from "@/runtime/reactionMap";

describe("reactionMap", () => {
  describe("roundUpReactionAmount", () => {
    it("rounds positive non-multiple up to next LAB_REACTION_AMOUNT", () => {
      expect(roundUpReactionAmount(7)).toBe(10);
    });

    it("leaves exact multiples unchanged", () => {
      expect(roundUpReactionAmount(5)).toBe(5);
      expect(roundUpReactionAmount(10)).toBe(10);
      expect(roundUpReactionAmount(0)).toBe(0);
    });

    it("rounds up large values", () => {
      expect(roundUpReactionAmount(501)).toBe(505);
    });

    it("handles amounts much larger than LAB_REACTION_AMOUNT", () => {
      expect(roundUpReactionAmount(3000)).toBe(3000);
      expect(roundUpReactionAmount(3001)).toBe(3005);
    });

    it("rounds negative values toward zero", () => {
      const result = roundUpReactionAmount(-3);
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getProductReagentMap", () => {
    it("returns a non-empty map", () => {
      const map = getProductReagentMap();
      expect(Object.keys(map).length).toBeGreaterThan(0);
    });

    it("maps OH to hydrogen and oxygen", () => {
      const map = getProductReagentMap();
      const reagents = map[RESOURCE_HYDROXIDE];
      expect(reagents).toBeDefined();
      expect(new Set(reagents)).toEqual(new Set([RESOURCE_HYDROGEN, RESOURCE_OXYGEN]));
    });

    it("maps XUH2O to [UH2O, X] (REACTIONS last-write order)", () => {
      const map = getProductReagentMap();
      const reagents = map[RESOURCE_CATALYZED_UTRIUM_ACID];
      expect(reagents).toBeDefined();
      expect(new Set(reagents)).toEqual(new Set([RESOURCE_CATALYST, RESOURCE_UTRIUM_ACID]));
    });

    it("maps XGHO2 reagents correctly", () => {
      const map = getProductReagentMap();
      const reagents = map[RESOURCE_CATALYZED_GHODIUM_ALKALIDE];
      expect(reagents).toBeDefined();
      expect(new Set(reagents)).toEqual(new Set([RESOURCE_CATALYST, RESOURCE_GHODIUM_ALKALIDE]));
    });

    it("returns the same cached object on repeated calls", () => {
      const first = getProductReagentMap();
      const second = getProductReagentMap();
      expect(first).toBe(second);
    });
  });

  describe("getProductReagents", () => {
    it("returns reagents for a known product", () => {
      const reagents = getProductReagents(RESOURCE_HYDROXIDE);
      expect(reagents).toBeDefined();
      expect(new Set(reagents)).toEqual(new Set([RESOURCE_HYDROGEN, RESOURCE_OXYGEN]));
    });

    it("returns reagents for a T3 product", () => {
      const reagents = getProductReagents(RESOURCE_CATALYZED_GHODIUM_ALKALIDE);
      expect(reagents).toBeDefined();
      expect(new Set(reagents)).toEqual(new Set([RESOURCE_CATALYST, RESOURCE_GHODIUM_ALKALIDE]));
    });

    it("returns null for a base mineral", () => {
      expect(getProductReagents(RESOURCE_HYDROGEN)).toBeNull();
    });

    it("returns null for energy", () => {
      expect(getProductReagents(RESOURCE_ENERGY as ResourceConstant)).toBeNull();
    });
  });
});
