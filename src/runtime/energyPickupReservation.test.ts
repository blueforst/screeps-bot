import {
  clearPickupReservationStoreForTest,
  getPickupReservationClaimAmount,
  getReservedPickupTarget,
  releasePickupReservation,
  reservePickupTarget,
} from "@/runtime/energyPickupReservation";
import { clearCreepAssignmentStateForTest } from "@/runtime/creepAssignmentState";

function createEnergyStoreTarget(
  structureType: StructureConstant,
  energy: number,
): AnyStoreStructure {
  return {
    id: `target-${structureType}-${energy}`,
    structureType,
    pos: { x: 10, y: 10, roomName: "W1N1" },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? energy : resource === undefined ? energy : 0,
    },
  } as unknown as AnyStoreStructure;
}

describe("getPickupTargetEnergyAmount", () => {
  beforeEach(() => {
    clearCreepAssignmentStateForTest();
    clearPickupReservationStoreForTest();
  });

  it("keeps a below-50k Terminal reservation valid only with the same reserve override", () => {
    const terminal = createEnergyStoreTarget(STRUCTURE_TERMINAL, 20_500);
    const creep = {
      name: "recovery-carrier",
      room: { name: "W1N1" },
      memory: {},
    } as unknown as Creep;
    Game.creeps[creep.name] = creep;
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
      (id: string) => id === terminal.id ? terminal : null,
    ) as Game["getObjectById"];

    expect(
      reservePickupTarget(
        creep,
        terminal,
        800,
        { terminalEnergyReserve: 20_000 },
      ),
    ).toBe(true);
    expect(
      getReservedPickupTarget(creep, { terminalEnergyReserve: 20_000 }),
    ).toBe(terminal);
    expect(getReservedPickupTarget(creep)).toBeNull();
  });

  it("exposes the actual 800/200 claims for two same-tick recovery carriers", () => {
    const terminal = createEnergyStoreTarget(STRUCTURE_TERMINAL, 21_000);
    const first = {
      name: "recovery-carrier-1",
      room: { name: "W1N1" },
      memory: {},
    } as unknown as Creep;
    const second = {
      name: "recovery-carrier-2",
      room: { name: "W1N1" },
      memory: {},
    } as unknown as Creep;
    Game.creeps[first.name] = first;
    Game.creeps[second.name] = second;

    expect(reservePickupTarget(
      first,
      terminal,
      800,
      { terminalEnergyReserve: 20_000 },
    )).toBe(true);
    expect(reservePickupTarget(
      second,
      terminal,
      800,
      { terminalEnergyReserve: 20_000 },
    )).toBe(true);

    expect(getPickupReservationClaimAmount(first, terminal.id)).toBe(800);
    expect(getPickupReservationClaimAmount(second, terminal.id)).toBe(200);

    releasePickupReservation(first, terminal.id);
    expect(getPickupReservationClaimAmount(first, terminal.id)).toBe(0);
    expect(reservePickupTarget(
      second,
      terminal,
      800,
      { terminalEnergyReserve: 20_000 },
    )).toBe(true);
    expect(getPickupReservationClaimAmount(second, terminal.id)).toBe(800);
  });
});
