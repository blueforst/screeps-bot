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
  it("keeps representative fixed and shared production body contracts", () => {
    const hubUpgrader = (
      spawnProfiles as unknown as Record<string, (room: Room) => BodyPartConstant[]>
    ).hubUpgrader;
    const room = makeRoom(5_600);
    const upgraderBody = hubUpgrader(room);
    const carrierBody = buildStandardCarrierBody(room.energyCapacityAvailable);

    expect(upgraderBody).toHaveLength(30);
    expect(upgraderBody.filter(part => part === WORK)).toHaveLength(15);
    expect(upgraderBody.filter(part => part === CARRY)).toHaveLength(5);
    expect(upgraderBody.filter(part => part === MOVE)).toHaveLength(10);
    expect(bodyCost(upgraderBody)).toBe(2_250);
    expect(spawnProfiles.carrier(room)).toEqual(carrierBody);
    expect(spawnProfiles.remoteCarrier(room)).toEqual(carrierBody);
    expect(carrierBody.filter(part => part === CARRY)).toHaveLength(20);
    expect(carrierBody.filter(part => part === MOVE)).toHaveLength(20);

    const boostedMiner = getLinkMinerBodyForRegenSourceLevel(4);
    expect(getLinkMinerWorkPartsForRegenSourceLevel(4)).toBe(12);
    expect(boostedMiner.filter(part => part === WORK)).toHaveLength(12);
    expect(boostedMiner.filter(part => part === CARRY)).toHaveLength(8);
    expect(boostedMiner.filter(part => part === MOVE)).toHaveLength(10);
    expect(bodyCost(boostedMiner)).toBe(2_100);
  });

  it("keeps complete-unit scaling boundaries and minimum-body fallbacks", () => {
    for (const [energyCapacity, unitCount, expectedCost] of [
      [3_999, 15, 3_750],
      [4_000, 16, 4_000],
      [4_250, 16, 4_000],
    ] as const) {
      const room = makeRoom(energyCapacity);
      const body = spawnProfiles.mineralHarvester(room);

      expect(body).toEqual(
        Array.from({ length: unitCount }, () => [WORK, WORK, MOVE]).flat(),
      );
      expect(bodyCost(body)).toBe(expectedCost);
      expect(bodyCost(body)).toBeLessThanOrEqual(room.energyCapacityAvailable);
    }

    const reserverRoom = makeRoom(100);
    const workerRoom = makeRoom(200);
    expect(spawnProfiles.remoteMiningReserver(reserverRoom)).toEqual([WORK, CARRY, MOVE]);
    expect(spawnProfiles.remoteWorker(workerRoom)).toEqual([WORK, CARRY, MOVE]);
  });
});
