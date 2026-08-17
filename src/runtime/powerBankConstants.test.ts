import {
  getPowerBankConfigName,
} from "@/runtime/powerBankConstants";



describe("powerBankConstants", () => {

  describe("getPowerBankConfigName", () => {
    it("returns expected config name format", () => {
      expect(getPowerBankConfigName("W1N1", "E3N60", "attacker", 0)).toBe(
        "W1N1:powerbank:E3N60:attacker:0",
      );
    });

    it("defaults invalid or omitted owner generations to zero", () => {
      const expected = getPowerBankConfigName("W1N1", "E3N60", "hauler", 3, "bank-task-a", 0);

      expect(getPowerBankConfigName("W1N1", "E3N60", "hauler", 3, "bank-task-a")).toBe(expected);
      expect(getPowerBankConfigName("W1N1", "E3N60", "hauler", 3, "bank-task-a", -1)).toBe(expected);
      expect(getPowerBankConfigName("W1N1", "E3N60", "hauler", 3, "bank-task-a", Number.NaN)).toBe(expected);
    });
  });
});
