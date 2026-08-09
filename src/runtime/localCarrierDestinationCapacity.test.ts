import {
  claimLocalCarrierDestinationCapacity,
  clearLocalCarrierDestinationCapacityForTest,
  getLocalCarrierDestinationAvailableAmount,
  getLocalCarrierDestinationCapacityObservation,
  getLocalCarrierDestinationCommittedAmount,
} from "@/runtime/localCarrierDestinationCapacity";
import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
} from "@/runtime/creepAssignmentState";

function createStorage(
  id: string,
  roomName: string,
  getFreeCapacity: () => number,
): StructureStorage {
  return {
    id,
    structureType: STRUCTURE_STORAGE,
    pos: { x: 10, y: 10, roomName } as RoomPosition,
    store: {
      getFreeCapacity,
      getUsedCapacity: () => 0,
    } as StoreDefinition,
  } as unknown as StructureStorage;
}

function createCarrier(
  name: string,
  roomName: string,
  resource: ResourceConstant,
  amount: number,
): Creep {
  return {
    name,
    room: { name: roomName } as Room,
    store: {
      getUsedCapacity: (requested?: ResourceConstant) =>
        requested === undefined || requested === resource ? amount : 0,
      getFreeCapacity: () => 1_000 - amount,
    } as StoreDefinition,
  } as unknown as Creep;
}

describe("localCarrierDestinationCapacity", () => {
  beforeEach(() => {
    clearLocalCarrierDestinationCapacityForTest();
    clearCreepAssignmentStateForTest();
    Game.creeps = {};
    Game.time = 100;
  });

  it("subtracts live accepted/in-flight cargo from destination capacity", () => {
    const storage = createStorage("storage-live", "W1N1", () => 1_000);
    const carrier = createCarrier(
      "carrier-live",
      "W1N1",
      RESOURCE_UTRIUM,
      600,
    );
    Game.creeps[carrier.name] = carrier;
    Object.assign(ensureCreepAssignmentState(carrier.name), {
      synthesisCarrierPendingToId: storage.id,
      synthesisCarrierPendingResource: RESOURCE_UTRIUM,
    });

    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(600);
    expect(
      getLocalCarrierDestinationAvailableAmount(
        storage,
        RESOURCE_HYDROGEN,
      ),
    ).toBe(400);
  });

  it("reuses a claimant's seeded delivery commitment without double subtraction", () => {
    const storage = createStorage("storage-seeded-owner", "W1N2", () => 1_000);
    const carrier = createCarrier(
      "carrier-seeded-owner",
      "W1N2",
      RESOURCE_ENERGY,
      600,
    );
    Game.creeps[carrier.name] = carrier;
    Object.assign(ensureCreepAssignmentState(carrier.name), {
      carrierPlanMode: "deliver",
      carrierPlanTargetKind: "structure",
      carrierPlanTargetId: storage.id,
    });

    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(600);
    const reused = claimLocalCarrierDestinationCapacity({
      claimantId: carrier.name,
      target: storage,
      resource: RESOURCE_ENERGY,
      requestedAmount: 600,
    });

    expect(reused?.amount).toBe(600);
    reused?.release();
    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(600);
    expect(
      getLocalCarrierDestinationAvailableAmount(storage, RESOURCE_ENERGY),
    ).toBe(400);
  });

  it("atomically allocates physical capacity across oversubscribed seeded deliveries", () => {
    const storage = createStorage("storage-seeded-shared", "W1N3", () => 1_000);
    for (const name of ["carrier-seeded-a", "carrier-seeded-b", "carrier-seeded-c"]) {
      const carrier = createCarrier(name, "W1N3", RESOURCE_ENERGY, 500);
      Game.creeps[name] = carrier;
      Object.assign(ensureCreepAssignmentState(name), {
        carrierPlanMode: "deliver",
        carrierPlanTargetKind: "structure",
        carrierPlanTargetId: storage.id,
      });
    }

    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(1_500);
    const first = claimLocalCarrierDestinationCapacity({
      claimantId: "carrier-seeded-a",
      target: storage,
      resource: RESOURCE_ENERGY,
      requestedAmount: 500,
    });
    first?.commit();
    const second = claimLocalCarrierDestinationCapacity({
      claimantId: "carrier-seeded-b",
      target: storage,
      resource: RESOURCE_ENERGY,
      requestedAmount: 500,
    });
    second?.commit();
    const third = claimLocalCarrierDestinationCapacity({
      claimantId: "carrier-seeded-c",
      target: storage,
      resource: RESOURCE_ENERGY,
      requestedAmount: 500,
    });

    expect(first?.amount).toBe(500);
    expect(second?.amount).toBe(500);
    expect(third).toBeNull();
  });

  it("releases a failed seeded transfer slice for another seeded carrier", () => {
    const storage = createStorage("storage-seeded-release", "W1N4", () => 500);
    for (const name of ["carrier-seeded-failed", "carrier-seeded-next"]) {
      const carrier = createCarrier(name, "W1N4", RESOURCE_ENERGY, 500);
      Game.creeps[name] = carrier;
      Object.assign(ensureCreepAssignmentState(name), {
        carrierPlanMode: "deliver",
        carrierPlanTargetKind: "structure",
        carrierPlanTargetId: storage.id,
      });
    }

    const failed = claimLocalCarrierDestinationCapacity({
      claimantId: "carrier-seeded-failed",
      target: storage,
      resource: RESOURCE_ENERGY,
      requestedAmount: 500,
    });
    failed?.release();
    const next = claimLocalCarrierDestinationCapacity({
      claimantId: "carrier-seeded-next",
      target: storage,
      resource: RESOURCE_ENERGY,
      requestedAmount: 500,
    });

    expect(failed?.amount).toBe(500);
    expect(next?.amount).toBe(500);
  });

  it("shares total Store capacity across resources and releases failed claims", () => {
    const storage = createStorage("storage-shared", "W2N2", () => 1_000);
    const first = claimLocalCarrierDestinationCapacity({
      claimantId: "carrier-H",
      target: storage,
      resource: RESOURCE_HYDROGEN,
      requestedAmount: 800,
    });
    const second = claimLocalCarrierDestinationCapacity({
      claimantId: "carrier-O",
      target: storage,
      resource: RESOURCE_OXYGEN,
      requestedAmount: 800,
    });

    expect(first?.amount).toBe(800);
    expect(second?.amount).toBe(200);
    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(1_000);

    second?.release();
    expect(
      getLocalCarrierDestinationAvailableAmount(storage, RESOURCE_OXYGEN),
    ).toBe(200);
    first?.release();
    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(0);
  });

  it("keeps accepted intents through the tick and rebuilds from live state next tick", () => {
    let physicalFree = 1_000;
    const storage = createStorage(
      "storage-accepted",
      "W3N3",
      () => physicalFree,
    );
    const accepted = claimLocalCarrierDestinationCapacity({
      claimantId: "carrier-accepted",
      target: storage,
      resource: RESOURCE_KEANIUM,
      requestedAmount: 600,
    });
    accepted?.commit();
    accepted?.release();

    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(600);
    expect(
      getLocalCarrierDestinationAvailableAmount(storage, RESOURCE_KEANIUM),
    ).toBe(400);

    physicalFree = 400;
    Game.time += 1;
    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(0);
    expect(
      getLocalCarrierDestinationAvailableAmount(storage, RESOURCE_KEANIUM),
    ).toBe(400);
  });

  it("releases a dead carrier commitment when the next tick is rebuilt", () => {
    const storage = createStorage("storage-death", "W4N4", () => 1_000);
    const carrier = createCarrier(
      "carrier-death",
      "W4N4",
      RESOURCE_ZYNTHIUM,
      700,
    );
    Game.creeps[carrier.name] = carrier;
    Object.assign(ensureCreepAssignmentState(carrier.name), {
      synthesisCarrierPendingToId: storage.id,
      synthesisCarrierPendingResource: RESOURCE_ZYNTHIUM,
    });
    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(700);

    delete Game.creeps[carrier.name];
    Game.time += 1;

    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(0);
    expect(
      getLocalCarrierDestinationAvailableAmount(storage, RESOURCE_ZYNTHIUM),
    ).toBe(1_000);
  });

  it("reports a pickup blocked by exhausted destination capacity", () => {
    const storage = createStorage("storage-full", "W5N5", () => 0);

    expect(
      claimLocalCarrierDestinationCapacity({
        claimantId: "carrier-blocked",
        target: storage,
        resource: RESOURCE_LEMERGIUM,
        requestedAmount: 500,
      }),
    ).toBeNull();
    expect(
      getLocalCarrierDestinationCapacityObservation("W5N5", storage.id),
    ).toMatchObject({
      tick: Game.time,
      committedAmount: 0,
      blockedPickupCount: 1,
    });
  });
});
