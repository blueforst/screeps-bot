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

  it("preserves remoteMiningReserver configs during legacy cleanup", () => {
    Memory.data = {
      creepConfigs: {
        reserverConfig: { role: "remoteMiningReserver", args: ["W2N2"] },
      },
    };
    Game.creeps = {
      Reserver1: createManagedCreep("reserverConfig", "remoteMiningReserver"),
    };

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs?.reserverConfig).toMatchObject({
      role: "remoteMiningReserver",
      args: ["W2N2"],
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

  it("keeps powerbank boost prep and boost pause while task exists", () => {
    Memory.runtime = {
      powerBankBoost: {
        "pb-active": {
          taskId: "pb-active",
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
              taskId: "pb-active",
              createdTick: Game.time - 10,
              pausedPlan: null,
              pausedStage: "synthesizing",
            },
          },
        },
      },
    } as unknown as Memory["runtime"];
    Memory.data = {
      powerBankHarvest: {
        "pb-active": {
          id: "pb-active",
          status: "boosting",
          sourceRoom: "W1N1",
          targetRoom: "W2N2",
          bankId: "bank-1",
          bankPos: { x: 25, y: 25 },
          hits: 2_000_000,
          power: 5000,
          ticksToDecay: 4000,
          freeTiles: 8,
          discoveredTick: Game.time - 100,
          lastSeenTick: Game.time - 10,
          haulerIds: [],
          boostLabs: [],
          compoundTransferTaskIds: [],
        },
      },
    } as Memory["data"];

    runMemoryCleanup();

    expect(Memory.runtime?.powerBankBoost?.["pb-active"]).toBeDefined();
    expect((Memory.runtime as any).synthesisControl.rooms.W1N1.boostPause).toBeDefined();
  });

  it("keeps hub and war boost prep while their owning workflows are active", () => {
    Memory.cfg = { hub: { enabled: true, hubRoomName: "W1N1" } } as Memory["cfg"];
    Memory.data = {
      creepConfigs: {
        "W1N1:hubUpgrader:0": {
          role: "hubUpgrader",
          roomName: "W1N1",
          args: ["W1N1", "hubUpgrade:W1N1"],
          body: [WORK, CARRY, MOVE],
        },
      },
      war: {
        W2N2: {
          targetRoom: "W2N2",
          sourceRoom: "W1N1",
          status: "staging",
          reason: "manual",
          attempts: 1,
          createdAt: Game.time,
          updatedAt: Game.time,
          activeGeneration: {
            id: 1,
            phase: "preparing",
            createdAt: Game.time,
            boostTaskId: "war:W1N1:W2N2:g1",
            configNames: { meleeAttacker: "attacker", healer: "healer" },
          },
        },
      },
    } as Memory["data"];
    Memory.runtime = {
      powerBankBoost: Object.fromEntries(["hubUpgrade:W1N1", "war:W1N1:W2N2:g1"].map((taskId) => [taskId, {
        taskId,
        sourceRoomName: "W1N1",
        labs: {},
      }])),
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
            reagentLabIds: [],
            productLabIds: [],
            successfulRuns: 0,
            pendingTasks: 0,
            lastTransitionAt: Game.time,
            boostPause: {
              reason: "powerBankBoost",
              taskId: "hubUpgrade:W1N1",
              taskIds: ["hubUpgrade:W1N1", "war:W1N1:W2N2:g1"],
              createdTick: Game.time,
              pausedPlan: null,
              pausedStage: "idle",
            },
          },
        },
      },
    } as Memory["runtime"];

    runMemoryCleanup();

    expect(Object.keys(Memory.runtime?.powerBankBoost || {}).sort()).toEqual([
      "hubUpgrade:W1N1",
      "war:W1N1:W2N2:g1",
    ]);
    expect(Memory.runtime?.synthesisControl?.rooms.W1N1.boostPause?.taskIds).toHaveLength(2);
    expect(Memory.data?.creepConfigs?.["W1N1:hubUpgrader:0"]).toBeDefined();
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

  describe("hub distributed synthesis cleanup", () => {
    function setupHubWithDistributedSynthesis(
      ds: Record<string, unknown>,
      ownedRoomNames: string[] = ["W1N1"],
    ): void {
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
          lastPlanActions: [],
          needsPlan: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          distributedSynthesis: ds as any,
        },
      };
      for (const name of ownedRoomNames) {
        Game.rooms[name] = createOwnedRoom(name);
      }
    }

    it("caps oversized dispatchAssignments to 100", () => {
      const many = Array.from({ length: 150 }, (_, i) => ({ fromRoom: `W${i}N0`, toRoom: "W1N1" }));
      setupHubWithDistributedSynthesis({ dispatchAssignments: many });

      runMemoryCleanup();

      const ds = Memory.runtime?.hub?.distributedSynthesis;
      expect(ds?.dispatchAssignments!.length).toBe(100);
    });

    it("caps oversized routeDecisions to 100", () => {
      const many = Array.from({ length: 130 }, (_, i) => ({ fromRoom: `W${i}N0`, toRoom: "W1N1" }));
      setupHubWithDistributedSynthesis({ routeDecisions: many });

      runMemoryCleanup();

      expect(Memory.runtime?.hub?.distributedSynthesis?.routeDecisions!.length).toBe(100);
    });

    it("caps oversized progressEdges to 100", () => {
      const many = Array.from({ length: 120 }, (_, i) => ({ product: `XOH${i}`, status: "done" }));
      setupHubWithDistributedSynthesis({ progressEdges: many });

      runMemoryCleanup();

      expect(Memory.runtime?.hub?.distributedSynthesis?.progressEdges!.length).toBe(100);
    });

    it("does not truncate arrays at or below cap", () => {
      const arr = Array.from({ length: 50 }, (_, i) => ({ idx: i }));
      setupHubWithDistributedSynthesis({
        dispatchAssignments: [...arr],
        routeDecisions: [...arr],
        progressEdges: [...arr],
      });

      runMemoryCleanup();

      const ds = Memory.runtime?.hub?.distributedSynthesis;
      expect(ds?.dispatchAssignments!.length).toBe(50);
      expect(ds?.routeDecisions!.length).toBe(50);
      expect(ds?.progressEdges!.length).toBe(50);
    });

    it("removes roomCapabilities for non-owned rooms", () => {
      setupHubWithDistributedSynthesis({
        roomCapabilities: {
          W1N1: { labs: 3 },
          W2N2: { labs: 2 },
        },
      });

      runMemoryCleanup();

      const rc = Memory.runtime?.hub?.distributedSynthesis?.roomCapabilities;
      expect(rc).toBeDefined();
      expect(Object.keys(rc!)).toEqual(["W1N1"]);
    });

    it("preserves roomCapabilities for owned rooms", () => {
      setupHubWithDistributedSynthesis(
        {
          roomCapabilities: {
            W1N1: { labs: 3 },
            W9N9: { labs: 2 },
          },
        },
        ["W1N1", "W9N9"],
      );

      runMemoryCleanup();

      const rc = Memory.runtime?.hub?.distributedSynthesis?.roomCapabilities;
      expect(Object.keys(rc!)).toEqual(["W1N1", "W9N9"]);
    });

    it("does not crash when distributedSynthesis is absent", () => {
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
          status: "idle",
          updatedAt: 100,
          activeProduct: "",
          activeStep: 0,
          missingResources: [],
          lastPlanActions: [],
          needsPlan: false,
        },
      };

      expect(() => runMemoryCleanup()).not.toThrow();
    });
  });
});
