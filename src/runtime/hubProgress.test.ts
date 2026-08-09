import { buildHubProgressSnapshot, buildHubVisualModel, collectHubProgressSnapshot, collectCarrierCargoInventory, runHubProgressAnalytics, buildHubOverlayLines, renderHubProgressOverlays, drawHubVisualPanel } from "@/runtime/hubProgress";
import type { HubProgressInput, HubProgressSnapshot, HubVisualModel, ProductionRoomEntry } from "@/runtime/hubProgress";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { getCreepConfigService, registerRuntimeServices } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function makeMockTask(
  overrides: Partial<{
    id: string;
    resource: ResourceConstant;
    fromRoomName: string;
    toRoomName: string;
    remainingAmount: number;
    status: "pending" | "done" | "cancelled" | "failed";
    reason: string;
  }> = {},
): Record<string, any> {
  return {
    id: overrides.id || "task-1",
    resource: overrides.resource || RESOURCE_ENERGY,
    fromRoomName: overrides.fromRoomName || "W1N1",
    toRoomName: overrides.toRoomName || "W2N1",
    amount: 1000,
    remainingAmount: overrides.remainingAmount || 500,
    status: overrides.status || "pending",
    createdAt: 100,
    updatedAt: 100,
    reason: overrides.reason,
    lastError: undefined,
  };
}

type ResourceControlRoomInput = NonNullable<HubProgressInput["resourceControlRooms"]>[string];

function makeResourceControlRoom(
  overrides: Partial<ResourceControlRoomInput> = {},
): ResourceControlRoomInput {
  return {
    state: "balanced",
    storageEnergy: 200000,
    terminalEnergy: 15000,
    energyFloor: 120000,
    energyTarget: 200000,
    energyExportStart: 250000,
    canMineNative: false,
    minerals: {},
    ...overrides,
  };
}

describe("buildHubProgressSnapshot", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
  });

  it("projects only bounded Hub protection attempt and component markers", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: {
        status: "idle",
        currentProtectionAttempt: {
          attemptRevision: 8,
          configIncarnation: 3,
          startedAt: 198,
          finishedAt: 199,
          configFingerprint: "hubcfg-v1:test",
          status: "committed",
          valid: true,
        },
        committedProtectionSnapshot: {
          schema: "hub-protection-snapshot-v1",
          planRevision: 8,
          configIncarnation: 3,
          observedAt: 199,
          expiresAt: 209,
          configFingerprint: "hubcfg-v1:test",
          status: "committed",
          valid: true,
          marker: {
            revision: 8,
            configIncarnation: 3,
            configFingerprint: "hubcfg-v1:test",
            hubRoomName: "W1N1",
            planMode: "distributed",
            targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ACID],
            hubReservePerCompound: 5_000,
          },
          synthesisConfig: {
            revision: 8,
            configIncarnation: 3,
            configFingerprint: "hubcfg-v1:test",
            rooms: { W1N1: { reactions: [] } },
          },
          transferTasks: {
            revision: 8,
            configIncarnation: 3,
            configFingerprint: "hubcfg-v1:test",
            tasks: [
              {
                id: "large-task-not-projected",
                resource: RESOURCE_UTRIUM,
                fromRoomName: "W2N1",
                toRoomName: "W1N1",
                amount: 1_000,
                remainingAmount: 1_000,
                status: "pending",
              },
            ],
          },
          distributed: {
            revision: 8,
            configIncarnation: 3,
            configFingerprint: "hubcfg-v1:test",
            dispatchAssignments: [],
            routeDecisions: [],
            allocationLedger: {},
          },
          baseMineralSurplus: {
            revision: 8,
            configIncarnation: 3,
            configFingerprint: "hubcfg-v1:test",
            byRoom: { W1N1: { [RESOURCE_UTRIUM]: 25_000 } },
          },
        },
      },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 200,
    });

    expect(snapshot.protectionAttempt).toEqual({
      attemptRevision: 8,
      configIncarnation: 3,
      startedAt: 198,
      finishedAt: 199,
      configFingerprint: "hubcfg-v1:test",
      status: "committed",
      valid: true,
    });
    expect(snapshot.committedProtectionMarker).toEqual({
      schema: "hub-protection-snapshot-v1",
      planRevision: 8,
      configIncarnation: 3,
      observedAt: 199,
      expiresAt: 209,
      configFingerprint: "hubcfg-v1:test",
      status: "committed",
      valid: true,
      marker: {
        revision: 8,
        configIncarnation: 3,
        configFingerprint: "hubcfg-v1:test",
        hubRoomName: "W1N1",
        planMode: "distributed",
      },
      components: {
        synthesisConfig: {
          revision: 8,
          configIncarnation: 3,
          configFingerprint: "hubcfg-v1:test",
        },
        transferTasks: {
          revision: 8,
          configIncarnation: 3,
          configFingerprint: "hubcfg-v1:test",
        },
        distributed: {
          revision: 8,
          configIncarnation: 3,
          configFingerprint: "hubcfg-v1:test",
        },
        baseMineralSurplus: {
          revision: 8,
          configIncarnation: 3,
          configFingerprint: "hubcfg-v1:test",
        },
      },
    });
    expect(
      JSON.stringify(snapshot.committedProtectionMarker),
    ).not.toContain("large-task-not-projected");
    expect(
      JSON.stringify(snapshot.committedProtectionMarker),
    ).not.toContain("25000");
    expect(
      JSON.stringify(snapshot.committedProtectionMarker),
    ).not.toContain(RESOURCE_CATALYZED_GHODIUM_ACID);
  });

  it("falls back to the controller default terminal reserve for legacy room memory", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "blocked" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: {
        W2N1: makeResourceControlRoom({ energyFloor: 120000 }),
      },
      transferTasks: null,
      currentTick: 351,
    });

    expect(snapshot.roomTerminalBlockers[0]?.reserve).toBe(20000);
  });

  it("scans pending non-energy tasks for legacy room memory without task health", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "blocked" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: {
        W2N1: makeResourceControlRoom(),
      },
      transferTasks: {
        mineral: makeMockTask({
          id: "mineral",
          resource: RESOURCE_UTRIUM,
          fromRoomName: "W3N1",
          toRoomName: "W2N1",
        }),
        energy: makeMockTask({
          id: "energy",
          resource: RESOURCE_ENERGY,
          fromRoomName: "W2N1",
          toRoomName: "W3N1",
        }),
        done: makeMockTask({
          id: "done",
          resource: RESOURCE_KEANIUM,
          fromRoomName: "W2N1",
          toRoomName: "W3N1",
          status: "done",
        }),
      } as any,
      currentTick: 353,
    });

    expect(snapshot.roomTerminalBlockers[0]?.pendingNonEnergy).toBe(1);
  });
});

describe("buildHubOverlayLines", () => {
  function makeSnapshot(overrides: Partial<HubProgressSnapshot> = {}): HubProgressSnapshot {
    return {
      updatedAt: 100,
      enabled: true,
      hubRoomName: "W1N1",
      hubRoomVisible: true,
      status: "importing",
      stage: "acquiring",
      activeProduct: "XGH2O",
      lastPlanActions: ["XGH2O", "XUHO2"],
      missingResources: ["U"],
      lastError: null,
      needsPlan: false,
      hubStorageEnergy: 100000,
      hubTerminalEnergy: 20000,
      hubInventory: {},
      pendingImports: 3,
      pendingReclaims: 0,
      pendingExports: 1,
      pendingTasks: [],
      roomTerminalBlockers: [],
      hubLabInventory: {},
      hubCarrierCargo: {},
      productionRooms: [],
      t3ReserveStatus: { hubSurplus: 0, totalDeficit: [] },
      protectionAttempt: null,
      committedProtectionMarker: null,
      ...overrides,
    };
  }

  it("returns [] when snapshot.enabled is false", () => {
    const lines = buildHubOverlayLines(makeSnapshot({ enabled: false }));
    expect(lines).toEqual([]);
  });
});

describe("renderHubProgressOverlays", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: ["XGH2O" as ResourceConstant],
      },
    };
    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        activeProduct: "",
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: false,
      },
    };
    Memory.data = { resourceControl: { tasks: {} } };
    Memory.analytics = {};
    Game.time = 100;
    Game.rooms = {};
  });

  it("skips rendering when CPU bucket is low", () => {
    (global as any).__resetRoomVisualCalls();

    Game.cpu = { bucket: 50, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      W1N1: { name: "W1N1", controller: { my: true } } as any,
    };

    renderHubProgressOverlays();

    const calls: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls;
    expect(calls).toHaveLength(0);
  });

  it("duplicate production entries render only one satellite panel for E6N59", () => {
    (global as any).__resetRoomVisualCalls();

    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      E4N58: { name: "E4N58", controller: { my: true } } as any,
      E6N59: { name: "E6N59", controller: { my: true } } as any,
    };

    Memory.cfg!.hub!.hubRoomName = "E4N58";
    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: [
        { roomName: "E4N58", product: "XGH2O" as ResourceConstant, targetAmount: 3000, isHubRoom: true },
        { roomName: "E6N59", product: "UO" as ResourceConstant, targetAmount: 5000, isHubRoom: false },
        { roomName: "E6N59", product: "UHO2" as ResourceConstant, targetAmount: 5000, isHubRoom: false },
        { roomName: "E6N59", product: "XZHO2" as ResourceConstant, targetAmount: 5000, isHubRoom: false },
      ],
      routeDecisions: [],
      progressEdges: [],
    };
    Memory.runtime!.synthesisControl = {
      updatedAt: 0,
      generatedTaskCount: 0,
      failedTaskCount: 0,
      successfulRunCount: 0,
      lastActions: [],
      bindings: {},
      rooms: {
        E6N59: { stage: "synthesizing", activeProduct: "UO" as ResourceConstant, reagentLabIds: [], productLabIds: [], successfulRuns: 0, pendingTasks: 0, lastTransitionAt: 0 },
      },
    };
    Memory.cfg!.synthesisControl = {
      rooms: {
        E6N59: { reactions: [{ product: "UO", targetAmount: 5000 }, { product: "UHO2", targetAmount: 5000 }, { product: "XZHO2", targetAmount: 5000 }] },
      },
    };
    Memory.data!.resourceControl = Memory.data!.resourceControl || { tasks: {} };

    renderHubProgressOverlays();

    const calls: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls;
    const e6n59ProdHeaders = calls.filter(
      c => c.roomName === "E6N59" && c.method === "text" && String(c.args[0]).startsWith("Production:"),
    );
    expect(e6n59ProdHeaders.length).toBe(1);
  });
});

describe("collectCarrierCargoInventory", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.creeps = {};
  });

  it("returns empty record when no matching carriers", () => {
    Game.creeps = {};
    const result = collectCarrierCargoInventory("W8N1");
    expect(result).toEqual({});
  });
});

describe("buildHubProgressSnapshot productionRooms (distributed synthesis)", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.rooms = {};
  });

  it("dedupes busy room duplicate assignments to active product", () => {
    Game.rooms = {
      E6N59: {
        name: "E6N59",
        storage: { store: { UO: 3000, energy: 50000 } as unknown as StoreDefinition },
        terminal: { store: { UO: 500, energy: 10000 } as unknown as StoreDefinition },
        find: () => [],
      } as any,
      E4N58: {
        name: "E4N58",
        storage: { store: { energy: 50000 } as unknown as StoreDefinition },
        terminal: { store: { energy: 10000 } as unknown as StoreDefinition },
        find: () => [],
      } as any,
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "E4N58" },
      hubRuntime: { status: "distributing" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 1000,
      distributedSynthesis: {
        dispatchAssignments: [
          { roomName: "E6N59", product: "UO" as ResourceConstant, targetAmount: 6904, isHubRoom: false },
          { roomName: "E6N59", product: "UHO2" as ResourceConstant, targetAmount: 5000, isHubRoom: false },
          { roomName: "E6N59", product: "XZHO2" as ResourceConstant, targetAmount: 3000, isHubRoom: false },
          { roomName: "E4N58", product: "XUHO2" as ResourceConstant, targetAmount: 2000, isHubRoom: true },
          { roomName: "E4N58", product: "XGHO2" as ResourceConstant, targetAmount: 1500, isHubRoom: true },
        ],
        routeDecisions: [],
        progressEdges: [],
      },
      synthesisControlRooms: {
        E6N59: { stage: "synthesizing", activeProduct: "UO" as ResourceConstant },
        E4N58: { stage: "idle" },
      },
    });

    const e6n59Entries = snapshot.productionRooms.filter(r => r.roomName === "E6N59");
    expect(e6n59Entries).toHaveLength(1);
    expect(e6n59Entries[0].product).toBe("UO");
    expect(e6n59Entries[0].targetAmount).toBe(6904);

    const e4n58Entries = snapshot.productionRooms.filter(r => r.roomName === "E4N58");
    expect(e4n58Entries).toHaveLength(1);
  });

  it("dedupes idle room duplicate assignments keeping first", () => {
    Game.rooms = {
      E6N59: {
        name: "E6N59",
        storage: { store: { energy: 50000 } as unknown as StoreDefinition },
        terminal: { store: { energy: 10000 } as unknown as StoreDefinition },
        find: () => [],
      } as any,
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "E4N58" },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 1100,
      distributedSynthesis: {
        dispatchAssignments: [
          { roomName: "E6N59", product: "UHO2" as ResourceConstant, targetAmount: 5000, isHubRoom: false },
          { roomName: "E6N59", product: "XZHO2" as ResourceConstant, targetAmount: 3000, isHubRoom: false },
        ],
        routeDecisions: [],
        progressEdges: [],
      },
      synthesisControlRooms: {
        E6N59: { stage: "idle" },
      },
    });

    const e6n59Entries = snapshot.productionRooms.filter(r => r.roomName === "E6N59");
    expect(e6n59Entries).toHaveLength(1);
    expect(e6n59Entries[0].product).toBe("UHO2");
    expect(e6n59Entries[0].targetAmount).toBe(5000);
  });
});

describe("buildHubProgressSnapshot t3ReserveStatus", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
  });

  it("returns empty t3ReserveStatus when no targetCompounds configured", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: { XGH2O: 5000 } as Record<string, number>,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 200,
      satelliteStores: [
        { roomName: "W2N1", storage: { XGH2O: 500 }, terminal: null },
      ],
    });

    expect(snapshot.t3ReserveStatus.hubSurplus).toBe(0);
    expect(snapshot.t3ReserveStatus.totalDeficit).toEqual([]);
  });
});
