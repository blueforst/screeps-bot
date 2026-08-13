import {
  buildHubProgressSnapshot,
  buildHubVisualModel,
  collectCarrierCargoInventory,
  runHubProgressAnalytics,
  buildHubOverlayLines,
  renderHubProgressOverlays,
  drawHubVisualPanel,
  drawSatellitePanel,
  estimateSatellitePanelCalls,
  resetHubVisualCacheForTests,
} from "@/runtime/hubProgress";
import type {
  HubProgressInput,
  HubProgressPendingTask,
  HubProgressSnapshot,
  ProductionRoomEntry,
} from "@/runtime/hubProgress";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import { VIS_PANEL_FILL } from "@/visual/palette";

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
    createdAt: number;
    updatedAt: number;
    lastProgressAt: number;
    blockedReason: "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee";
    blockedSince: number;
  }> = {},
): Record<string, any> {
  return {
    id: overrides.id || "task-1",
    resource: overrides.resource || RESOURCE_ENERGY,
    fromRoomName: overrides.fromRoomName || "W1N1",
    toRoomName: overrides.toRoomName || "W2N1",
    amount: 1000,
    remainingAmount: overrides.remainingAmount ?? 500,
    status: overrides.status || "pending",
    createdAt: overrides.createdAt ?? 100,
    updatedAt: overrides.updatedAt ?? 100,
    origin: "automatic",
    lastProgressAt: overrides.lastProgressAt ?? overrides.updatedAt ?? 100,
    blockedReason: overrides.blockedReason,
    blockedSince: overrides.blockedSince,
    reason: overrides.reason,
    lastError: undefined,
  };
}

function makePendingTask(overrides: Partial<HubProgressPendingTask> = {}): HubProgressPendingTask {
  return {
    resource: RESOURCE_UTRIUM,
    from: "W2N1",
    to: "W1N1",
    remaining: 500,
    reason: "hub:reclaim:U",
    classification: "reclaim",
    createdAt: 100,
    updatedAt: 100,
    lastProgressAt: 100,
    age: 50,
    lastProgressAge: 50,
    blockedReason: null,
    blockedSince: null,
    blockedAge: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<HubProgressSnapshot> = {}): HubProgressSnapshot {
  return {
    updatedAt: 150,
    enabled: true,
    hubRoomName: "W1N1",
    hubRoomVisible: true,
    status: "importing",
    stage: "acquiring",
    activeProduct: RESOURCE_CATALYZED_GHODIUM_ACID,
    lastPlanActions: [],
    missingResources: [],
    lastError: null,
    needsPlan: false,
    hubStorageEnergy: 100000,
    hubTerminalEnergy: 20000,
    hubInventory: {},
    pendingImports: 0,
    pendingReclaims: 0,
    pendingExports: 0,
    pendingTasks: [],
    roomTerminalBlockers: [],
    hubLabInventory: {},
    hubCarrierCargo: {},
    productionRooms: [],
    t3ReserveStatus: { hubSurplus: 0, totalDeficit: [], compounds: [] },
    protectionAttempt: null,
    committedProtectionMarker: null,
    ...overrides,
  };
}

function makeProductionRoom(overrides: Partial<ProductionRoomEntry> = {}): ProductionRoomEntry {
  return {
    roomName: "W2N1",
    product: RESOURCE_UTRIUM_HYDRIDE,
    stage: "synthesizing",
    progressPercent: 0.5,
    currentAmount: 500,
    targetAmount: 1000,
    isHubRoom: false,
    upstream: [],
    downstream: [],
    directSupplyAmount: 0,
    hubSurplusAmount: 0,
    blocker: null,
    ...overrides,
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

  it("projects Hub task direction, ages and blocker lifecycle without dropping legacy fields", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "distributing" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: {
        export: makeMockTask({
          id: "export",
          resource: RESOURCE_CATALYZED_GHODIUM_ACID,
          fromRoomName: "W1N1",
          toRoomName: "W2N1",
          remainingAmount: 750,
          reason: "hub:export:XGH2O",
          createdAt: 100,
          updatedAt: 160,
          lastProgressAt: 175,
          blockedReason: "insufficient_terminal_resource_or_fee",
          blockedSince: 200,
        }),
      } as any,
      currentTick: 250,
    });

    expect(snapshot.pendingExports).toBe(1);
    expect(snapshot.pendingTasks).toEqual([
      expect.objectContaining({
        resource: RESOURCE_CATALYZED_GHODIUM_ACID,
        from: "W1N1",
        to: "W2N1",
        remaining: 750,
        reason: "hub:export:XGH2O",
        classification: "export",
        createdAt: 100,
        updatedAt: 160,
        lastProgressAt: 175,
        age: 150,
        lastProgressAge: 75,
        blockedReason: "insufficient_terminal_resource_or_fee",
        blockedSince: 200,
        blockedAge: 50,
      }),
    ]);
  });
});

describe("buildHubVisualModel", () => {
  it("uses activity mode without a reliable target and never invents a 1000 target", () => {
    const model = buildHubVisualModel(makeSnapshot({
      stage: "synthesizing",
      activeProduct: RESOURCE_CATALYZED_GHODIUM_ACID,
      hubInventory: { [RESOURCE_CATALYZED_GHODIUM_ACID]: 2000 },
      hubLabInventory: { [RESOURCE_CATALYZED_GHODIUM_ACID]: 500 },
      synthesisTargetAmount: undefined,
    }));

    expect(model.progressMode).toBe("activity");
    expect(model.progressPercent).toBeNull();
    expect(model.progressText).toContain("2.5K");
    expect(model.progressText).toContain("synthesizing");
    expect(model.progressText).not.toContain("/1K");
  });

  it("uses determinate progress only when an absolute target exists", () => {
    const model = buildHubVisualModel(makeSnapshot({
      activeProduct: RESOURCE_CATALYZED_GHODIUM_ACID,
      hubInventory: { [RESOURCE_CATALYZED_GHODIUM_ACID]: 8000 },
      hubLabInventory: { [RESOURCE_CATALYZED_GHODIUM_ACID]: 1000 },
      synthesisTargetAmount: 10000,
    }));

    expect(model.progressMode).toBe("determinate");
    expect(model.progressPercent).toBeCloseTo(0.9);
    expect(model.progressText).toContain("9K/10K 90%");
  });

  it("sorts blocked logistics first and resolves inbound/outbound counterpart rooms", () => {
    const model = buildHubVisualModel(makeSnapshot({
      pendingReclaims: 1,
      pendingExports: 1,
      pendingTasks: [
        makePendingTask({ classification: "reclaim", from: "W2N1", to: "W1N1", age: 200 }),
        makePendingTask({
          classification: "export",
          from: "W1N1",
          to: "W3N1",
          resource: RESOURCE_CATALYZED_UTRIUM_ACID,
          age: 5,
          blockedReason: "receiver_capacity",
          blockedSince: 145,
          blockedAge: 5,
        }),
      ],
    }));

    expect(model.logistics.rows).toHaveLength(2);
    expect(model.logistics.rows[0]).toEqual(expect.objectContaining({
      classification: "export",
      direction: "out",
      counterpartRoom: "W3N1",
      blockedReason: "receiver_capacity",
    }));
    expect(model.logistics.rows[1]).toEqual(expect.objectContaining({
      classification: "reclaim",
      direction: "in",
      counterpartRoom: "W2N1",
    }));
  });

  it("prioritizes errors, bounds alerts and reports overflow", () => {
    const model = buildHubVisualModel(makeSnapshot({
      lastError: "planner exploded",
      needsPlan: true,
      missingResources: [RESOURCE_UTRIUM],
      pendingTasks: [makePendingTask({ blockedReason: "source_depleted", blockedAge: 20 })],
      roomTerminalBlockers: [
        { room: "W2N1", terminalEnergy: 10000, reserve: 20000, pendingNonEnergy: 1 },
      ],
    }));

    expect(model.healthLevel).toBe("error");
    expect(model.healthLabel).toBe("ERROR");
    expect(model.alerts[0]).toBe("error: planner exploded");
    expect(model.alerts).toHaveLength(2);
    expect(model.alertOverflow).toBe(3);
  });

  it("orders compound deficits independently and summarizes satellite production", () => {
    const model = buildHubVisualModel(makeSnapshot({
      productionRooms: [
        { roomName: "W2N1", product: RESOURCE_UTRIUM_HYDRIDE, stage: "synthesizing", progressPercent: 0.5, currentAmount: 500, targetAmount: 1000, isHubRoom: false, upstream: [], downstream: [], directSupplyAmount: 0, hubSurplusAmount: 0, blocker: null },
        { roomName: "W3N1", product: RESOURCE_UTRIUM_ACID, stage: "blocked", progressPercent: 0.2, currentAmount: 200, targetAmount: 1000, isHubRoom: false, upstream: [], downstream: [], directSupplyAmount: 0, hubSurplusAmount: 0, blocker: "missing reagent" },
      ],
      t3ReserveStatus: {
        hubSurplus: 30000,
        totalDeficit: [{ compound: RESOURCE_CATALYZED_GHODIUM_ACID, needed: 10000 }],
        compounds: [
          { compound: RESOURCE_CATALYZED_GHODIUM_ACID, hubAmount: 15000, hubReserve: 20000, hubSurplus: 0, hubDeficit: 5000, networkDeficit: 10000 },
          { compound: RESOURCE_CATALYZED_UTRIUM_ACID, hubAmount: 19000, hubReserve: 20000, hubSurplus: 0, hubDeficit: 1000, networkDeficit: 0 },
          { compound: RESOURCE_CATALYZED_ZYNTHIUM_ACID, hubAmount: 50000, hubReserve: 20000, hubSurplus: 30000, hubDeficit: 0, networkDeficit: 0 },
        ],
      },
    }));

    expect(model.t3Reserve.rows.map(row => row.compound)).toEqual([
      RESOURCE_CATALYZED_GHODIUM_ACID,
      RESOURCE_CATALYZED_UTRIUM_ACID,
    ]);
    expect(model.t3Reserve.stockedCompounds).toBe(1);
    expect(model.production).toEqual({ activeRooms: 1, blockedRooms: 1 });
  });
});

describe("buildHubOverlayLines", () => {
  it("returns [] when snapshot.enabled is false", () => {
    const lines = buildHubOverlayLines(makeSnapshot({ enabled: false }));
    expect(lines).toEqual([]);
  });
});

describe("Hub visual panel rendering", () => {
  beforeEach(() => {
    (global as any).__resetRoomVisualCalls();
  });

  it("renders adaptive health, directional logistics and compound reserve content over one background", () => {
    const model = buildHubVisualModel(makeSnapshot({
      status: "blocked",
      stage: "synthesizing",
      lastError: "planner failure",
      activeProduct: RESOURCE_CATALYZED_GHODIUM_ACID,
      hubInventory: { [RESOURCE_CATALYZED_GHODIUM_ACID]: 9000 },
      synthesisTargetAmount: 10000,
      pendingReclaims: 1,
      pendingTasks: [makePendingTask({ blockedReason: "source_depleted", blockedAge: 25 })],
      productionRooms: [makeProductionRoom()],
      t3ReserveStatus: {
        hubSurplus: 0,
        totalDeficit: [{ compound: RESOURCE_CATALYZED_GHODIUM_ACID, needed: 4000 }],
        compounds: [
          { compound: RESOURCE_CATALYZED_GHODIUM_ACID, hubAmount: 9000, hubReserve: 20000, hubSurplus: 0, hubDeficit: 11000, networkDeficit: 4000 },
        ],
      },
    }));

    const callsUsed = drawHubVisualPanel(new RoomVisual("W1N1"), model);
    const calls: Array<{ method: string; args: any[] }> = (global as any).__roomVisualCalls;
    const texts = calls.filter(call => call.method === "text").map(call => String(call.args[0]));
    const backgrounds = calls.filter(call => call.method === "rect" && call.args[4]?.fill === VIS_PANEL_FILL);

    expect(callsUsed).toBe(calls.length);
    expect(backgrounds).toHaveLength(1);
    expect(texts).toEqual(expect.arrayContaining([
      expect.stringContaining("HUB W1N1"),
      expect.stringContaining("ERROR"),
      expect.stringContaining("← reclaim W2N1"),
      expect.stringContaining(`${RESOURCE_CATALYZED_GHODIUM_ACID} H9K/20K`),
    ]));

    const backgroundBottom = backgrounds[0].args[1] + backgrounds[0].args[3];
    const contentBottom = Math.max(...calls
      .filter(call => call !== backgrounds[0])
      .map(call => call.method === "rect" ? call.args[1] + call.args[3] : call.args[2]));
    expect(contentBottom).toBeLessThanOrEqual(backgroundBottom);
  });

  it("renders a satellite-local panel with exact estimated and actual call counts", () => {
    const room = makeProductionRoom({
      upstream: [{ roomName: "W3N1", resource: RESOURCE_UTRIUM }],
      downstream: [{ roomName: "W1N1", resource: RESOURCE_UTRIUM_HYDRIDE }],
      blocker: "missing reagent",
    });

    const callsUsed = drawSatellitePanel(new RoomVisual(room.roomName), room);
    const calls: Array<{ roomName: string; method: string; args: any[] }> = (global as any).__roomVisualCalls;
    const texts = calls.filter(call => call.method === "text").map(call => String(call.args[0]));

    expect(callsUsed).toBe(calls.length);
    expect(callsUsed).toBe(estimateSatellitePanelCalls(room));
    expect(calls.filter(call => call.method === "rect" && call.args[4]?.fill === VIS_PANEL_FILL)).toHaveLength(1);
    expect(texts).toEqual(expect.arrayContaining([
      expect.stringContaining("Production:"),
      expect.stringContaining("←W3N1"),
      "⚠ missing reagent",
    ]));
  });
});

describe("renderHubProgressOverlays", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    resetHubVisualCacheForTests();
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

  it("reuses a stable visual snapshot for less than five ticks and invalidates on Hub status change", () => {
    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    const find = jest.fn(() => []);
    Game.rooms = {
      W1N1: {
        name: "W1N1",
        controller: { my: true },
        storage: { store: { energy: 100000 } },
        terminal: { store: { energy: 20000 } },
        find,
      } as any,
    };

    renderHubProgressOverlays();
    Game.time = 101;
    renderHubProgressOverlays();
    expect(find).toHaveBeenCalledTimes(1);

    Game.time = 102;
    Memory.runtime!.hub!.status = "blocked";
    renderHubProgressOverlays();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("refreshes a stable visual snapshot when it reaches five ticks old", () => {
    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    const find = jest.fn(() => []);
    Game.rooms = {
      W1N1: {
        name: "W1N1",
        controller: { my: true },
        storage: { store: { energy: 100000 } },
        terminal: { store: { energy: 20000 } },
        find,
      } as any,
    };

    renderHubProgressOverlays();
    Game.time = 104;
    renderHubProgressOverlays();
    expect(find).toHaveBeenCalledTimes(1);

    Game.time = 105;
    renderHubProgressOverlays();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("reuses the analytics snapshot in the overlay phase of the same tick", () => {
    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.time = 105;
    const find = jest.fn(() => []);
    Game.rooms = {
      W1N1: {
        name: "W1N1",
        controller: { my: true },
        storage: { store: { energy: 100000 } },
        terminal: { store: { energy: 20000 } },
        find,
      } as any,
    };

    runHubProgressAnalytics();
    renderHubProgressOverlays();

    expect(find).toHaveBeenCalledTimes(1);
    expect(Memory.analytics?.hub?.updatedAt).toBe(105);
  });

  it("keeps real calls within budget and prioritizes blocked satellites before the hard cap", () => {
    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.time = 101;
    const satelliteNames = ["W2N1", "W3N1", "W4N1", "W5N1", "W6N1", "W7N1", "W8N1", "W9N1"];
    Game.rooms = {
      W1N1: { name: "W1N1", controller: { my: true }, find: () => [] } as any,
      ...Object.fromEntries(satelliteNames.map(roomName => [
        roomName,
        { name: roomName, controller: { my: true }, find: () => [] } as any,
      ])),
    };
    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: satelliteNames.map(roomName => ({
        roomName,
        product: RESOURCE_UTRIUM_HYDRIDE,
        targetAmount: 1000,
        isHubRoom: false,
      })),
      routeDecisions: [],
      progressEdges: [],
    };
    Memory.runtime!.synthesisControl = {
      updatedAt: 101,
      generatedTaskCount: 0,
      failedTaskCount: 0,
      successfulRunCount: 0,
      lastActions: [],
      bindings: {},
      rooms: Object.fromEntries(satelliteNames.map(roomName => [
        roomName,
        {
          stage: roomName === "W9N1" ? "blocked" : "synthesizing",
          activeProduct: RESOURCE_UTRIUM_HYDRIDE,
          reagentLabIds: [],
          productLabIds: [],
          successfulRuns: 0,
          pendingTasks: 0,
          lastTransitionAt: 100,
          ...(roomName === "W9N1" ? { lastError: "missing reagent" } : {}),
        },
      ])),
    } as any;

    const stats = renderHubProgressOverlays();
    const calls: Array<{ roomName: string; method: string; args: any[] }> = (global as any).__roomVisualCalls;
    const headers = calls.filter(call => call.method === "text" && String(call.args[0]).startsWith("Production:"));

    expect(stats).toEqual(expect.objectContaining({ satellitePanels: 6, skippedSatellitePanels: 2 }));
    expect(stats!.callsUsed).toBe(calls.length);
    expect(stats!.callsUsed).toBeLessThanOrEqual(80);
    expect(headers.some(call => call.roomName === "W9N1")).toBe(true);
    expect(headers.some(call => call.roomName === "W8N1")).toBe(false);
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
    expect(snapshot.t3ReserveStatus.compounds).toEqual([]);
  });

  it("keeps legacy totals while exposing independent per-compound Hub and network deficits", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ACID, RESOURCE_CATALYZED_UTRIUM_ACID],
        reservePerRoom: 5000,
        hubReservePerCompound: 20000,
      },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: {
        [RESOURCE_CATALYZED_GHODIUM_ACID]: 30000,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
      },
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 200,
      satelliteStores: [
        {
          roomName: "W2N1",
          storage: {
            [RESOURCE_CATALYZED_GHODIUM_ACID]: 5000,
            [RESOURCE_CATALYZED_UTRIUM_ACID]: 1000,
          },
          terminal: null,
        },
      ],
    });

    expect(snapshot.t3ReserveStatus.hubSurplus).toBe(10000);
    expect(snapshot.t3ReserveStatus.totalDeficit).toEqual([
      { compound: RESOURCE_CATALYZED_UTRIUM_ACID, needed: 4000 },
    ]);
    expect(snapshot.t3ReserveStatus.compounds).toEqual([
      {
        compound: RESOURCE_CATALYZED_GHODIUM_ACID,
        hubAmount: 30000,
        hubReserve: 20000,
        hubSurplus: 10000,
        hubDeficit: 0,
        networkDeficit: 0,
      },
      {
        compound: RESOURCE_CATALYZED_UTRIUM_ACID,
        hubAmount: 5000,
        hubReserve: 20000,
        hubSurplus: 0,
        hubDeficit: 15000,
        networkDeficit: 4000,
      },
    ]);
  });
});
