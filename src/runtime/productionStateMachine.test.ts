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
  describe("updateTransitionAt", () => {
    it("sets lastTransitionAt to currentTick", () => {
      const state = { lastTransitionAt: 0 };
      updateTransitionAt(state, 100);
      expect(state.lastTransitionAt).toBe(100);
    });

    it("overwrites previous value", () => {
      const state = { lastTransitionAt: 50 };
      updateTransitionAt(state, 200);
      expect(state.lastTransitionAt).toBe(200);
    });
  });

  describe("markLoadingStart", () => {
    it("sets loadingSinceTick when undefined", () => {
      const state: { loadingSinceTick?: number } = {};
      markLoadingStart(state, 100);
      expect(state.loadingSinceTick).toBe(100);
    });

    it("does not overwrite existing loadingSinceTick", () => {
      const state: { loadingSinceTick?: number } = { loadingSinceTick: 50 };
      markLoadingStart(state, 100);
      expect(state.loadingSinceTick).toBe(50);
    });
  });

  describe("clearLoadingSince", () => {
    it("sets loadingSinceTick to undefined", () => {
      const state: { loadingSinceTick?: number } = { loadingSinceTick: 100 };
      clearLoadingSince(state);
      expect(state.loadingSinceTick).toBeUndefined();
    });
  });

  describe("isLoadingTimedOut", () => {
    it("returns false when loadingSinceTick is undefined", () => {
      expect(isLoadingTimedOut(undefined, 1000, 500)).toBe(false);
    });

    it("returns false when elapsed time is within timeout", () => {
      expect(isLoadingTimedOut(600, 1000, 500)).toBe(false);
    });

    it("returns false when elapsed time exactly equals timeout", () => {
      expect(isLoadingTimedOut(500, 1000, 500)).toBe(false);
    });

    it("returns true when elapsed time exceeds timeout", () => {
      expect(isLoadingTimedOut(400, 1000, 500)).toBe(true);
    });

    it("returns false when loadingSinceTick is 0 (treated as unset)", () => {
      expect(isLoadingTimedOut(0, 501, 500)).toBe(false);
    });
  });

  describe("isStageBlocked", () => {
    it("returns true for blocked", () => {
      expect(isStageBlocked("blocked")).toBe(true);
    });

    it("returns false for other stages", () => {
      expect(isStageBlocked("idle")).toBe(false);
      expect(isStageBlocked("loading")).toBe(false);
      expect(isStageBlocked("synthesizing")).toBe(false);
    });
  });

  describe("isStageIdle", () => {
    it("returns true for idle", () => {
      expect(isStageIdle("idle")).toBe(true);
    });

    it("returns true for sleeping", () => {
      expect(isStageIdle("sleeping")).toBe(true);
    });

    it("returns false for active stages", () => {
      expect(isStageIdle("loading")).toBe(false);
      expect(isStageIdle("blocked")).toBe(false);
      expect(isStageIdle("synthesizing")).toBe(false);
    });
  });

  describe("isTargetSatisfiedByReactionGranularity", () => {
    it("returns true when current >= target", () => {
      expect(isTargetSatisfiedByReactionGranularity(1000, 1000)).toBe(true);
      expect(isTargetSatisfiedByReactionGranularity(1001, 1000)).toBe(true);
    });

    it("returns true when current > 0 and deficit < LAB_REACTION_AMOUNT", () => {
      expect(isTargetSatisfiedByReactionGranularity(998, 1000)).toBe(true);
    });

    it("returns false when current is 0 and target > 0", () => {
      expect(isTargetSatisfiedByReactionGranularity(0, 1000)).toBe(false);
    });

    it("returns false when deficit >= LAB_REACTION_AMOUNT", () => {
      expect(isTargetSatisfiedByReactionGranularity(994, 1000)).toBe(false);
    });

    it("returns true when both are 0", () => {
      expect(isTargetSatisfiedByReactionGranularity(0, 0)).toBe(true);
    });
  });
});
