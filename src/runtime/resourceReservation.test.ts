import {
  reserveProductionResource,
  releaseProductionReservation,
  renewProductionReservation,
  getReservedProductionAmount,
  getReservedProductionAmountExcludingHolder,
  gcProductionReservations,
  listProductionReservations,
} from "@/runtime/resourceReservation";

beforeEach(() => {
  Memory.runtime = {};
  Game.time = 1000;
});

describe("resourceReservation", () => {
  describe("reserveProductionResource", () => {

    it("uses custom TTL when provided", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1", 50);
      const entries = listProductionReservations();
      expect(entries[0].expiresAt).toBe(Game.time + 50);
    });
  });

  describe("releaseProductionReservation", () => {
    it("removes a specific holder reservation", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 300, "carrier2");
      releaseProductionReservation("E4N58", "energy" as ResourceConstant, "carrier1");
      const entries = listProductionReservations();
      expect(entries).toHaveLength(1);
      expect(entries[0].holderId).toBe("carrier2");
    });
  });

  describe("getReservedProductionAmount", () => {

    it("returns 0 when no reservations exist", () => {
      expect(getReservedProductionAmount("E4N58", "energy" as ResourceConstant)).toBe(0);
    });
  });
});
