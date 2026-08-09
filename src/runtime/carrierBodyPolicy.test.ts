import {
  buildStandardCarrierBody,
  STANDARD_CARRIER_MAX_CAPACITY,
} from "@/runtime/carrierBodyPolicy";

function getCarryCapacity(body: BodyPartConstant[]): number {
  return body.filter((part) => part === CARRY).length * CARRY_CAPACITY;
}

describe("carrierBodyPolicy", () => {
  it("caps a high-energy carrier at 1000 capacity with a 1:1 body", () => {
    const body = buildStandardCarrierBody(5_600);

    expect(body).toHaveLength(40);
    expect(body.filter((part) => part === CARRY)).toHaveLength(20);
    expect(body.filter((part) => part === MOVE)).toHaveLength(20);
    expect(getCarryCapacity(body)).toBe(STANDARD_CARRIER_MAX_CAPACITY);
    expect(body.every((part, index) => part === (index % 2 === 0 ? CARRY : MOVE))).toBe(true);
  });

  it("scales down in complete CARRY/MOVE pairs without exceeding the energy budget", () => {
    const body = buildStandardCarrierBody(1_350);
    const cost = body.reduce((sum, part) => sum + BODYPART_COST[part], 0);

    expect(body.filter((part) => part === CARRY)).toHaveLength(13);
    expect(body.filter((part) => part === MOVE)).toHaveLength(13);
    expect(cost).toBe(1_300);
    expect(cost).toBeLessThanOrEqual(1_350);
  });
});
