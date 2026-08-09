import {
  POWER_BANK_BODY_RCL6,
  POWER_BANK_BODY_RCL7,
  POWER_BANK_BODY_RCL8,
  POWER_BANK_PATROL_ROOMS,
  POWER_BANK_STATUS,
  POWER_BANK_BOOST_REQUIREMENTS,
  getPowerBankConfigName,
  getPowerBankTaskToken,
} from "@/runtime/powerBankConstants";

function bodyCost(parts: BodyPartConstant[]): number {
  return parts.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

function countPart(parts: BodyPartConstant[], type: BodyPartConstant): number {
  return parts.filter((p) => p === type).length;
}

describe("powerBankConstants", () => {

  describe("getPowerBankConfigName", () => {
    it("returns expected config name format", () => {
      expect(getPowerBankConfigName("W1N1", "E3N60", "attacker", 0)).toBe(
        "W1N1:powerbank:E3N60:attacker:0",
      );
    });

    it("adds a stable task owner and generation when supplied", () => {
      const ownerToken = getPowerBankTaskToken("bank-task-a");

      expect(getPowerBankConfigName("W1N1", "E3N60", "attacker", 0, "bank-task-a", 2)).toBe(
        `W1N1:powerbank:E3N60:attacker:0:owner:${ownerToken}:g2`,
      );
      expect(getPowerBankConfigName("W1N1", "E3N60", "attacker", 0, "bank-task-a", 2)).toBe(
        getPowerBankConfigName("W1N1", "E3N60", "attacker", 0, "bank-task-a", 2),
      );
    });

    it("does not collide for concurrent tasks or combat generations", () => {
      const taskA = getPowerBankConfigName("W1N1", "E3N60", "healer", 0, "bank-task-a", 0);
      const taskB = getPowerBankConfigName("W1N1", "E3N60", "healer", 0, "bank-task-b", 0);
      const nextGeneration = getPowerBankConfigName("W1N1", "E3N60", "healer", 0, "bank-task-a", 1);

      expect(new Set([taskA, taskB, nextGeneration])).toHaveProperty("size", 3);
    });

    it("defaults invalid or omitted owner generations to zero", () => {
      const expected = getPowerBankConfigName("W1N1", "E3N60", "hauler", 3, "bank-task-a", 0);

      expect(getPowerBankConfigName("W1N1", "E3N60", "hauler", 3, "bank-task-a")).toBe(expected);
      expect(getPowerBankConfigName("W1N1", "E3N60", "hauler", 3, "bank-task-a", -1)).toBe(expected);
      expect(getPowerBankConfigName("W1N1", "E3N60", "hauler", 3, "bank-task-a", Number.NaN)).toBe(expected);
    });
  });

  describe("POWER_BANK_PATROL_ROOMS", () => {
    it("has exactly 10 rooms E0N60-E9N60", () => {
      expect(POWER_BANK_PATROL_ROOMS).toEqual([
        "E0N60", "E1N60", "E2N60", "E3N60", "E4N60",
        "E5N60", "E6N60", "E7N60", "E8N60", "E9N60",
      ]);
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

    it("RCL8 healer has no boosts", () => {
      expect(POWER_BANK_BOOST_REQUIREMENTS[8].healer).toEqual([]);
    });
  });
});
