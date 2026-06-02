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

  describe("remoteMiningCarrier", () => {
    it("has exactly one WORK part", () => {
      const room = makeRoom(3000);

      const body = spawnProfiles.remoteMiningCarrier(room);

      expect(body.filter((part) => part === WORK)).toHaveLength(1);
    });

    it("has at least one CARRY and one MOVE", () => {
      const room = makeRoom(300);

      const body = spawnProfiles.remoteMiningCarrier(room);

      expect(body.filter((part) => part === CARRY).length).toBeGreaterThanOrEqual(1);
      expect(body.filter((part) => part === MOVE).length).toBeGreaterThanOrEqual(1);
    });

    it("MOVE count satisfies 1:2 ratio with non-MOVE parts", () => {
      const room = makeRoom(3000);

      const body = spawnProfiles.remoteMiningCarrier(room);

      const carries = body.filter((p) => p === CARRY).length;
      const works = body.filter((p) => p === WORK).length;
      const moves = body.filter((p) => p === MOVE).length;
      const nonMove = works + carries;
      expect(moves).toBe(Math.ceil(nonMove / 2));
    });

    it("at 3000 energy produces 1 WORK, 32 CARRY, 17 MOVE (50 parts)", () => {
      const room = makeRoom(3000);

      const body = spawnProfiles.remoteMiningCarrier(room);

      expect(body).toHaveLength(50);
      expect(body.filter((p) => p === WORK)).toHaveLength(1);
      expect(body.filter((p) => p === CARRY)).toHaveLength(32);
      expect(body.filter((p) => p === MOVE)).toHaveLength(17);
      expect(bodyCost(body)).toBeLessThanOrEqual(3000);
    });

    it("at 300 energy includes 1 WORK, 2 CARRY, 2 MOVE", () => {
      const room = makeRoom(300);

      const body = spawnProfiles.remoteMiningCarrier(room);

      expect(body.filter((p) => p === WORK)).toHaveLength(1);
      expect(body.filter((p) => p === MOVE)).toHaveLength(2);
      expect(body.filter((p) => p === CARRY)).toHaveLength(2);
      expect(bodyCost(body)).toBeLessThanOrEqual(300);
    });

    it("never exceeds 50 parts at extreme energy capacity", () => {
      const room = makeRoom(50_000);

      const body = spawnProfiles.remoteMiningCarrier(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(body.filter((part) => part === WORK)).toHaveLength(1);
      expect(bodyCost(body)).toBeLessThanOrEqual(50_000);
    });

    it("stays within energy budget", () => {
      const room = makeRoom(3000);

      const body = spawnProfiles.remoteMiningCarrier(room);

      expect(bodyCost(body)).toBeLessThanOrEqual(3000);
    });
  });

  describe("remoteMiningReserver", () => {
    it("returns fallback body when energy is insufficient for even one CLAIM+MOVE pair", () => {
      const room = makeRoom(100);

      const body = spawnProfiles.remoteMiningReserver(room);

      expect(body).toEqual([WORK, CARRY, MOVE]);
    });

    it("returns one CLAIM+MOVE pair at exactly 650 energy", () => {
      const room = makeRoom(650);

      const body = spawnProfiles.remoteMiningReserver(room);

      expect(body.filter((p) => p === CLAIM)).toHaveLength(1);
      expect(body.filter((p) => p === MOVE)).toHaveLength(1);
      expect(bodyCost(body)).toBeLessThanOrEqual(650);
    });

    it("scales to two CLAIM+MOVE pairs at RCL7+ energy (1300+)", () => {
      const room = makeRoom(1300);

      const body = spawnProfiles.remoteMiningReserver(room);

      expect(body.filter((p) => p === CLAIM)).toHaveLength(2);
      expect(body.filter((p) => p === MOVE)).toHaveLength(2);
      expect(bodyCost(body)).toBeLessThanOrEqual(1300);
    });

    it("scales to three CLAIM+MOVE pairs at 1950+ energy", () => {
      const room = makeRoom(2000);

      const body = spawnProfiles.remoteMiningReserver(room);

      expect(body.filter((p) => p === CLAIM)).toHaveLength(3);
      expect(body.filter((p) => p === MOVE)).toHaveLength(3);
      expect(bodyCost(body)).toBeLessThanOrEqual(2000);
    });

    it("never exceeds three CLAIM+MOVE pairs even at extreme energy", () => {
      const room = makeRoom(50_000);

      const body = spawnProfiles.remoteMiningReserver(room);

      expect(body.filter((p) => p === CLAIM)).toHaveLength(3);
      expect(body.filter((p) => p === MOVE)).toHaveLength(3);
      expect(body.length).toBeLessThanOrEqual(50);
    });
  });

  describe("remoteDefender", () => {
    it("at 3000 energy produces 9 RANGED_ATTACK, 4 HEAL, 13 MOVE", () => {
      const room = makeRoom(3000);
      const body = spawnProfiles.remoteDefender(room);
      expect(body.filter((p) => p === RANGED_ATTACK)).toHaveLength(9);
      expect(body.filter((p) => p === HEAL)).toHaveLength(4);
      expect(body.filter((p) => p === MOVE)).toHaveLength(13);
      expect(bodyCost(body)).toBeLessThanOrEqual(3000);
    });

    it("at 3450 energy produces 10 RANGED_ATTACK, 4 HEAL, 14 MOVE", () => {
      const room = makeRoom(3450);
      const body = spawnProfiles.remoteDefender(room);
      expect(body.filter((p) => p === RANGED_ATTACK)).toHaveLength(10);
      expect(body.filter((p) => p === HEAL)).toHaveLength(4);
      expect(body.filter((p) => p === MOVE)).toHaveLength(14);
      expect(bodyCost(body)).toBeLessThanOrEqual(3450);
    });

    it("at 500 energy (minFull) produces [RA, HEAL, MOVE, MOVE]", () => {
      const room = makeRoom(500);
      const body = spawnProfiles.remoteDefender(room);
      expect(body).toEqual([RANGED_ATTACK, HEAL, MOVE, MOVE]);
    });

    it("at 200 energy returns [RANGED_ATTACK, MOVE]", () => {
      const room = makeRoom(200);
      const body = spawnProfiles.remoteDefender(room);
      expect(body).toEqual([RANGED_ATTACK, MOVE]);
    });

    it("between 200 and 499 energy returns [RANGED_ATTACK, MOVE]", () => {
      const room = makeRoom(400);
      const body = spawnProfiles.remoteDefender(room);
      expect(body).toEqual([RANGED_ATTACK, MOVE]);
    });

    it("never exceeds 50 parts at extreme energy capacity", () => {
      const room = makeRoom(50_000);
      const body = spawnProfiles.remoteDefender(room);
      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(50_000);
    });

    it("body order is all RANGED_ATTACK, then all HEAL, then all MOVE", () => {
      const room = makeRoom(3000);
      const body = spawnProfiles.remoteDefender(room);
      let seenHeal = false;
      let seenMove = false;
      for (const part of body) {
        if (part === HEAL) seenHeal = true;
        if (part === MOVE) seenMove = true;
        if (part === RANGED_ATTACK) {
          expect(seenHeal).toBe(false);
          expect(seenMove).toBe(false);
        }
        if (part === HEAL) {
          expect(seenMove).toBe(false);
        }
      }
    });

    it("heal count is at least 1 for any combat slot count", () => {
      const room = makeRoom(500);
      const body = spawnProfiles.remoteDefender(room);
      expect(body.filter((p) => p === HEAL).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("remoteWorker", () => {
    it("at RCL7+ (5600 capacity) produces exactly 10 WORK, 10 CARRY, 10 MOVE", () => {
      const room = makeRoom(5600);

      const body = spawnProfiles.remoteWorker(room);

      expect(body.filter((p) => p === WORK)).toHaveLength(10);
      expect(body.filter((p) => p === CARRY)).toHaveLength(10);
      expect(body.filter((p) => p === MOVE)).toHaveLength(10);
      expect(body).toHaveLength(30);
      expect(bodyCost(body)).toBeLessThanOrEqual(5600);
    });

    it("never exceeds 50 parts at extreme energy capacity", () => {
      const room = makeRoom(50_000);

      const body = spawnProfiles.remoteWorker(room);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(bodyCost(body)).toBeLessThanOrEqual(50_000);
    });

    it("at low energy (200) returns minimum fallback [WORK, CARRY, MOVE]", () => {
      const room = makeRoom(200);

      const body = spawnProfiles.remoteWorker(room);

      expect(body).toEqual([WORK, CARRY, MOVE]);
    });

    it("scales triplets with energy: at 1000 energy produces 5 triplets", () => {
      const room = makeRoom(1000);

      const body = spawnProfiles.remoteWorker(room);

      expect(body.filter((p) => p === WORK)).toHaveLength(5);
      expect(body.filter((p) => p === CARRY)).toHaveLength(5);
      expect(body.filter((p) => p === MOVE)).toHaveLength(5);
      expect(bodyCost(body)).toBeLessThanOrEqual(1000);
    });
  });
});
