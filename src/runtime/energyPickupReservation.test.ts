import { getPickupTargetEnergyAmount } from "@/runtime/energyPickupReservation";

function createEnergyStoreTarget(
  structureType: StructureConstant,
  energy: number,
): AnyStoreStructure {
  return {
    structureType,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? energy : resource === undefined ? energy : 0,
    },
  } as unknown as AnyStoreStructure;
}

describe("getPickupTargetEnergyAmount", () => {
  it("exposes only terminal energy above the 50k reserve", () => {
    expect(getPickupTargetEnergyAmount(createEnergyStoreTarget(STRUCTURE_TERMINAL, 50_600))).toBe(600);
    expect(getPickupTargetEnergyAmount(createEnergyStoreTarget(STRUCTURE_TERMINAL, 50_000))).toBe(0);
    expect(getPickupTargetEnergyAmount(createEnergyStoreTarget(STRUCTURE_STORAGE, 50_600))).toBe(50_600);
  });
});
