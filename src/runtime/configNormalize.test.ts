import { normalizeNumber, normalizeBoolean, normalizeRoomNameList } from "@/runtime/configNormalize";

describe("configNormalize", () => {
  describe("normalizeNumber", () => {
    it("returns fallback for undefined", () => {
      expect(normalizeNumber(undefined, 42, 0, 100)).toBe(42);
    });

    it("returns fallback for -Infinity", () => {
      expect(normalizeNumber(-Infinity, 42, 0, 100)).toBe(42);
    });

    it("returns min when value equals min", () => {
      expect(normalizeNumber(0, 42, 0, 100)).toBe(0);
    });
  });

  describe("normalizeBoolean", () => {

    it("returns the value when false", () => {
      expect(normalizeBoolean(false, true)).toBe(false);
    });

    it("returns fallback for undefined", () => {
      expect(normalizeBoolean(undefined, true)).toBe(true);
    });
  });

  describe("normalizeRoomNameList", () => {

    it("returns empty array when all entries are invalid", () => {
      expect(normalizeRoomNameList([42, null, ""])).toEqual([]);
    });
  });
});
