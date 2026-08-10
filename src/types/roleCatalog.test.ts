import {
  ROLE_CATALOG,
  isRoleName,
  type RoleName,
} from "@/types/roleCatalog";

const EXPECTED_ROLES = [
  "harvester",
  "mineralHarvester",
  "miner",
  "carrier",
  "worker",
  "upgrader",
  "hubUpgrader",
  "scout",
  "claimer",
  "colonizerHarvester",
  "colonizerWorker",
  "meleeAttacker",
  "healer",
  "homeDefender",
  "crossShardClaimer",
  "crossShardColonizerHarvester",
  "crossShardColonizerWorker",
  "flagScout",
  "remoteCarrier",
  "remoteMiningCarrier",
  "powerBankScout",
  "powerBankAttacker",
  "powerBankHealer",
  "powerBankHauler",
  "remoteMiningReserver",
  "remoteWorker",
  "remoteDefender",
] as const;

type ExpectedRoleName = (typeof EXPECTED_ROLES)[number];
type ExpectedRoleGuard = (value: unknown) => value is RoleName;
type IsExactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

const roleNameMatchesExpected: IsExactly<RoleName, ExpectedRoleName> = true;
const roleGuardMatchesExpected: IsExactly<typeof isRoleName, ExpectedRoleGuard> = true;

function assertRoleNameNarrowing(value: unknown): void {
  if (isRoleName(value)) {
    const roleName: RoleName = value;
    void roleName;
  }
}

void roleNameMatchesExpected;
void roleGuardMatchesExpected;
void assertRoleNameNarrowing;

describe("roleCatalog", () => {
  it("contains exactly the 27 supported role identities", () => {
    expect(Object.keys(ROLE_CATALOG).sort()).toEqual(
      [...EXPECTED_ROLES].sort(),
    );
  });

  it("marks hubUpgrader as the only legacy role and the other 26 roles as active", () => {
    const activeRoles = Object.entries(ROLE_CATALOG)
      .filter(([, lifecycle]) => lifecycle === "active")
      .map(([role]) => role)
      .sort();
    const legacyRoles = Object.entries(ROLE_CATALOG)
      .filter(([, lifecycle]) => lifecycle === "legacy")
      .map(([role]) => role);

    expect(activeRoles).toEqual(
      EXPECTED_ROLES.filter((role) => role !== "hubUpgrader").sort(),
    );
    expect(activeRoles).toHaveLength(26);
    expect(legacyRoles).toEqual(["hubUpgrader"]);
  });

  it("exposes a frozen catalog", () => {
    expect(Object.isFrozen(ROLE_CATALOG)).toBe(true);
  });

  describe("isRoleName", () => {
    it.each(EXPECTED_ROLES)("accepts supported role %s", (role) => {
      expect(isRoleName(role)).toBe(true);
    });

    it.each(["unknownRole", "", "constructor", "toString", "__proto__"])(
      "rejects unsupported or inherited string key %s",
      (value) => {
        expect(isRoleName(value)).toBe(false);
      },
    );

    it.each([undefined, null, 0, 1, true, false, {}, [], Symbol("role")])(
      "rejects non-string input %#",
      (value) => {
        expect(isRoleName(value)).toBe(false);
      },
    );
  });
});
