import { roundUpReactionAmount, getProductReagentMap, getProductReagents } from "@/runtime/reactionMap";

describe("reactionMap", () => {
  describe("roundUpReactionAmount", () => {

    it("leaves exact multiples unchanged", () => {
      expect(roundUpReactionAmount(5)).toBe(5);
      expect(roundUpReactionAmount(10)).toBe(10);
      expect(roundUpReactionAmount(0)).toBe(0);
    });
  });

  describe("getProductReagentMap", () => {

    it("returns the same cached object on repeated calls", () => {
      const first = getProductReagentMap();
      const second = getProductReagentMap();
      expect(first).toBe(second);
    });
  });

  describe("getProductReagents", () => {

    it("returns null for a base mineral", () => {
      expect(getProductReagents(RESOURCE_HYDROGEN)).toBeNull();
    });
  });
});
