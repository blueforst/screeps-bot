import { roleRegistry } from "@/roles";
import { powerBankScoutRole } from "@/roles/powerBankScout";
import { upgraderRole } from "@/roles/upgrader";

describe("roleRegistry bindings", () => {
  it("binds powerBankScout to its patrol implementation", () => {
    expect(roleRegistry.powerBankScout).toBe(powerBankScoutRole);
  });

  it("keeps legacy hubUpgrader on the upgrader compatibility implementation", () => {
    expect(roleRegistry.hubUpgrader).toBe(upgraderRole);
  });
});
