import {
  getLinkMinerBodyForRegenSourceLevel,
  getLinkMinerWorkPartsForRegenSourceLevel,
  spawnProfiles,
} from "@/config/spawnProfiles";

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

  describe("mineralHarvester (twoToOneWorkMoveBody)", () => {
    it("at high energy capacity (5600) produces a valid body within 50 parts and energy budget", () => {
      const room = makeRoom(5600);

      const body = spawnProfiles.mineralHarvester(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(5600);
    });
  });

  describe("miner (REGEN_SOURCE throughput)", () => {

    it("builds the level-4 body as 12 WORK, 6 CARRY, and 5 MOVE", () => {
      const body = getLinkMinerBodyForRegenSourceLevel(4);

      expect(body.filter((part) => part === WORK)).toHaveLength(12);
      expect(body.filter((part) => part === CARRY)).toHaveLength(6);
      expect(body.filter((part) => part === MOVE)).toHaveLength(5);
      expect(body).toHaveLength(23);
      expect(bodyCost(body)).toBe(1750);
    });
  });

  describe("remoteMiningReserver", () => {
    it("returns fallback body when energy is insufficient for even one CLAIM+MOVE pair", () => {
      const room = makeRoom(100);

      const body = spawnProfiles.remoteMiningReserver(room);

      expect(body).toEqual([WORK, CARRY, MOVE]);
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
