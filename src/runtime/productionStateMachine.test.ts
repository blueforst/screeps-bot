import {
  updateTransitionAt,
  markLoadingStart,
  clearLoadingSince,
  isLoadingTimedOut,
  isStageBlocked,
  isStageIdle,
  isTargetSatisfiedByReactionGranularity,
} from "@/runtime/productionStateMachine";

describe("productionStateMachine", () => {

  describe("isLoadingTimedOut", () => {
    it("returns false when loadingSinceTick is undefined", () => {
      expect(isLoadingTimedOut(undefined, 1000, 500)).toBe(false);
    });

    it("returns false when elapsed time exactly equals timeout", () => {
      expect(isLoadingTimedOut(500, 1000, 500)).toBe(false);
    });
  });

  describe("isTargetSatisfiedByReactionGranularity", () => {

    it("returns true when current > 0 and deficit < LAB_REACTION_AMOUNT", () => {
      expect(isTargetSatisfiedByReactionGranularity(998, 1000)).toBe(true);
    });
  });
});
