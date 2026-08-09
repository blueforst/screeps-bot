import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { clearPickupReservationStoreForTest, getPickupReservationsByRoom } from "@/runtime/energyPickupReservation";
import { reserveProductionResource, listProductionReservations } from "@/runtime/resourceReservation";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createOwnedRoom(name: string): Room {
  return {
    name,
    memory: {} as RoomMemory,
    controller: {
      my: true,
      level: 8,
    } as StructureController,
    find: () => [],
  } as unknown as Room;
}

function createManagedCreep(configName: string, role: CreepMemory["role"]): Creep {
  return {
    memory: {
      configName,
      role,
    } as CreepMemory,
  } as unknown as Creep;
}

describe("runMemoryCleanup", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearPickupReservationStoreForTest();
    Game.time = 17;
    Game.rooms = {
      W1N1: createOwnedRoom("W1N1"),
    };
    Game.creeps = {};
    Game.spawns = {};
    getPickupReservationsByRoom("W2N2").target1 = {
      kind: "structure",
      claims: {
        DeadCarrier: {
          amount: 50,
          until: 10,
        },
      },
    };
    Memory.creeps = {};
    Memory.cfg = undefined;
    Memory.runtime = undefined;
    Memory.data = undefined;
  });

  it("removes foreign room pickup reservation memory after claims expire", () => {
    runMemoryCleanup();

    expect(getPickupReservationsByRoom("W2N2")).toEqual({});
  });

  it("removes expired production reservations via gcProductionReservations", () => {
    reserveProductionResource("W1N1", "energy" as ResourceConstant, 500, "expiredCarrier");
    const store = Memory.runtime!.resourceReservations!;
    store["W1N1:energy:expiredCarrier"].expiresAt = Game.time - 1;

    reserveProductionResource("W1N1", "energy" as ResourceConstant, 300, "activeCarrier");

    runMemoryCleanup();

    const remaining = listProductionReservations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].holderId).toBe("activeCarrier");
  });

  it("removes recovery runtime entries whose room flag is false or missing", () => {
    Memory.cfg = {
      energyPickup: {
        terminalBootstrapRecoveryRooms: {
          W1N1: true,
          W2N2: false,
        },
      },
    };
    Memory.runtime = {
      energyPickup: {
        terminalBootstrapRecovery: {
          W1N1: { healthySince: 10, lastObservedAt: 16 },
          W2N2: { healthySince: 11, lastObservedAt: 16 },
          W3N3: { healthySince: 12, lastObservedAt: 16 },
        },
      },
    };

    runMemoryCleanup();

    expect(Memory.runtime?.energyPickup?.terminalBootstrapRecovery).toEqual({
      W1N1: { healthySince: 10, lastObservedAt: 16 },
    });
  });

  it("removes empty recovery runtime containers during periodic cleanup", () => {
    Memory.cfg = {
      energyPickup: {
        terminalBootstrapRecoveryRooms: {},
      },
    };
    Memory.runtime = {
      energyPickup: {
        terminalBootstrapRecovery: {
          W2N2: { lastObservedAt: 16 },
        },
      },
    };

    runMemoryCleanup();

    expect(Memory.runtime?.energyPickup).toBeUndefined();
  });

  it("keeps supported non-legacy creep configs for active specialized roles", () => {
    Memory.data = {
      creepConfigs: {
        mineralConfig: { role: "mineralHarvester", args: [] },
        defenderConfig: { role: "homeDefender", args: [] },
        scoutConfig: { role: "flagScout", args: [] },
      },
    };
    Game.creeps = {
      MineralHarvester1: createManagedCreep("mineralConfig", "mineralHarvester"),
      HomeDefender1: createManagedCreep("defenderConfig", "homeDefender"),
      FlagScout1: createManagedCreep("scoutConfig", "flagScout"),
    };

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs).toMatchObject({
      mineralConfig: { role: "mineralHarvester" },
      defenderConfig: { role: "homeDefender" },
      scoutConfig: { role: "flagScout" },
    });
  });

  it("removes stale powerbank boost prep and boost pause when task no longer exists", () => {
    Memory.runtime = {
      powerBankBoost: {
        "pb-ghost": {
          taskId: "pb-ghost",
          sourceRoomName: "W1N1",
          labs: {
            [RESOURCE_CATALYZED_UTRIUM_ACID]: {
              labId: "W1N1-lab-1",
              compound: RESOURCE_CATALYZED_UTRIUM_ACID,
            },
          },
        },
      },
      synthesisControl: {
        updatedAt: Game.time,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          W1N1: {
            stage: "idle",
            lastTransitionAt: Game.time,
            boostPause: {
              reason: "powerBankBoost",
              taskId: "pb-ghost",
              createdTick: Game.time - 200,
              pausedPlan: null,
              pausedStage: "synthesizing",
            },
          },
        },
      },
    } as unknown as Memory["runtime"];
    Memory.data = {
      powerBankHarvest: {},
    } as Memory["data"];

    runMemoryCleanup();

    expect(Memory.runtime?.powerBankBoost?.["pb-ghost"]).toBeUndefined();
    expect((Memory.runtime as any).synthesisControl.rooms.W1N1.boostPause).toBeUndefined();
  });
});
