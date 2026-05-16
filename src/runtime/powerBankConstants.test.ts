import {
  POWER_BANK_BODY_RCL6,
  POWER_BANK_BODY_RCL7,
  POWER_BANK_BODY_RCL8,
  POWER_BANK_PATROL_ROOMS,
  POWER_BANK_STATUS,
  POWER_BANK_BOOST_REQUIREMENTS,
  getPowerBankConfigName,
} from "@/runtime/powerBankConstants";

function bodyCost(parts: BodyPartConstant[]): number {
  return parts.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

function countPart(parts: BodyPartConstant[], type: BodyPartConstant): number {
  return parts.filter((p) => p === type).length;
}

describe("powerBankConstants", () => {
  describe("RCL6 attacker", () => {
    it("costs 2190 energy", () => {
      expect(bodyCost(POWER_BANK_BODY_RCL6.attacker)).toBe(2190);
    });

    it("has 38 parts", () => {
      expect(POWER_BANK_BODY_RCL6.attacker.length).toBe(38);
    });

    it("has TOUGHx4, ATTACKx15, MOVEx19", () => {
      expect(countPart(POWER_BANK_BODY_RCL6.attacker, TOUGH)).toBe(4);
      expect(countPart(POWER_BANK_BODY_RCL6.attacker, ATTACK)).toBe(15);
      expect(countPart(POWER_BANK_BODY_RCL6.attacker, MOVE)).toBe(19);
    });
  });

  describe("RCL7 attacker", () => {
    it("costs 2320 energy", () => {
      expect(bodyCost(POWER_BANK_BODY_RCL7.attacker)).toBe(2320);
    });

    it("has 40 parts", () => {
      expect(POWER_BANK_BODY_RCL7.attacker.length).toBe(40);
    });

    it("has TOUGHx4, ATTACKx16, MOVEx20", () => {
      expect(countPart(POWER_BANK_BODY_RCL7.attacker, TOUGH)).toBe(4);
      expect(countPart(POWER_BANK_BODY_RCL7.attacker, ATTACK)).toBe(16);
      expect(countPart(POWER_BANK_BODY_RCL7.attacker, MOVE)).toBe(20);
    });
  });

  describe("RCL8 attacker", () => {
    it("costs 2320 energy (same as RCL7)", () => {
      expect(bodyCost(POWER_BANK_BODY_RCL8.attacker)).toBe(2320);
    });

    it("has 40 parts (same as RCL7)", () => {
      expect(POWER_BANK_BODY_RCL8.attacker.length).toBe(40);
    });

    it("has TOUGHx4, ATTACKx16, MOVEx20", () => {
      expect(countPart(POWER_BANK_BODY_RCL8.attacker, TOUGH)).toBe(4);
      expect(countPart(POWER_BANK_BODY_RCL8.attacker, ATTACK)).toBe(16);
      expect(countPart(POWER_BANK_BODY_RCL8.attacker, MOVE)).toBe(20);
    });
  });

  describe("RCL6 healer", () => {
    it("costs 2100 energy", () => {
      expect(bodyCost(POWER_BANK_BODY_RCL6.healer)).toBe(2100);
    });

    it("has 14 parts", () => {
      expect(POWER_BANK_BODY_RCL6.healer.length).toBe(14);
    });

    it("has HEALx7, MOVEx7", () => {
      expect(countPart(POWER_BANK_BODY_RCL6.healer, HEAL)).toBe(7);
      expect(countPart(POWER_BANK_BODY_RCL6.healer, MOVE)).toBe(7);
    });
  });

  describe("RCL7 healer", () => {
    it("costs 2100 energy (same as RCL6)", () => {
      expect(bodyCost(POWER_BANK_BODY_RCL7.healer)).toBe(2100);
    });

    it("has 14 parts (same as RCL6)", () => {
      expect(POWER_BANK_BODY_RCL7.healer.length).toBe(14);
    });
  });

  describe("RCL8 healer", () => {
    it("costs 7500 energy", () => {
      expect(bodyCost(POWER_BANK_BODY_RCL8.healer)).toBe(7500);
    });

    it("has 50 parts", () => {
      expect(POWER_BANK_BODY_RCL8.healer.length).toBe(50);
    });

    it("has HEALx25, MOVEx25", () => {
      expect(countPart(POWER_BANK_BODY_RCL8.healer, HEAL)).toBe(25);
      expect(countPart(POWER_BANK_BODY_RCL8.healer, MOVE)).toBe(25);
    });
  });

  describe("getPowerBankConfigName", () => {
    it("returns expected config name format", () => {
      expect(getPowerBankConfigName("W1N1", "E3N60", "attacker", 0)).toBe(
        "W1N1:powerbank:E3N60:attacker:0",
      );
    });

    it("includes index in the name", () => {
      expect(getPowerBankConfigName("W1N1", "E3N60", "hauler", 3)).toBe(
        "W1N1:powerbank:E3N60:hauler:3",
      );
    });
  });

  describe("POWER_BANK_PATROL_ROOMS", () => {
    it("has exactly 10 rooms E0N60-E9N60", () => {
      expect(POWER_BANK_PATROL_ROOMS).toEqual([
        "E0N60", "E1N60", "E2N60", "E3N60", "E4N60",
        "E5N60", "E6N60", "E7N60", "E8N60", "E9N60",
      ]);
    });

    it("has length 10", () => {
      expect(POWER_BANK_PATROL_ROOMS.length).toBe(10);
    });
  });

  describe("POWER_BANK_STATUS", () => {
    it("contains all expected statuses", () => {
      expect(Object.values(POWER_BANK_STATUS)).toEqual(
        expect.arrayContaining([
          "discovered", "preparing_boosts", "spawning", "boosting",
          "renewing", "travelling", "attacking", "hauling",
          "complete", "failed", "aborted",
        ]),
      );
    });
  });

  describe("POWER_BANK_BOOST_REQUIREMENTS", () => {
    it("RCL6 attacker uses catalyzed ghodium acid + catalyzed utrium acid", () => {
      expect(POWER_BANK_BOOST_REQUIREMENTS[6].attacker).toEqual([
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
        RESOURCE_CATALYZED_UTRIUM_ACID,
      ]);
    });

    it("RCL6 healer uses catalyzed lemergium alkalide", () => {
      expect(POWER_BANK_BOOST_REQUIREMENTS[6].healer).toEqual([
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ]);
    });

    it("RCL8 healer has no boosts", () => {
      expect(POWER_BANK_BOOST_REQUIREMENTS[8].healer).toEqual([]);
    });
  });
});
