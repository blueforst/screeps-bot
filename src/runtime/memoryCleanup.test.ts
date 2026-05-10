import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { clearPickupReservationStoreForTest, getPickupReservationsByRoom } from "@/runtime/energyPickupReservation";

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
    Memory.runtime = undefined;
    Memory.data = undefined;
  });

  it("removes foreign room pickup reservation memory after claims expire", () => {
    runMemoryCleanup();

    expect(getPickupReservationsByRoom("W2N2")).toEqual({});
  });

  it("removes stale spawn planner, illegal structure cleanup, and rescue entries", () => {
    Memory.runtime = {
      spawnPlanner: {
        sourceWorkerCommutes: {
          "W1N1:source-a": { commute: 12, updatedAt: Game.time },
          "W9N9:source-b": { commute: 20, updatedAt: Game.time },
        },
      },
      illegalStructureCleanup: {
        rooms: {
          W1N1: { completedAt: Game.time, layoutSavedAt: 10 },
          W9N9: { completedAt: Game.time, layoutSavedAt: 20 },
        },
      },
    } as Memory["runtime"];
    Memory.data = {
      rescue: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "bootstrapping",
          flagName: "RESCUE",
          createdAt: Game.time,
          updatedAt: Game.time,
        },
        W9N8: {
          targetRoom: "W9N8",
          sourceRoom: "W9N9",
          status: "bootstrapping",
          flagName: "RESCUE_W9N9",
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];

    runMemoryCleanup();

    expect(Memory.runtime?.spawnPlanner?.sourceWorkerCommutes).toEqual({
      "W1N1:source-a": { commute: 12, updatedAt: Game.time },
    });
    expect(Memory.runtime?.illegalStructureCleanup?.rooms).toEqual({
      W1N1: { completedAt: Game.time, layoutSavedAt: 10 },
    });
    expect(Memory.data?.rescue).toEqual({
      W1N2: expect.objectContaining({ sourceRoom: "W1N1" }),
    });
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

  it("removes room planner build runtime entries for rooms no longer owned", () => {
    Memory.runtime = {
      roomPlannerBuild: {
        rooms: {
          W1N1: { lastRunAt: 100 },
          W9N9: { lastRunAt: 50 },
        },
      },
    };

    runMemoryCleanup();

    expect(Memory.runtime?.roomPlannerBuild?.rooms).toEqual({
      W1N1: { lastRunAt: 100 },
    });
  });

  describe("hub runtime cleanup", () => {
    it("sets hub runtime to blocked when hub room no longer owned", () => {
      Memory.cfg = {
        hub: {
          enabled: true,
          hubRoomName: "W9N9",
          planInterval: 50,
          reservePerRoom: 1000,
          targetCompounds: [],
          storagePauseFreeCapacity: 100_000,
          surplusThreshold: 1500,
          internalOnly: true,
        },
      };
      Memory.runtime = {
        hub: {
          status: "importing",
          updatedAt: 100,
          activeProduct: "OH",
          activeStep: 0,
          missingResources: [],
          lastPlanActions: ["OH", "ZK"],
          needsPlan: false,
        },
      };

      runMemoryCleanup();

      expect(Memory.runtime?.hub?.status).toBe("blocked");
      expect(Memory.runtime?.hub?.activeProduct).toBe("");
      expect(Memory.runtime?.hub?.updatedAt).toBe(Game.time);
    });

    it("does NOT delete Memory.cfg.hub when hub room is lost", () => {
      Memory.cfg = {
        hub: {
          enabled: true,
          hubRoomName: "W9N9",
          planInterval: 50,
          reservePerRoom: 1000,
          targetCompounds: [],
          storagePauseFreeCapacity: 100_000,
          surplusThreshold: 1500,
          internalOnly: true,
        },
      };
      Memory.runtime = {
        hub: {
          status: "importing",
          updatedAt: 100,
          activeProduct: "OH",
          activeStep: 0,
          missingResources: [],
          lastPlanActions: ["OH"],
          needsPlan: false,
        },
      };

      runMemoryCleanup();

      expect(Memory.cfg?.hub).toBeDefined();
      expect(Memory.cfg?.hub?.hubRoomName).toBe("W9N9");
    });

    it("does not touch hub runtime when hub room is still owned", () => {
      Memory.cfg = {
        hub: {
          enabled: true,
          hubRoomName: "W1N1",
          planInterval: 50,
          reservePerRoom: 1000,
          targetCompounds: [],
          storagePauseFreeCapacity: 100_000,
          surplusThreshold: 1500,
          internalOnly: true,
        },
      };
      Memory.runtime = {
        hub: {
          status: "importing",
          updatedAt: 100,
          activeProduct: "OH",
          activeStep: 0,
          missingResources: [],
          lastPlanActions: ["OH"],
          needsPlan: false,
        },
      };

      runMemoryCleanup();

      expect(Memory.runtime?.hub?.status).toBe("importing");
      expect(Memory.runtime?.hub?.activeProduct).toBe("OH");
    });

    it("sets hub runtime to blocked when hub room exists but controller is not mine", () => {
      const lostRoom = {
        name: "W1N1",
        controller: { my: false, level: 8 },
        find: () => [],
      } as unknown as Room;
      Game.rooms["W1N1"] = lostRoom;

      Memory.cfg = {
        hub: {
          enabled: true,
          hubRoomName: "W1N1",
          planInterval: 50,
          reservePerRoom: 1000,
          targetCompounds: [],
          storagePauseFreeCapacity: 100_000,
          surplusThreshold: 1500,
          internalOnly: true,
        },
      };
      Memory.runtime = {
        hub: {
          status: "importing",
          updatedAt: 100,
          activeProduct: "OH",
          activeStep: 0,
          missingResources: [],
          lastPlanActions: ["OH"],
          needsPlan: false,
        },
      };

      runMemoryCleanup();

      expect(Memory.runtime?.hub?.status).toBe("blocked");
    });

    it("caps lastPlanActions to 20 entries", () => {
      const manyActions = Array.from({ length: 30 }, (_, i) => `product-${i}`);
      Memory.cfg = {
        hub: {
          enabled: true,
          hubRoomName: "W9N9",
          planInterval: 50,
          reservePerRoom: 1000,
          targetCompounds: [],
          storagePauseFreeCapacity: 100_000,
          surplusThreshold: 1500,
          internalOnly: true,
        },
      };
      Memory.runtime = {
        hub: {
          status: "importing",
          updatedAt: 100,
          activeProduct: "OH",
          activeStep: 0,
          missingResources: [],
          lastPlanActions: manyActions,
          needsPlan: false,
        },
      };

      runMemoryCleanup();

      expect(Memory.runtime?.hub?.lastPlanActions!.length).toBeLessThanOrEqual(20);
    });

    it("caps missingResources to 20 entries", () => {
      const manyMissing = Array.from({ length: 30 }, (_, i) => `resource-${i}`);
      Memory.cfg = {
        hub: {
          enabled: true,
          hubRoomName: "W1N1",
          planInterval: 50,
          reservePerRoom: 1000,
          targetCompounds: [],
          storagePauseFreeCapacity: 100_000,
          surplusThreshold: 1500,
          internalOnly: true,
        },
      };
      Memory.runtime = {
        hub: {
          status: "blocked",
          updatedAt: 100,
          activeProduct: "",
          activeStep: 0,
          missingResources: manyMissing,
          lastPlanActions: [],
          needsPlan: false,
        },
      };

      runMemoryCleanup();

      expect(Memory.runtime?.hub?.missingResources!.length).toBeLessThanOrEqual(20);
    });

    it("does not crash when hub runtime is missing", () => {
      Memory.cfg = {
        hub: {
          enabled: true,
          hubRoomName: "W9N9",
          planInterval: 50,
          reservePerRoom: 1000,
          targetCompounds: [],
          storagePauseFreeCapacity: 100_000,
          surplusThreshold: 1500,
          internalOnly: true,
        },
      };
      Memory.runtime = {};

      expect(() => runMemoryCleanup()).not.toThrow();
    });

    it("does not crash when hub config is disabled", () => {
      Memory.cfg = {
        hub: {
          enabled: false,
          hubRoomName: "",
          planInterval: 50,
          reservePerRoom: 1000,
          targetCompounds: [],
          storagePauseFreeCapacity: 100_000,
          surplusThreshold: 1500,
          internalOnly: true,
        },
      };
      Memory.runtime = {
        hub: {
          status: "idle",
          updatedAt: 100,
          activeProduct: "",
          activeStep: 0,
          missingResources: [],
          lastPlanActions: [],
          needsPlan: false,
        },
      };

      runMemoryCleanup();

      expect(Memory.runtime?.hub?.status).toBe("idle");
    });
  });
});
