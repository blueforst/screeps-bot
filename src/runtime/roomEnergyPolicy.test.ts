import { resolveRoomEnergyPolicy } from "@/runtime/roomEnergyPolicy";

describe("resolveRoomEnergyPolicy", () => {
  it("returns the existing resource-control defaults when config is absent", () => {
    expect(resolveRoomEnergyPolicy(undefined)).toEqual({
      energyFloor: 120_000,
      energyTarget: 200_000,
      energyExportStart: 250_000,
      terminalEnergyReserve: 20_000,
    });
  });

  it("normalizes room overrides into floor target export order", () => {
    expect(
      resolveRoomEnergyPolicy({
        energyFloor: 210_000,
        energyTarget: 190_000,
        energyExportStart: 195_000,
        terminalEnergyReserve: 12_345,
      }),
    ).toEqual({
      energyFloor: 210_000,
      energyTarget: 210_000,
      energyExportStart: 210_000,
      terminalEnergyReserve: 12_345,
    });
  });

  it("clamps invalid values with the existing resource-control bounds", () => {
    expect(
      resolveRoomEnergyPolicy({
        energyFloor: -1,
        energyTarget: Number.POSITIVE_INFINITY,
        energyExportStart: 4_000_000,
        terminalEnergyReserve: 400_000,
      }),
    ).toEqual({
      energyFloor: 0,
      energyTarget: 200_000,
      energyExportStart: 3_000_000,
      terminalEnergyReserve: 300_000,
    });
  });
});
