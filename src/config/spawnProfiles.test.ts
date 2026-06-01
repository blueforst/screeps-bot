import { spawnProfiles } from "@/config/spawnProfiles";

function bodyCost(body: BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

function makeRoom(energyCapacityAvailable: number): Room {
  return { energyCapacityAvailable } as Room;
}

describe("spawnProfiles", () => {
  it("builds powerBankHauler up to the 50 body part hard limit", () => {
    const room = makeRoom(12_000);

    const body = spawnProfiles.powerBankHauler(room);

    expect(body).toHaveLength(50);
    expect(body.filter((part) => part === CARRY)).toHaveLength(25);
    expect(body.filter((part) => part === MOVE)).toHaveLength(25);
  });

  describe("worker (oneOneOneBody)", () => {
    it("at high energy capacity (5600) produces a valid body within 50 parts and energy budget", () => {
      const room = makeRoom(5600);

      const body = spawnProfiles.worker(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(5600);
    });

    it("at extreme energy capacity never exceeds 50 parts", () => {
      const room = makeRoom(50_000);

      const body = spawnProfiles.worker(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(50_000);
    });
  });

  describe("mineralHarvester (twoToOneWorkMoveBody)", () => {
    it("at high energy capacity (5600) produces a valid body within 50 parts and energy budget", () => {
      const room = makeRoom(5600);

      const body = spawnProfiles.mineralHarvester(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(5600);
    });

    it("at extreme energy capacity never exceeds 50 parts", () => {
      const room = makeRoom(50_000);

      const body = spawnProfiles.mineralHarvester(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(50_000);
    });
  });

  describe("colonizerWorker (oneOneOneBody)", () => {
    it("at high energy capacity never exceeds 50 parts", () => {
      const room = makeRoom(5600);

      const body = spawnProfiles.colonizerWorker(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(5600);
    });
  });

  describe("homeDefender", () => {
    it("at extreme energy capacity never exceeds 50 parts", () => {
      const room = makeRoom(50_000);

      const body = spawnProfiles.homeDefender(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(50_000);
    });
  });
});
