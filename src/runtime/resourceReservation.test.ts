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
    it("creates a reservation", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      const entries = listProductionReservations();
      expect(entries).toHaveLength(1);
      expect(entries[0].amount).toBe(500);
      expect(entries[0].holderId).toBe("carrier1");
      expect(entries[0].roomName).toBe("E4N58");
      expect(entries[0].resource).toBe("energy");
      expect(entries[0].expiresAt).toBe(Game.time + 200);
    });

    it("atomically replaces same holder reservation", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 800, "carrier1");
      const entries = listProductionReservations();
      expect(entries).toHaveLength(1);
      expect(entries[0].amount).toBe(800);
    });

    it("allows different holders for same room/resource", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 300, "carrier2");
      const entries = listProductionReservations();
      expect(entries).toHaveLength(2);
    });

    it("rejects non-positive amounts", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 0, "carrier1");
      expect(listProductionReservations()).toHaveLength(0);
    });

    it("rejects negative amounts", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, -100, "carrier1");
      expect(listProductionReservations()).toHaveLength(0);
    });

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

    it("does nothing for non-existent reservation", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      releaseProductionReservation("E4N58", "energy" as ResourceConstant, "carrierX");
      expect(listProductionReservations()).toHaveLength(1);
    });
  });

  describe("renewProductionReservation", () => {
    it("extends expiry of existing reservation", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      Game.time = 1100;
      renewProductionReservation("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      const entries = listProductionReservations();
      expect(entries[0].expiresAt).toBe(Game.time + 200);
      expect(entries[0].updatedAt).toBe(Game.time);
    });

    it("renews with custom TTL", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      Game.time = 1100;
      renewProductionReservation("E4N58", "energy" as ResourceConstant, 500, "carrier1", 50);
      const entries = listProductionReservations();
      expect(entries[0].expiresAt).toBe(Game.time + 50);
    });
  });

  describe("getReservedProductionAmount", () => {
    it("sums all holder amounts for room/resource", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 300, "carrier2");
      expect(getReservedProductionAmount("E4N58", "energy" as ResourceConstant)).toBe(800);
    });

    it("returns 0 when no reservations exist", () => {
      expect(getReservedProductionAmount("E4N58", "energy" as ResourceConstant)).toBe(0);
    });

    it("excludes expired reservations", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      Game.time = 1500; // past default TTL of 200
      expect(getReservedProductionAmount("E4N58", "energy" as ResourceConstant)).toBe(0);
    });
  });

  describe("getReservedProductionAmountExcludingHolder", () => {
    it("sums excluding one holder", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 300, "carrier2");
      expect(
        getReservedProductionAmountExcludingHolder("E4N58", "energy" as ResourceConstant, "carrier1")
      ).toBe(300);
    });

    it("returns 0 when only holder is excluded", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      expect(
        getReservedProductionAmountExcludingHolder("E4N58", "energy" as ResourceConstant, "carrier1")
      ).toBe(0);
    });
  });

  describe("gcProductionReservations", () => {
    it("removes expired entries", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 300, "carrier2");
      Game.time = 1500; // both expired
      gcProductionReservations();
      expect(listProductionReservations()).toHaveLength(0);
    });

    it("keeps non-expired entries", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      Game.time = 1100; // still within TTL
      gcProductionReservations();
      expect(listProductionReservations()).toHaveLength(1);
    });

    it("handles partial expiry across rooms", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      reserveProductionResource("E4N59", "energy" as ResourceConstant, 300, "carrier2");
      Game.time = 1500; // both expired
      gcProductionReservations();
      expect(listProductionReservations()).toHaveLength(0);
    });
  });
});
