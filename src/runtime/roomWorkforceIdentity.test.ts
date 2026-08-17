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
    it("round-trips canonical source, slot, and sim identities", () => {
      const fixtures = [
        ["W1N1", "harvester", "source-a", "W1N1:harvester:source-a"],
        ["E4S58", "miner", "source-b", "E4S58:miner:source-b"],
        ["W0S0", "mineralHarvester", "mineral-a", "W0S0:mineralHarvester:mineral-a"],
        ["E7N58", "carrier", 0, "E7N58:carrier:0"],
        ["W12S34", "worker", 12, "W12S34:worker:12"],
        ["sim", "worker", 0, "sim:worker:0"],
      ] as const;
      for (const [roomName, role, discriminator, expectedConfigName] of fixtures) {
        const configName = formatRoomWorkforceConfigName(roomName, role, discriminator);

        expect(configName).toBe(expectedConfigName);
        expect(parseRoomWorkforceConfigIdentity(configName)).toEqual({
          roomName,
          role,
          discriminator,
        });
      }
    });

    it("rejects non-canonical numeric slots in parsing and formatting", () => {
      for (const configName of [
        "W1N1:carrier:00",
        "W1N1:worker:01",
        "W1N1:carrier:-1",
        "W1N1:worker:NaN",
        "W1N1:worker:+1",
        "W1N1:worker:1.0",
      ]) {
        expect(parseRoomWorkforceConfigIdentity(configName)).toBeUndefined();
      }
      for (const [role, discriminator] of [
        ["carrier", -1],
        ["worker", Number.NaN],
        ["worker", Number.POSITIVE_INFINITY],
      ] as const) {
        expect(() => formatRoomWorkforceConfigName("W1N1", role, discriminator)).toThrow();
      }
    });

    it("rejects manual, emergency, specialized, and multi-part namespaces", () => {
      for (const configName of [
        "W1N1:manual:maxcarrier:123",
        "W1N1:emergency:carrier:0",
        "W1N1:carrier:manual",
        "W1N1:worker:0:extra",
        "W1N1:harvester:source:a",
        "W1N1:remoteCarrier:source-a",
      ]) {
        expect(parseRoomWorkforceConfigIdentity(configName)).toBeUndefined();
      }
    });
  });

  describe("bootstrap ownership proof", () => {
    it("proves matching payload ownership, including orphaned canonical configs", () => {
      for (const [configName, role, args] of [
        ["W1N1:harvester:source-a", "harvester", ["source-a"]],
        ["W1N1:miner:source-b", "miner", ["source-b"]],
        ["W1N1:mineralHarvester:mineral-a", "mineralHarvester", ["mineral-a"]],
        ["W1N1:carrier:0", "carrier", []],
        ["W1N1:worker:3", "worker", []],
      ] as const) {
        expect(getOwnedRoomWorkforceConfigIdentity(
          configName,
          createConfig(role, [...args], "W1N1"),
        )).toEqual(parseRoomWorkforceConfigIdentity(configName));
      }
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

    it("fails safe on payload mismatch but treats exact namespace collisions as owned", () => {
      for (const [configName, config] of [
        ["W1N1:miner:source-a", createConfig("harvester", ["source-a"], "W1N1")],
        ["W1N1:harvester:source-a", createConfig("harvester", ["source-b"], "W1N1")],
        ["W1N1:harvester:source-a", createConfig("harvester", ["source-a", "extra"], "W1N1")],
        ["W1N1:carrier:0", createConfig("carrier", ["0"], "W1N1")],
        ["W1N1:worker:0", createConfig("worker", [], "W2N2")],
        ["W1N1:manual:maxcarrier:123", createConfig("carrier", [], "W1N1")],
      ] as const) {
        expect(getOwnedRoomWorkforceConfigIdentity(configName, config)).toBeUndefined();
      }
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
