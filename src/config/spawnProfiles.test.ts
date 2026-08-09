import {
  getLinkMinerBodyForRegenSourceLevel,
  getLinkMinerWorkPartsForRegenSourceLevel,
  spawnProfiles,
} from "@/config/spawnProfiles";
import { buildStandardCarrierBody } from "@/runtime/carrierBodyPolicy";

function bodyCost(body: BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

function makeRoom(energyCapacityAvailable: number): Room {
  return { energyCapacityAvailable } as Room;
}

describe("spawnProfiles", () => {
  it("builds the fixed 15 WORK, 5 CARRY, 10 MOVE hub upgrader body", () => {
    const profile = (spawnProfiles as unknown as Record<string, (room: Room) => BodyPartConstant[]>).hubUpgrader;

    expect(profile).toBeDefined();

    const body = profile(makeRoom(5600));
    expect(body).toHaveLength(30);
    expect(body.filter((part) => part === WORK)).toHaveLength(15);
    expect(body.filter((part) => part === CARRY)).toHaveLength(5);
    expect(body.filter((part) => part === MOVE)).toHaveLength(10);
    expect(bodyCost(body)).toBe(2250);
  });

  describe("worker (oneOneOneBody)", () => {
    it("at high energy capacity (5600) produces a valid body within 50 parts and energy budget", () => {
      const room = makeRoom(5600);

      const body = spawnProfiles.worker(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(5600);
    });
  });

  describe("carrier", () => {
    it("uses the shared 1000-capacity body for carrier and remoteCarrier", () => {
      const room = makeRoom(5_600);
      const expected = buildStandardCarrierBody(room.energyCapacityAvailable);

      expect(spawnProfiles.carrier(room)).toEqual(expected);
      expect(spawnProfiles.remoteCarrier(room)).toEqual(expected);
      expect(expected.filter((part) => part === CARRY)).toHaveLength(20);
      expect(expected.filter((part) => part === MOVE)).toHaveLength(20);
    });
  });

  describe("mineralHarvester (twoToOneWorkMoveBody)", () => {
    it("at high energy capacity (5600) produces a valid body within 50 parts and energy budget", () => {
      const room = makeRoom(5600);

      const body = spawnProfiles.mineralHarvester(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(5600);
    });
  });

  describe("miner (REGEN_SOURCE throughput)", () => {
    it("builds the base body as 6 WORK, 8 CARRY, and 7 MOVE", () => {
      const body = getLinkMinerBodyForRegenSourceLevel(0);

      expect(body.filter((part) => part === WORK)).toHaveLength(6);
      expect(body.filter((part) => part === CARRY)).toHaveLength(8);
      expect(body.filter((part) => part === MOVE)).toHaveLength(7);
      expect(body).toHaveLength(21);
      expect(bodyCost(body)).toBe(1_350);
    });

    it("builds the level-4 body as 12 WORK, 8 CARRY, and 10 MOVE", () => {
      const body = getLinkMinerBodyForRegenSourceLevel(4);

      expect(getLinkMinerWorkPartsForRegenSourceLevel(4)).toBe(12);
      expect(body.filter((part) => part === WORK)).toHaveLength(12);
      expect(body.filter((part) => part === CARRY)).toHaveLength(8);
      expect(body.filter((part) => part === MOVE)).toHaveLength(10);
      expect(body).toHaveLength(30);
      expect(bodyCost(body)).toBe(2_100);
    });
  });

  describe("remoteMiningReserver", () => {
    it("returns fallback body when energy is insufficient for even one CLAIM+MOVE pair", () => {
      const room = makeRoom(100);

      const body = spawnProfiles.remoteMiningReserver(room);

      expect(body).toEqual([WORK, CARRY, MOVE]);
    });
  });

  describe("remoteDefender", () => {
    it("builds a single RCL7 defender with enough damage budget for a level 0 Invader Core", () => {
      const body = spawnProfiles.remoteDefender(makeRoom(5_300));
      const rangedParts = body.filter(part => part === RANGED_ATTACK).length;
      const healParts = body.filter(part => part === HEAL).length;
      const moveParts = body.filter(part => part === MOVE).length;
      const ticksToClear = Math.ceil(100_000 / (rangedParts * RANGED_ATTACK_POWER));

      expect(bodyCost(body)).toBe(5_300);
      expect(rangedParts).toBe(16);
      expect(healParts).toBe(7);
      expect(moveParts).toBe(23);
      expect(ticksToClear).toBe(625);
      expect(ticksToClear).toBeLessThan(CREEP_LIFE_TIME - 250);
    });
  });

  describe("remoteWorker", () => {

    it("at low energy (200) returns minimum fallback [WORK, CARRY, MOVE]", () => {
      const room = makeRoom(200);

      const body = spawnProfiles.remoteWorker(room);

      expect(body).toEqual([WORK, CARRY, MOVE]);
    });
  });
});
