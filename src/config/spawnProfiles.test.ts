import { spawnProfiles } from "@/config/spawnProfiles";

describe("spawnProfiles", () => {
  it("builds powerBankHauler up to the 50 body part hard limit", () => {
    const room = { energyCapacityAvailable: 12_000 } as Room;

    const body = spawnProfiles.powerBankHauler(room);

    expect(body).toHaveLength(50);
    expect(body.filter((part) => part === CARRY)).toHaveLength(25);
    expect(body.filter((part) => part === MOVE)).toHaveLength(25);
  });
});
