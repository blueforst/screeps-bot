import {
  isLoadingTimedOut,
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
});
