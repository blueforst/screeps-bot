import { normalizeNumber } from "@/runtime/configNormalize";

describe("configNormalize", () => {
  describe("normalizeNumber", () => {
    it("returns fallback for undefined", () => {
      expect(normalizeNumber(undefined, 42, 0, 100)).toBe(42);
    });

    it("returns min when value equals min", () => {
      expect(normalizeNumber(0, 42, 0, 100)).toBe(0);
    });
  });
});
