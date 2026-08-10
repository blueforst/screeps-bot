import {
  formatRoomWorkforceConfigName,
  getOwnedRoomWorkforceConfigIdentity,
  parseRoomWorkforceConfigIdentity,
} from "@/runtime/roomWorkforceIdentity";
import type { CreepConfig, RoleName } from "@/types/system";

function createConfig(role: RoleName, args: string[], roomName?: string): CreepConfig {
  return roomName === undefined ? { role, args } : { role, args, roomName };
}

describe("roomWorkforceIdentity", () => {
  describe("canonical formatter/parser", () => {
    it.each([
      ["W1N1", "harvester", "source-a", "W1N1:harvester:source-a"],
      ["E4S58", "miner", "source-b", "E4S58:miner:source-b"],
      ["W0S0", "mineralHarvester", "mineral-a", "W0S0:mineralHarvester:mineral-a"],
      ["E7N58", "carrier", 0, "E7N58:carrier:0"],
      ["W12S34", "worker", 12, "W12S34:worker:12"],
    ] as const)(
      "round-trips %s %s identity",
      (roomName, role, discriminator, expectedConfigName) => {
        const configName = formatRoomWorkforceConfigName(roomName, role, discriminator);

        expect(configName).toBe(expectedConfigName);
        expect(parseRoomWorkforceConfigIdentity(configName)).toEqual({
          roomName,
          role,
          discriminator,
        });
      },
    );

    it("supports the Screeps sim room identity", () => {
      const configName = formatRoomWorkforceConfigName("sim", "worker", 0);

      expect(configName).toBe("sim:worker:0");
      expect(parseRoomWorkforceConfigIdentity(configName)).toEqual({
        roomName: "sim",
        role: "worker",
        discriminator: 0,
      });
    });

    it.each([
      ["W1N1:carrier:0", 0],
      ["W1N1:carrier:1", 1],
      ["W1N1:worker:42", 42],
    ] as const)("parses canonical numeric slot %s", (configName, discriminator) => {
      expect(parseRoomWorkforceConfigIdentity(configName)).toEqual({
        roomName: "W1N1",
        role: configName.includes(":carrier:") ? "carrier" : "worker",
        discriminator,
      });
    });

    it.each([
      "W1N1:carrier:00",
      "W1N1:worker:01",
      "W1N1:carrier:-1",
      "W1N1:worker:NaN",
      "W1N1:worker:+1",
      "W1N1:worker:1.0",
    ])("rejects non-canonical numeric slot %s", (configName) => {
      expect(parseRoomWorkforceConfigIdentity(configName)).toBeUndefined();
    });

    it.each([
      ["carrier", -1],
      ["worker", Number.NaN],
      ["worker", Number.POSITIVE_INFINITY],
    ] as const)("does not format invalid %s slot %s", (role, discriminator) => {
      expect(() => formatRoomWorkforceConfigName("W1N1", role, discriminator)).toThrow();
    });

    it.each([
      "W1N1:manual:maxcarrier:123",
      "W1N1:emergency:carrier:0",
      "W1N1:carrier:manual",
      "W1N1:worker:0:extra",
      "W1N1:harvester:source:a",
      "W1N1:remoteCarrier:source-a",
    ])("rejects manual, emergency, specialized, or multi-part identity %s", (configName) => {
      expect(parseRoomWorkforceConfigIdentity(configName)).toBeUndefined();
    });
  });

  describe("bootstrap ownership proof", () => {
    it.each([
      ["W1N1:harvester:source-a", "harvester", ["source-a"]],
      ["W1N1:miner:source-b", "miner", ["source-b"]],
      ["W1N1:mineralHarvester:mineral-a", "mineralHarvester", ["mineral-a"]],
      ["W1N1:carrier:0", "carrier", []],
      ["W1N1:worker:3", "worker", []],
    ] as const)("proves matching %s payload ownership", (configName, role, args) => {
      expect(
        getOwnedRoomWorkforceConfigIdentity(
          configName,
          createConfig(role, [...args], "W1N1"),
        ),
      ).toEqual(parseRoomWorkforceConfigIdentity(configName));
    });

    it("accepts an orphaned canonical config whose roomName is absent", () => {
      expect(
        getOwnedRoomWorkforceConfigIdentity(
          "W1N1:miner:source-a",
          createConfig("miner", ["source-a"]),
        ),
      ).toEqual({
        roomName: "W1N1",
        role: "miner",
        discriminator: "source-a",
      });
    });

    it.each([
      [
        "role mismatch",
        "W1N1:miner:source-a",
        createConfig("harvester", ["source-a"], "W1N1"),
      ],
      [
        "source args mismatch",
        "W1N1:harvester:source-a",
        createConfig("harvester", ["source-b"], "W1N1"),
      ],
      [
        "source args are not exact",
        "W1N1:harvester:source-a",
        createConfig("harvester", ["source-a", "extra"], "W1N1"),
      ],
      ["slot args mismatch", "W1N1:carrier:0", createConfig("carrier", ["0"], "W1N1")],
      ["roomName mismatch", "W1N1:worker:0", createConfig("worker", [], "W2N2")],
      [
        "non-canonical name",
        "W1N1:manual:maxcarrier:123",
        createConfig("carrier", [], "W1N1"),
      ],
    ] as const)("fails safe on %s", (_caseName, configName, config) => {
      expect(getOwnedRoomWorkforceConfigIdentity(configName, config)).toBeUndefined();
    });

    it("treats an exact canonical namespace collision as bootstrap-owned", () => {
      const manuallyWrittenButIndistinguishable: CreepConfig = {
        role: "worker",
        args: [],
        roomName: "W1N1",
      };

      expect(
        getOwnedRoomWorkforceConfigIdentity(
          "W1N1:worker:0",
          manuallyWrittenButIndistinguishable,
        ),
      ).toEqual({
        roomName: "W1N1",
        role: "worker",
        discriminator: 0,
      });
    });
  });
});
