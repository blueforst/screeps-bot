import { normalizeNumber, normalizeBoolean, normalizeRoomNameList } from "@/runtime/configNormalize";

describe("configNormalize", () => {
  describe("normalizeNumber", () => {
    it("returns fallback for undefined", () => {
      expect(normalizeNumber(undefined, 42, 0, 100)).toBe(42);
    });

    it("returns fallback for null", () => {
      expect(normalizeNumber(null, 42, 0, 100)).toBe(42);
    });

    it("returns fallback for string", () => {
      expect(normalizeNumber("5", 42, 0, 100)).toBe(42);
    });

    it("returns fallback for NaN", () => {
      expect(normalizeNumber(NaN, 42, 0, 100)).toBe(42);
    });

    it("returns fallback for Infinity", () => {
      expect(normalizeNumber(Infinity, 42, 0, 100)).toBe(42);
    });

    it("returns fallback for -Infinity", () => {
      expect(normalizeNumber(-Infinity, 42, 0, 100)).toBe(42);
    });

    it("clamps to min when below", () => {
      expect(normalizeNumber(-5, 42, 0, 100)).toBe(0);
    });

    it("clamps to max when above", () => {
      expect(normalizeNumber(200, 42, 0, 100)).toBe(100);
    });

    it("floors fractional values", () => {
      expect(normalizeNumber(3.7, 42, 0, 100)).toBe(3);
    });

    it("floors negative fractional toward negative", () => {
      expect(normalizeNumber(-0.5, 42, -10, 10)).toBe(-1);
    });

    it("returns valid integer as-is", () => {
      expect(normalizeNumber(50, 42, 0, 100)).toBe(50);
    });

    it("returns min when value equals min", () => {
      expect(normalizeNumber(0, 42, 0, 100)).toBe(0);
    });

    it("returns max when value equals max", () => {
      expect(normalizeNumber(100, 42, 0, 100)).toBe(100);
    });

    it("floors then clamps", () => {
      expect(normalizeNumber(100.9, 42, 0, 100)).toBe(100);
    });
  });

  describe("normalizeBoolean", () => {
    it("returns the value when true", () => {
      expect(normalizeBoolean(true, false)).toBe(true);
    });

    it("returns the value when false", () => {
      expect(normalizeBoolean(false, true)).toBe(false);
    });

    it("returns fallback for undefined", () => {
      expect(normalizeBoolean(undefined, true)).toBe(true);
    });

    it("returns fallback for null", () => {
      expect(normalizeBoolean(null, false)).toBe(false);
    });

    it("returns fallback for string", () => {
      expect(normalizeBoolean("true", false)).toBe(false);
    });

    it("returns fallback for number", () => {
      expect(normalizeBoolean(1, false)).toBe(false);
    });
  });

  describe("normalizeRoomNameList", () => {
    it("returns empty array for undefined", () => {
      expect(normalizeRoomNameList(undefined)).toEqual([]);
    });

    it("returns empty array for null", () => {
      expect(normalizeRoomNameList(null)).toEqual([]);
    });

    it("returns empty array for string", () => {
      expect(normalizeRoomNameList("W1N1")).toEqual([]);
    });

    it("returns empty array for object", () => {
      expect(normalizeRoomNameList({})).toEqual([]);
    });

    it("filters out non-string entries", () => {
      expect(normalizeRoomNameList(["W1N1", 42, null, "W2N2"])).toEqual(["W1N1", "W2N2"]);
    });

    it("filters out empty strings", () => {
      expect(normalizeRoomNameList(["W1N1", "", "W2N2"])).toEqual(["W1N1", "W2N2"]);
    });

    it("returns valid string list", () => {
      expect(normalizeRoomNameList(["W1N1", "W2N2", "E3S4"])).toEqual(["W1N1", "W2N2", "E3S4"]);
    });

    it("returns empty array when all entries are invalid", () => {
      expect(normalizeRoomNameList([42, null, ""])).toEqual([]);
    });
  });
});
