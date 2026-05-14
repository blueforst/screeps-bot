import { buildHubProgressSnapshot, buildHubVisualModel, collectHubProgressSnapshot, collectCarrierCargoInventory, runHubProgressAnalytics, buildHubOverlayLines, renderHubProgressOverlays, drawHubVisualPanel, buildInboundTransferRows } from "@/runtime/hubProgress";
import type { HubProgressSnapshot, HubVisualModel, ProductionRoomEntry } from "@/runtime/hubProgress";
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

describe("buildHubProgressSnapshot", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
  });

  it("returns disabled snapshot when hub is disabled", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: false },
      hubRuntime: null,
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 100,
    });

    expect(snapshot.enabled).toBe(false);
    expect(snapshot.updatedAt).toBe(100);
    expect(snapshot.pendingImports).toBe(0);
    expect(snapshot.pendingReclaims).toBe(0);
    expect(snapshot.pendingExports).toBe(0);
    expect(snapshot.hubInventory).toEqual({});
  });

  it("includes blocked hub fields", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: {
        status: "blocked",
        missingResources: ["U", "K"],
        lastPlanActions: ["XGH2O", "XUH2O"],
        needsPlan: true,
        lastError: "lab_contaminated",
      },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 200,
    });

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.missingResources).toEqual(["U", "K"]);
    expect(snapshot.lastPlanActions).toEqual(["XGH2O", "XUH2O"]);
    expect(snapshot.lastError).toBe("lab_contaminated");
    expect(snapshot.needsPlan).toBe(true);
  });

  it("handles invisible hub room without crash", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 300,
    });

    expect(snapshot.hubRoomVisible).toBe(false);
    expect(snapshot.hubStorageEnergy).toBe(0);
    expect(snapshot.hubTerminalEnergy).toBe(0);
    expect(snapshot.hubInventory).toEqual({});
  });

  it("counts pending hub transfer tasks by type", () => {
    const tasks: Record<string, any> = {
      t1: makeMockTask({
        id: "t1",
        resource: "U" as ResourceConstant,
        fromRoomName: "W2N1",
        toRoomName: "W1N1",
        reason: "hub:import:U",
      }),
      t2: makeMockTask({
        id: "t2",
        resource: "XGH2O" as ResourceConstant,
        fromRoomName: "W3N1",
        toRoomName: "W1N1",
        reason: "hub:reclaim:XGH2O",
      }),
      t3: makeMockTask({
        id: "t3",
        resource: "XUHO2" as ResourceConstant,
        fromRoomName: "W1N1",
        toRoomName: "W4N1",
        reason: "hub:export:XUHO2",
      }),
      t4: makeMockTask({
        id: "t4",
        resource: "energy" as ResourceConstant,
        fromRoomName: "W5N1",
        toRoomName: "W6N1",
        reason: "energy_transfer",
      }),
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "importing" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: tasks,
      currentTick: 400,
    });

    expect(snapshot.pendingImports).toBe(1);
    expect(snapshot.pendingReclaims).toBe(1);
    expect(snapshot.pendingExports).toBe(1);
    expect(snapshot.pendingTasks).toHaveLength(3);
  });

  it("builds compact inventory with priority resources and top amounts", () => {
    const storageStore: Record<string, number> = {
      energy: 500000,
      U: 3000,
      K: 2000,
      L: 1000,
      Z: 500,
      O: 800,
      H: 600,
      OH: 400,
      ZK: 300,
      UL: 200,
      GH: 1000,
      GH2O: 500,
      XGH2O: 200,
      UH: 300,
      UH2O: 150,
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: ["XGH2O" as ResourceConstant, "XUHO2" as ResourceConstant],
      },
      hubRuntime: {
        status: "synthesizing",
        missingResources: ["U"],
        lastPlanActions: ["XGH2O"],
      },
      synthesisRuntime: { activeProduct: "GH2O" as ResourceConstant },
      hubStorageStore: storageStore,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 500,
    });

    expect(snapshot.hubRoomVisible).toBe(true);
    expect(snapshot.hubInventory["XGH2O"]).toBe(200);
    expect(snapshot.hubInventory["U"]).toBe(3000);
    expect(snapshot.hubInventory["GH2O"]).toBe(500);

    const inventoryKeys = Object.keys(snapshot.hubInventory);
    expect(inventoryKeys.length).toBeLessThan(16);
    expect(snapshot.hubInventory["energy"]).toBeUndefined();
  });

  it("captures lab inventory separately from hubInventory (storage+terminal)", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "synthesizing" },
      synthesisRuntime: { activeProduct: "UO" as ResourceConstant },
      hubStorageStore: { energy: 500000 },
      hubTerminalStore: {},
      hubLabInventory: { UO: 110 },
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 600,
    });

    expect(snapshot.hubLabInventory.UO).toBe(110);
    expect(snapshot.hubInventory.UO).toBeUndefined();
  });

  it("threads synthesisTargetAmount from synthesisRuntime", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "synthesizing" },
      synthesisRuntime: { activeProduct: "UO" as ResourceConstant, targetAmount: 106 },
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 700,
    });

    expect(snapshot.synthesisTargetAmount).toBe(106);
  });

  it("returns empty hubLabInventory when hub room is invisible", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 800,
    });

    expect(snapshot.hubLabInventory).toEqual({});
  });
});

describe("runHubProgressAnalytics", () => {
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

  it("writes analytics on sample interval tick", () => {
    Game.time = 100;
    runHubProgressAnalytics();

    expect(Memory.analytics?.hub).toBeDefined();
    expect(Memory.analytics!.hub!.updatedAt).toBe(100);
    expect(Memory.analytics!.hub!.enabled).toBe(true);
  });

  it("skips write on non-sample tick without needsPlan", () => {
    Game.time = 101;
    runHubProgressAnalytics();

    expect(Memory.analytics?.hub).toBeUndefined();
  });

  it("writes on non-sample tick when needsPlan is true", () => {
    Game.time = 101;
    Memory.runtime!.hub!.needsPlan = true;
    runHubProgressAnalytics();

    expect(Memory.analytics?.hub).toBeDefined();
    expect(Memory.analytics!.hub!.needsPlan).toBe(true);
  });

  it("skips when hub is disabled", () => {
    Memory.cfg!.hub!.enabled = false;
    Game.time = 100;
    runHubProgressAnalytics();

    expect(Memory.analytics?.hub).toBeUndefined();
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
      ...overrides,
    };
  }

  it("returns array of strings with core content", () => {
    const lines = buildHubOverlayLines(makeSnapshot());
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(8);
    const joined = lines.join(" ");
    expect(joined).toContain("importing");
    expect(joined).toContain("XGH2O");
    expect(joined).toContain("U");
  });

  it("caps at 8 lines even with many plan actions", () => {
    const manyActions = Array.from({ length: 15 }, (_, i) => `compound${i}`);
    const lines = buildHubOverlayLines(makeSnapshot({ lastPlanActions: manyActions }));
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it("shows inbound summary with single source room", () => {
    const lines = buildHubOverlayLines(makeSnapshot({
      pendingTasks: [
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 4000, reason: "hub:import:U" },
        { resource: "K", from: "W2N1", to: "W1N1", remaining: 4000, reason: "hub:import:K" },
      ],
    }));
    const inboundLine = lines.find(l => l.startsWith("inbound:"));
    expect(inboundLine).toBe("inbound: W2N1 8K (2 tasks)");
  });

  it("shows inbound summary with overflow rooms", () => {
    const lines = buildHubOverlayLines(makeSnapshot({
      pendingTasks: [
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 4000, reason: "hub:import:U" },
        { resource: "K", from: "W2N1", to: "W1N1", remaining: 4000, reason: "hub:import:K" },
        { resource: "L", from: "W3N1", to: "W1N1", remaining: 4000, reason: "hub:import:L" },
        { resource: "Z", from: "W4N1", to: "W1N1", remaining: 2000, reason: "hub:import:Z" },
      ],
    }));
    const inboundLine = lines.find(l => l.startsWith("inbound:"));
    expect(inboundLine).toBe("inbound: W2N1 8K (2 tasks), +2 more");
  });

  it("omits inbound line when no inbound tasks", () => {
    const lines = buildHubOverlayLines(makeSnapshot({ pendingTasks: [] }));
    expect(lines.some(l => l.startsWith("blocker:"))).toBe(false);
    expect(lines.some(l => l.includes("reserve="))).toBe(false);
    expect(lines.some(l => l.startsWith("inbound:"))).toBe(false);
  });

  it("still caps at 8 lines with inbound summary", () => {
    const lines = buildHubOverlayLines(makeSnapshot({
      pendingTasks: [
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 8000, reason: "hub:import:U" },
      ],
    }));
    expect(lines.length).toBeLessThanOrEqual(8);
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

  it("does not throw when RoomVisual is undefined", () => {
    const prev = (global as any).RoomVisual;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (global as any).RoomVisual;
    expect(() => renderHubProgressOverlays()).not.toThrow();
    (global as any).RoomVisual = prev;
  });

  it("renders only in hub room when multiple owned rooms exist", () => {
    (global as any).__resetRoomVisualCalls();

    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      W1N1: { name: "W1N1", controller: { my: true } } as any,
      W2N1: { name: "W2N1", controller: { my: true } } as any,
    };

    renderHubProgressOverlays();

    const calls: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls;
    expect(calls.every((c) => c.roomName === "W1N1")).toBe(true);
    expect(calls.some((c) => c.roomName === "W2N1")).toBe(false);
  });

  it("skips rendering when hub room is not visible", () => {
    (global as any).__resetRoomVisualCalls();

    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      W2N1: { name: "W2N1", controller: { my: true } } as any,
    };

    renderHubProgressOverlays();

    const calls: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls;
    expect(calls).toHaveLength(0);
  });

  it("skips rendering when hub config is disabled", () => {
    (global as any).__resetRoomVisualCalls();

    Memory.cfg!.hub!.enabled = false;
    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      W1N1: { name: "W1N1", controller: { my: true } } as any,
    };

    renderHubProgressOverlays();

    const calls: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls;
    expect(calls).toHaveLength(0);
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

  it("panel stays within visual primitive budget", () => {
    (global as any).__resetRoomVisualCalls();

    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      W1N1: { name: "W1N1", controller: { my: true } } as any,
    };
    Memory.runtime!.hub = {
      status: "blocked",
      updatedAt: 100,
      activeProduct: "XGH2O",
      activeStep: 2,
      missingResources: ["U", "K", "L", "Z"],
      lastPlanActions: ["XGH2O", "XUHO2"],
      needsPlan: true,
      lastError: "lab_contaminated",
    };

    renderHubProgressOverlays();

    const calls: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls;
    expect(calls.length).toBeLessThanOrEqual(40);
  });

  it("renders satellite panel in non-hub production rooms", () => {
    (global as any).__resetRoomVisualCalls();

    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      W1N1: { name: "W1N1", controller: { my: true } } as any,
      W2N1: { name: "W2N1", controller: { my: true } } as any,
    };

    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: [
        { roomName: "W1N1", product: "XGH2O" as ResourceConstant, targetAmount: 3000, isHubRoom: true },
        { roomName: "W2N1", product: "OH" as ResourceConstant, targetAmount: 5000, isHubRoom: false },
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
        W2N1: { stage: "synthesizing", activeProduct: "OH" as ResourceConstant, reagentLabIds: [], productLabIds: [], successfulRuns: 0, pendingTasks: 0, lastTransitionAt: 0 },
      },
    };
    Memory.cfg!.synthesisControl = {
      rooms: {
        W2N1: { reactions: [{ product: "OH", targetAmount: 5000 }] },
      },
    };
    Memory.data!.resourceControl = Memory.data!.resourceControl || { tasks: {} };

    renderHubProgressOverlays();

    const calls: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls;
    expect(calls.some(c => c.roomName === "W2N1")).toBe(true);
  });

  it("skips satellite panel for rooms without visibility", () => {
    (global as any).__resetRoomVisualCalls();

    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      W1N1: { name: "W1N1", controller: { my: true } } as any,
    };

    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: [
        { roomName: "W1N1", product: "XGH2O" as ResourceConstant, targetAmount: 3000, isHubRoom: true },
        { roomName: "W3N1", product: "OH" as ResourceConstant, targetAmount: 5000, isHubRoom: false },
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
        W3N1: { stage: "idle", reagentLabIds: [], productLabIds: [], successfulRuns: 0, pendingTasks: 0, lastTransitionAt: 0 },
      },
    };
    Memory.cfg!.synthesisControl = {
      rooms: {
        W3N1: { reactions: [{ product: "OH", targetAmount: 5000 }] },
      },
    };

    renderHubProgressOverlays();

    const calls: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls;
    expect(calls.every(c => c.roomName !== "W3N1")).toBe(true);
  });

  it("renders no satellite panels when productionRooms is empty", () => {
    (global as any).__resetRoomVisualCalls();

    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      W1N1: { name: "W1N1", controller: { my: true } } as any,
      W2N1: { name: "W2N1", controller: { my: true } } as any,
    };

    renderHubProgressOverlays();

    const calls: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls;
    expect(calls.every(c => c.roomName === "W1N1")).toBe(true);
  });

  it("satellite panel shows product, stage, and progress", () => {
    (global as any).__resetRoomVisualCalls();

    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      W1N1: { name: "W1N1", controller: { my: true } } as any,
      W2N1: { name: "W2N1", controller: { my: true } } as any,
    };

    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: [
        { roomName: "W1N1", product: "XGH2O" as ResourceConstant, targetAmount: 3000, isHubRoom: true },
        { roomName: "W2N1", product: "OH" as ResourceConstant, targetAmount: 1000, isHubRoom: false },
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
        W2N1: { stage: "synthesizing", activeProduct: "OH" as ResourceConstant, reagentLabIds: [], productLabIds: [], successfulRuns: 0, pendingTasks: 0, lastTransitionAt: 0 },
      },
    };
    Memory.cfg!.synthesisControl = {
      rooms: {
        W2N1: { reactions: [{ product: "OH", targetAmount: 1000 }] },
      },
    };

    renderHubProgressOverlays();

    const satelliteTexts: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls.filter(c => c.roomName === "W2N1" && c.method === "text");
    const headerText = satelliteTexts.find(c => typeof c.args[0] === "string" && c.args[0].includes("OH"));
    expect(headerText).toBeDefined();
    expect(headerText!.args[0]).toContain("synthesizing");
  });
});

describe("buildHubVisualModel", () => {
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
      roomTerminalBlockers: [
        { room: "W2N1", terminalEnergy: 0, reserve: 20000, pendingNonEnergy: 0 },
      ],
      hubLabInventory: {},
      hubCarrierCargo: {},
      productionRooms: [],
      ...overrides,
    };
  }

  it("fallback stock display: no synthesisTargetAmount uses 1000 stock", () => {
    const model = buildHubVisualModel(makeSnapshot({
      activeProduct: "XGH2O",
      hubInventory: { XGH2O: 500 },
    }));
    expect(model.productLabel).toBe("XGH2O");
    expect(model.progressPercent).toBe(0.5);
    expect(model.progressText).toContain("500/1000 stock");
  });

  it("idle state: productLabel=idle, progressPercent=0, progressText='0% idle'", () => {
    const model = buildHubVisualModel(makeSnapshot({
      activeProduct: null,
      status: null,
    }));
    expect(model.productLabel).toBe("idle");
    expect(model.progressPercent).toBe(0);
    expect(model.progressText).toBe("0% idle");
  });

  it("progress capped at 1 when inventory exceeds 1000 (fallback mode)", () => {
    const model = buildHubVisualModel(makeSnapshot({
      activeProduct: "XGH2O",
      hubInventory: { XGH2O: 2000 },
    }));
    expect(model.progressPercent).toBe(1);
  });

  it("batch mode: active UO synthesizing uses hubLabInventory + hubInventory", () => {
    const model = buildHubVisualModel(makeSnapshot({
      activeProduct: "UO",
      status: "synthesizing",
      synthesisTargetAmount: 106,
      hubLabInventory: { UO: 110 },
      hubInventory: {},
    }));
    expect(model.progressPercent).toBe(1);
    expect(model.progressText).toContain("UO");
    expect(model.progressText).toContain("110");
    expect(model.progressText).toContain("106");
    expect(model.progressText).not.toContain("1000");
    expect(model.progressText).not.toContain("stock");
  });

  it("batch mode: active UO unloading sums both inventories", () => {
    const model = buildHubVisualModel(makeSnapshot({
      activeProduct: "UO",
      status: "unloading",
      stage: "unloading",
      synthesisTargetAmount: 106,
      hubLabInventory: { UO: 50 },
      hubInventory: { UO: 60 },
    }));
    expect(model.progressPercent).toBe(1);
    expect(model.progressText).toContain("UO");
    expect(model.progressText).toContain("110");
    expect(model.progressText).toContain("106");
    expect(model.progressText).toContain("unloading");
    expect(model.progressText).not.toContain("1000");
    expect(model.progressText).not.toContain("stock");
  });

  it("batch mode: partial progress under target", () => {
    const model = buildHubVisualModel(makeSnapshot({
      activeProduct: "GH",
      status: "acquiring",
      synthesisTargetAmount: 200,
      hubLabInventory: { GH: 80 },
      hubInventory: { GH: 0 },
    }));
    expect(model.progressPercent).toBeCloseTo(0.4);
    expect(model.progressText).toContain("80/200");
    expect(model.progressText).toContain("acquiring");
  });

  it("batch mode: progress capped at 1 when amount exceeds target", () => {
    const model = buildHubVisualModel(makeSnapshot({
      activeProduct: "UO",
      status: "synthesizing",
      synthesisTargetAmount: 100,
      hubLabInventory: { UO: 150 },
      hubInventory: {},
    }));
    expect(model.progressPercent).toBe(1);
    expect(model.progressText).toContain("150/100");
  });

  it("fallback stock display: activeProduct without synthesisTargetAmount", () => {
    const model = buildHubVisualModel(makeSnapshot({
      activeProduct: "XGH2O",
      hubInventory: { XGH2O: 500 },
      synthesisTargetAmount: undefined,
    }));
    expect(model.progressText).toContain("500/1000 stock");
  });

  it("missing resources truncated to first 4 with +N suffix", () => {
    const model = buildHubVisualModel(makeSnapshot({
      missingResources: ["U", "K", "L", "Z", "O", "H", "OH"],
    }));
    expect(model.missingSummary).toContain("U");
    expect(model.missingSummary).toContain("K");
    expect(model.missingSummary).toContain("L");
    expect(model.missingSummary).toContain("Z");
    expect(model.missingSummary).toContain("+3");
  });

  it("blockers truncated to 2 entries with overflow count", () => {
    const model = buildHubVisualModel(makeSnapshot({
      pendingTasks: [
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 1000, reason: "hub:import:U" },
        { resource: "K", from: "W3N1", to: "W1N1", remaining: 2000, reason: "hub:import:K" },
        { resource: "L", from: "W4N1", to: "W1N1", remaining: 3000, reason: "hub:import:L" },
        { resource: "Z", from: "W5N1", to: "W1N1", remaining: 4000, reason: "hub:import:Z" },
        { resource: "O", from: "W6N1", to: "W1N1", remaining: 5000, reason: "hub:import:O" },
      ],
    }));
    expect(model.inboundRows).toHaveLength(2);
    expect(model.inboundOverflow).toBe(3);
  });

  it("no blockers: empty rows and zero overflow", () => {
    const model = buildHubVisualModel(makeSnapshot({
      pendingTasks: [],
    }));
    expect(model.inboundRows).toHaveLength(0);
    expect(model.inboundOverflow).toBe(0);
  });

  it("disabled snapshot: still returns model with idle defaults", () => {
    const model = buildHubVisualModel(makeSnapshot({
      enabled: false,
      activeProduct: null,
      status: null,
    }));
    expect(model.productLabel).toBe("idle");
    expect(model.progressPercent).toBe(0);
  });
});

describe("drawHubVisualPanel", () => {
  function makeModel(overrides: Partial<HubVisualModel> = {}): HubVisualModel {
    return {
      productLabel: "XGH2O",
      statusLabel: "synthesizing",
      stageLabel: "reacting",
      needsPlan: false,
      progressPercent: 0.5,
      progressText: "500/1000 stock",
      missingSummary: "",
      logisticsCounts: { imports: 0, reclaims: 0, exports: 0 },
      inboundRows: [],
      inboundOverflow: 0,
      ...overrides,
    };
  }

  function getCalls(): Array<{ roomName: string; method: string; args: any[] }> {
    return (global as any).__roomVisualCalls;
  }

  function findCalls(method: string, predicate?: (args: any[]) => boolean): Array<{ roomName: string; method: string; args: any[] }> {
    return getCalls().filter(c => c.method === method && (!predicate || predicate(c.args)));
  }

  beforeEach(() => {
    (global as any).__resetRoomVisualCalls();
  });

  it("renders production header and product row", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({ productLabel: "XGH2O", statusLabel: "synthesizing" });
    drawHubVisualPanel(rv, model);

    const headerRects = findCalls("rect", args => args[4]?.fill === "#1a1a2e");
    expect(headerRects.length).toBeGreaterThanOrEqual(1);

    const titleTexts = findCalls("text", args => args[0] === "Hub Production");
    expect(titleTexts).toHaveLength(1);

    const productTexts = findCalls("text", args => args[0] === "XGH2O");
    expect(productTexts).toHaveLength(1);
  });

  it("renders progress bar outline and fill at 50%", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({ progressPercent: 0.5, progressText: "500/1000 stock" });
    drawHubVisualPanel(rv, model);

    const barWidth = 13.5 - 0.5;
    const outlines = findCalls("rect", args => args[4]?.fill === "transparent");
    const barOutlines = outlines.filter(c => Math.abs(c.args[2] - barWidth) < 0.01);
    expect(barOutlines.length).toBeGreaterThanOrEqual(1);

    const fills = findCalls("rect", args => args[4]?.fill === "#00ff88" && args[4]?.strokeWidth === 0);
    expect(fills).toHaveLength(1);
    expect(Math.abs(fills[0].args[2] - barWidth * 0.5)).toBeLessThan(0.01);

    const labelTexts = findCalls("text", args => args[0] === "500/1000 stock");
    expect(labelTexts).toHaveLength(1);
  });

  it("draws no fill rect when progressPercent is 0", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({ progressPercent: 0, progressText: "0% idle", productLabel: "idle" });
    drawHubVisualPanel(rv, model);

    const coloredFills = findCalls("rect", args =>
      args[4]?.fill === "#00ff88" ||
      args[4]?.fill === "#ffaa00" ||
      args[4]?.fill === "#ff5555"
    );
    expect(coloredFills).toHaveLength(0);
  });

  it("shows needs plan warning row", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({ needsPlan: true });
    drawHubVisualPanel(rv, model);

    const warningTexts = findCalls("text", args =>
      typeof args[0] === "string" && args[0].includes("needs plan") && args[3]?.color === "#ffaa00"
    );
    expect(warningTexts).toHaveLength(1);
  });

  it("omits stage row when stageLabel is null", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({ stageLabel: null });
    drawHubVisualPanel(rv, model);

    const stageTexts = findCalls("text", args =>
      typeof args[0] === "string" && args[0].startsWith("stage:")
    );
    expect(stageTexts).toHaveLength(0);
  });

  it("uses error color when status is blocked", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({ statusLabel: "blocked" });
    drawHubVisualPanel(rv, model);

    const progressFills = findCalls("rect", args => args[4]?.fill === "#ff5555");
    expect(progressFills.length).toBeGreaterThanOrEqual(1);
  });

  it("uses muted color when idle with no product", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({ productLabel: "idle", statusLabel: "—", progressPercent: 0 });
    drawHubVisualPanel(rv, model);

    const mutedFills = findCalls("rect", args => args[4]?.fill === "#888888");
    expect(mutedFills).toHaveLength(0);

    const mutedTexts = findCalls("text", args => args[3]?.color === "#888888");
    expect(mutedTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("renders logistics section header", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    drawHubVisualPanel(rv, model);

    const logisticsTitle = findCalls("text", args => args[0] === "Logistics");
    expect(logisticsTitle).toHaveLength(1);
  });

  it("logistics summary row with no inbound", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({
      logisticsCounts: { imports: 3, reclaims: 1, exports: 2 },
      inboundRows: [],
      inboundOverflow: 0,
    });
    drawHubVisualPanel(rv, model);

    const textCalls = findCalls("text");
    const logisticsSummary = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("imp 3"));
    expect(logisticsSummary).toBeDefined();
    expect(logisticsSummary!.args[0]).toContain("recl 1");
    expect(logisticsSummary!.args[0]).toContain("exp 2");

    const inboundNone = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("inbound: none"));
    expect(inboundNone).toBeDefined();
  });

  it("renders one inbound row without overflow", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({
      inboundRows: [{ room: "W3N1", amount: 500, taskCount: 1 }],
      inboundOverflow: 0,
    });
    drawHubVisualPanel(rv, model);

    const textCalls = findCalls("text");
    const inboundText = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("W3N1"));
    expect(inboundText).toBeDefined();
    // taskCount=1: no task count shown
    expect(inboundText!.args[0]).toBe("W3N1: 500 inbound");
    expect(inboundText!.args[3]?.color).toBe("#ffaa00");

    const overflow = textCalls.find(c => typeof c.args[0] === "string" && /\+\d+ more/.test(c.args[0]));
    expect(overflow).toBeUndefined();
  });

  it("caps inbound rows and shows overflow count", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({
      inboundRows: [
        { room: "W2N1", amount: 8000, taskCount: 2 },
        { room: "W3N1", amount: 200, taskCount: 1 },
      ],
      inboundOverflow: 3,
    });
    drawHubVisualPanel(rv, model);

    const textCalls = findCalls("text");
    const row1 = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("W2N1"));
    const row2 = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("W3N1"));
    expect(row1).toBeDefined();
    expect(row1!.args[0]).toBe("W2N1: 8K inbound (2 tasks)");
    expect(row1!.args[3]?.color).toBe("#ffaa00");
    expect(row2).toBeDefined();
    expect(row2!.args[0]).toBe("W3N1: 200 inbound");

    const overflow = textCalls.find(c => typeof c.args[0] === "string" && c.args[0] === "+3 more inbound");
    expect(overflow).toBeDefined();
    expect(overflow!.args[3]?.color).toBe("#888888");
  });

  it("minimal model: logistics header Y follows progress bar stride", () => {
    const rv = new RoomVisual("W1N1");
    // Minimal model: idle state, no optional rows, no inbound
    const model = makeModel({
      productLabel: "idle",
      statusLabel: "—",
      stageLabel: null,
      needsPlan: false,
      progressPercent: 0,
      progressText: "0% idle",
      inboundRows: [],
      inboundOverflow: 0,
    });
    drawHubVisualPanel(rv, model);

    // Section headers are rect calls with VIS_HEADER_FILL ("#1a1a2e")
    const headerRects = findCalls("rect", args => args[4]?.fill === "#1a1a2e");
    expect(headerRects.length).toBe(3);

    const hubProdY = headerRects[0].args[1]; // y=2.0
    const progressY = headerRects[1].args[1]; // should be 4.1
    const logisticsY = headerRects[2].args[1]; // should be 5.4

    // Hub Production at y=2.0
    expect(hubProdY).toBeCloseTo(2.0, 2);

    // Progress header at y=4.1 (2.0 + 0.7 headerStride + 0.7 rowHeight + 0.7 spacer + 0.7 headerStride = 4.1)
    // Actually: sectionHeader("Hub Production") advances by headerStride(0.7) → y=2.7
    //   textRow("idle") advances by rowHeight(0.7) → y=3.4
    //   spacer(0.7) → y=4.1
    //   sectionHeader("Progress") rect drawn at y=4.1, then cursor advances → y=4.8
    expect(progressY).toBeCloseTo(4.1, 2);

    // Logistics header at y=5.4 (4.1 + 0.7 headerStride + 0.6 barStride)
    //   sectionHeader("Progress") advances cursor to 4.8
    //   progressBar advances by barHeight+barPad=0.6 → y=5.4
    //   sectionHeader("Logistics") rect drawn at y=5.4
    expect(logisticsY).toBeCloseTo(5.4, 2);

    // KEY REGRESSION ASSERTION: The gap between Progress section end and Logistics header
    // must be 0.6 (progressBar stride), NOT 0.7 (old HUB_VISUAL_ROW bug).
    // Progress header rect is at 4.1, cursor after sectionHeader = 4.1 + 0.7 = 4.8
    // After progressBar: 4.8 + 0.6 = 5.4 = logisticsY
    // logisticsY - (progressY + headerStride) = 5.4 - (4.1 + 0.7) = 0.6 (NOT 0.7)
    const gapAfterProgressBar = logisticsY - (progressY + 0.7);
    expect(gapAfterProgressBar).toBeCloseTo(0.6, 2);
    // Explicitly assert it is NOT 0.7 — catches the old bug where y+=HUB_VISUAL_ROW was used
    expect(gapAfterProgressBar).not.toBeCloseTo(0.7, 2);
  });

  it("full model: all sections at deterministic Y positions", () => {
    const rv = new RoomVisual("W1N1");
    // Full model: all optional rows present, 2 inbound + overflow
    const model = makeModel({
      productLabel: "XGH2O",
      statusLabel: "synthesizing",
      stageLabel: "reacting",
      needsPlan: true,
      progressPercent: 0.5,
      progressText: "500/1000 stock",
      inboundRows: [
        { room: "W2N1", amount: 100, taskCount: 1 },
        { room: "W3N1", amount: 200, taskCount: 2 },
      ],
      inboundOverflow: 3,
    });
    drawHubVisualPanel(rv, model);

    const headerRects = findCalls("rect", args => args[4]?.fill === "#1a1a2e");
    expect(headerRects.length).toBe(3);

    const hubProdY = headerRects[0].args[1];
    const progressY = headerRects[1].args[1];
    const logisticsY = headerRects[2].args[1];

    // Hub Production at y=2.0
    expect(hubProdY).toBeCloseTo(2.0, 2);

    // Cursor trace: 2.0 + 0.7(header) + 0.7(product) + 0.7(status) + 0.7(stage) + 0.7(needsPlan) + 0.7(spacer) = 6.2
    // Progress sectionHeader rect drawn at y=6.2
    expect(progressY).toBeCloseTo(6.2, 2);

    // Cursor after Progress header: 6.2 + 0.7 = 6.9
    // After progressBar: 6.9 + 0.6 = 7.5
    // Logistics sectionHeader rect drawn at y=7.5
    expect(logisticsY).toBeCloseTo(7.5, 2);

    // KEY REGRESSION ASSERTION: gap after progressBar must be 0.6, not 0.7
    const gapAfterProgressBar = logisticsY - (progressY + 0.7);
    expect(gapAfterProgressBar).toBeCloseTo(0.6, 2);
    expect(gapAfterProgressBar).not.toBeCloseTo(0.7, 2);
  });

  it("inbound section contains no reserve/blocker/term/nonE text", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({
      inboundRows: [
        { room: "W2N1", amount: 5000, taskCount: 1 },
      ],
      inboundOverflow: 2,
    });
    drawHubVisualPanel(rv, model);

    const textCalls = findCalls("text").filter(c => typeof c.args[0] === "string");
    const forbidden = ["reserve", "blocker", "term", "nonE"];
    const violations: string[] = [];
    for (const call of textCalls) {
      const text: string = call.args[0];
      if (text.includes("inbound") || text.includes("more inbound") || text.includes("inbound: none")) {
        for (const word of forbidden) {
          if (text.toLowerCase().includes(word.toLowerCase())) {
            violations.push(`"${text}" contains "${word}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("buildInboundTransferRows", () => {
  function makeSnapshot(overrides: Partial<HubProgressSnapshot> = {}): HubProgressSnapshot {
    return {
      updatedAt: 100,
      enabled: true,
      hubRoomName: "W1N1",
      hubRoomVisible: true,
      status: "importing",
      stage: null,
      activeProduct: null,
      lastPlanActions: [],
      missingResources: [],
      lastError: null,
      needsPlan: false,
      hubStorageEnergy: 0,
      hubTerminalEnergy: 0,
      hubInventory: {},
      pendingImports: 0,
      pendingReclaims: 0,
      pendingExports: 0,
      pendingTasks: [],
      roomTerminalBlockers: [],
      hubLabInventory: {},
      hubCarrierCargo: {},
      productionRooms: [],
      ...overrides,
    };
  }

  it("groups two inbound tasks from same source room", () => {
    const result = buildInboundTransferRows(makeSnapshot({
      hubRoomName: "W1N1",
      pendingTasks: [
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 3000, reason: "hub:import:U" },
        { resource: "K", from: "W2N1", to: "W1N1", remaining: 5000, reason: "hub:import:K" },
      ],
    }));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({ room: "W2N1", amount: 8000, taskCount: 2 });
    expect(result.overflow).toBe(0);
  });

  it("excludes export tasks from hub", () => {
    const result = buildInboundTransferRows(makeSnapshot({
      hubRoomName: "W1N1",
      pendingTasks: [
        { resource: "XUHO2", from: "W1N1", to: "W2N1", remaining: 1000, reason: "hub:export:XUHO2" },
      ],
    }));

    expect(result.rows).toHaveLength(0);
    expect(result.overflow).toBe(0);
  });

  it("three source rooms: 2 visible rows and overflow=1", () => {
    const result = buildInboundTransferRows(makeSnapshot({
      hubRoomName: "W1N1",
      pendingTasks: [
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 5000, reason: "hub:import:U" },
        { resource: "K", from: "W3N1", to: "W1N1", remaining: 3000, reason: "hub:import:K" },
        { resource: "L", from: "W4N1", to: "W1N1", remaining: 1000, reason: "hub:import:L" },
      ],
    }));

    expect(result.rows).toHaveLength(2);
    expect(result.overflow).toBe(1);
    // Sorted by amount descending
    expect(result.rows[0].room).toBe("W2N1");
    expect(result.rows[1].room).toBe("W3N1");
  });

  it("no inbound tasks: empty rows and zero overflow", () => {
    const result = buildInboundTransferRows(makeSnapshot({
      hubRoomName: "W1N1",
      pendingTasks: [],
    }));

    expect(result.rows).toHaveLength(0);
    expect(result.overflow).toBe(0);
  });

  it("excludes non-hub-to-non-hub tasks", () => {
    const result = buildInboundTransferRows(makeSnapshot({
      hubRoomName: "W1N1",
      pendingTasks: [
        { resource: "energy", from: "W2N1", to: "W3N1", remaining: 5000, reason: "energy_transfer" },
      ],
    }));

    expect(result.rows).toHaveLength(0);
    expect(result.overflow).toBe(0);
  });

  it("sorts by amount descending, then room name ascending for ties", () => {
    const result = buildInboundTransferRows(makeSnapshot({
      hubRoomName: "W1N1",
      pendingTasks: [
        { resource: "U", from: "W3N1", to: "W1N1", remaining: 3000, reason: "hub:import:U" },
        { resource: "K", from: "W2N1", to: "W1N1", remaining: 3000, reason: "hub:import:K" },
      ],
    }));

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].room).toBe("W2N1");
    expect(result.rows[1].room).toBe("W3N1");
  });
});

describe("collectCarrierCargoInventory", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.creeps = {};
  });

  it("counts non-energy cargo from carriers assigned to hub room", () => {
    getCreepConfigService().upsert("W8N1:carrier:0", "carrier", [], "W8N1");

    Game.creeps = {
      c1: {
        memory: { role: "carrier", configName: "W8N1:carrier:0" },
        room: { name: "W8N1" },
        store: { [RESOURCE_UTRIUM]: 500, [RESOURCE_ENERGY]: 100 } as unknown as StoreDefinition,
      } as any,
    };

    const result = collectCarrierCargoInventory("W8N1");
    expect(result).toEqual({ U: 500 });
  });

  it("excludes carriers assigned to other rooms", () => {
    getCreepConfigService().upsert("W8N2:carrier:0", "carrier", [], "W8N2");

    Game.creeps = {
      c2: {
        memory: { role: "carrier", configName: "W8N2:carrier:0" },
        room: { name: "W8N1" },
        store: { [RESOURCE_KEANIUM]: 300 } as unknown as StoreDefinition,
      } as any,
    };

    const result = collectCarrierCargoInventory("W8N1");
    expect(result).toEqual({});
  });

  it("excludes non-carrier creeps", () => {
    Game.creeps = {
      c3: {
        memory: { role: "worker", configName: undefined },
        room: { name: "W8N1" },
        store: { [RESOURCE_UTRIUM]: 200 } as unknown as StoreDefinition,
      } as any,
    };

    const result = collectCarrierCargoInventory("W8N1");
    expect(result).toEqual({});
  });

  it("returns empty record when no matching carriers", () => {
    Game.creeps = {};
    const result = collectCarrierCargoInventory("W8N1");
    expect(result).toEqual({});
  });
});

describe("buildCompactInventory carrier cargo merge", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
  });

  it("merges carrier cargo with storage in buildHubProgressSnapshot", () => {
    getCreepConfigService().upsert("W8N1:carrier:0", "carrier", [], "W8N1");

    Game.creeps = {
      c1: {
        memory: { role: "carrier", configName: "W8N1:carrier:0" },
        room: { name: "W8N1" },
        store: { U: 500, energy: 0 } as unknown as StoreDefinition,
      } as any,
    };

    // We cannot call buildHubProgressSnapshot directly with hubCarrierCargo
    // because it's an input field. Test the merge via the snapshot builder.
    const storageStore: Record<string, number> = {
      energy: 500000,
      U: 1000,
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W8N1" },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: storageStore,
      hubTerminalStore: null,
      hubCarrierCargo: { U: 500, K: 200 },
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 100,
    });

    // U should be merged: 1000 (storage) + 500 (carrier) = 1500
    expect(snapshot.hubInventory.U).toBe(1500);
    // K comes only from carrier cargo
    expect(snapshot.hubInventory.K).toBe(200);
    // Energy is excluded from compact inventory
    expect(snapshot.hubInventory.energy).toBeUndefined();
    // hubCarrierCargo is passed through
    expect(snapshot.hubCarrierCargo).toEqual({ U: 500, K: 200 });
  });
});

describe("buildHubProgressSnapshot productionRooms (distributed synthesis)", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.rooms = {};
  });

  it("returns empty productionRooms when no distributed synthesis data", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 100,
    });

    expect(snapshot.productionRooms).toEqual([]);
  });

  it("returns empty productionRooms when no dispatch assignments", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 100,
      distributedSynthesis: {
        dispatchAssignments: [],
        routeDecisions: [],
        progressEdges: [],
      },
    });

    expect(snapshot.productionRooms).toEqual([]);
  });

  it("populates productionRooms with hub and auxiliary room entries", () => {
    Game.rooms = {
      W1N1: {
        name: "W1N1",
        storage: { store: { UH: 200, energy: 50000 } as unknown as StoreDefinition },
        terminal: { store: { UH: 50, energy: 10000 } as unknown as StoreDefinition },
        find: () => [],
      } as any,
      W2N1: {
        name: "W2N1",
        storage: { store: { OH: 300, energy: 40000 } as unknown as StoreDefinition },
        terminal: { store: { energy: 5000 } as unknown as StoreDefinition },
        find: () => [],
      } as any,
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "synthesizing" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 200,
      distributedSynthesis: {
        dispatchAssignments: [
          { roomName: "W1N1", product: "UH" as ResourceConstant, targetAmount: 1000, isHubRoom: true },
          { roomName: "W2N1", product: "OH" as ResourceConstant, targetAmount: 500, isHubRoom: false },
        ],
        routeDecisions: [],
        progressEdges: [],
      },
      synthesisControlRooms: {
        W1N1: { stage: "synthesizing" },
        W2N1: { stage: "loading" },
      },
    });

    expect(snapshot.productionRooms).toHaveLength(2);

    const hubEntry = snapshot.productionRooms.find(r => r.roomName === "W1N1");
    expect(hubEntry).toBeDefined();
    expect(hubEntry!.product).toBe("UH");
    expect(hubEntry!.stage).toBe("synthesizing");
    expect(hubEntry!.currentAmount).toBe(250);
    expect(hubEntry!.targetAmount).toBe(1000);
    expect(hubEntry!.progressPercent).toBeCloseTo(0.25);
    expect(hubEntry!.isHubRoom).toBe(true);

    const auxEntry = snapshot.productionRooms.find(r => r.roomName === "W2N1");
    expect(auxEntry).toBeDefined();
    expect(auxEntry!.product).toBe("OH");
    expect(auxEntry!.stage).toBe("loading");
    expect(auxEntry!.currentAmount).toBe(300);
    expect(auxEntry!.targetAmount).toBe(500);
    expect(auxEntry!.progressPercent).toBeCloseTo(0.6);
    expect(auxEntry!.isHubRoom).toBe(false);
  });

  it("shows producer→consumer links for direct-routed intermediates", () => {
    Game.rooms = {
      W1N1: { name: "W1N1", storage: { store: {} as unknown as StoreDefinition }, terminal: { store: {} as unknown as StoreDefinition }, find: () => [] } as any,
      W2N1: { name: "W2N1", storage: { store: {} as unknown as StoreDefinition }, terminal: { store: {} as unknown as StoreDefinition }, find: () => [] } as any,
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "synthesizing" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 300,
      distributedSynthesis: {
        dispatchAssignments: [
          { roomName: "W2N1", product: "OH" as ResourceConstant, targetAmount: 500, isHubRoom: false },
          { roomName: "W1N1", product: "UH2O" as ResourceConstant, targetAmount: 200, isHubRoom: true },
        ],
        routeDecisions: [
          { fromRoom: "W2N1", toRoom: "W1N1", resource: "OH" as ResourceConstant, amount: 400, fee: 20 },
        ],
        progressEdges: [
          { fromRoom: "W2N1", toRoom: "W1N1", resource: "OH" as ResourceConstant, delivered: 100, total: 400 },
        ],
      },
      synthesisControlRooms: {
        W1N1: { stage: "acquiring" },
        W2N1: { stage: "synthesizing" },
      },
    });

    const w2n1 = snapshot.productionRooms.find(r => r.roomName === "W2N1");
    expect(w2n1!.upstream).toEqual([]);
    expect(w2n1!.downstream).toEqual([{ roomName: "W1N1", resource: "OH" }]);
    expect(w2n1!.directSupplyAmount).toBe(0);
    expect(w2n1!.hubSurplusAmount).toBe(400);

    const w1n1 = snapshot.productionRooms.find(r => r.roomName === "W1N1");
    expect(w1n1!.upstream).toEqual([{ roomName: "W2N1", resource: "OH" }]);
    expect(w1n1!.downstream).toEqual([]);
  });

  it("distinguishes direct-supply amount from hub-bound surplus", () => {
    Game.rooms = {
      W1N1: { name: "W1N1", storage: { store: {} as unknown as StoreDefinition }, terminal: { store: {} as unknown as StoreDefinition }, find: () => [] } as any,
      W2N1: { name: "W2N1", storage: { store: {} as unknown as StoreDefinition }, terminal: { store: {} as unknown as StoreDefinition }, find: () => [] } as any,
      W3N1: { name: "W3N1", storage: { store: {} as unknown as StoreDefinition }, terminal: { store: {} as unknown as StoreDefinition }, find: () => [] } as any,
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "distributing" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 400,
      distributedSynthesis: {
        dispatchAssignments: [
          { roomName: "W2N1", product: "OH" as ResourceConstant, targetAmount: 1000, isHubRoom: false },
        ],
        routeDecisions: [
          { fromRoom: "W2N1", toRoom: "W3N1", resource: "OH" as ResourceConstant, amount: 300, fee: 15 },
          { fromRoom: "W2N1", toRoom: "W1N1", resource: "OH" as ResourceConstant, amount: 500, fee: 25 },
        ],
        progressEdges: [],
      },
      synthesisControlRooms: {
        W2N1: { stage: "unloading" },
      },
    });

    const w2n1 = snapshot.productionRooms.find(r => r.roomName === "W2N1");
    expect(w2n1!.directSupplyAmount).toBe(300);
    expect(w2n1!.hubSurplusAmount).toBe(500);
  });

  it("includes blocker from synthesisControl runtime lastError", () => {
    Game.rooms = {
      W1N1: { name: "W1N1", storage: { store: {} as unknown as StoreDefinition }, terminal: { store: {} as unknown as StoreDefinition }, find: () => [] } as any,
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "blocked" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 500,
      distributedSynthesis: {
        dispatchAssignments: [
          { roomName: "W1N1", product: "XGH2O" as ResourceConstant, targetAmount: 500, isHubRoom: true },
        ],
        routeDecisions: [],
        progressEdges: [],
      },
      synthesisControlRooms: {
        W1N1: { stage: "blocked", lastError: "lab_contaminated" },
      },
    });

    const hubEntry = snapshot.productionRooms[0];
    expect(hubEntry.blocker).toBe("lab_contaminated");
    expect(hubEntry.stage).toBe("blocked");
  });

  it("uses idle stage and zero amounts for invisible rooms", () => {
    Game.rooms = {};

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 600,
      distributedSynthesis: {
        dispatchAssignments: [
          { roomName: "W2N1", product: "UO" as ResourceConstant, targetAmount: 500, isHubRoom: false },
        ],
        routeDecisions: [],
        progressEdges: [],
      },
    });

    const entry = snapshot.productionRooms[0];
    expect(entry.stage).toBe("idle");
    expect(entry.currentAmount).toBe(0);
    expect(entry.progressPercent).toBe(0);
    expect(entry.blocker).toBeNull();
  });

  it("progressPercent capped at 1 when currentAmount exceeds target", () => {
    Game.rooms = {
      W1N1: {
        name: "W1N1",
        storage: { store: { UO: 600 } as unknown as StoreDefinition },
        terminal: { store: {} as unknown as StoreDefinition },
        find: () => [],
      } as any,
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "synthesizing" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 700,
      distributedSynthesis: {
        dispatchAssignments: [
          { roomName: "W1N1", product: "UO" as ResourceConstant, targetAmount: 500, isHubRoom: true },
        ],
        routeDecisions: [],
        progressEdges: [],
      },
      synthesisControlRooms: {
        W1N1: { stage: "unloading" },
      },
    });

    expect(snapshot.productionRooms[0].progressPercent).toBe(1);
  });

  it("includes lab product in currentAmount calculation", () => {
    Game.rooms = {
      W1N1: {
        name: "W1N1",
        storage: { store: { UH: 50 } as unknown as StoreDefinition },
        terminal: { store: {} as unknown as StoreDefinition },
        find: () => [
          { store: { UH: 30, energy: 500 } as unknown as StoreDefinition, structureType: STRUCTURE_LAB },
        ],
      } as any,
    };

    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "synthesizing" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 800,
      distributedSynthesis: {
        dispatchAssignments: [
          { roomName: "W1N1", product: "UH" as ResourceConstant, targetAmount: 200, isHubRoom: true },
        ],
        routeDecisions: [],
        progressEdges: [],
      },
      synthesisControlRooms: {
        W1N1: { stage: "synthesizing" },
      },
    });

    expect(snapshot.productionRooms[0].currentAmount).toBe(80);
  });
});

describe("drawHubVisualPanel distributed production rendering", () => {
  function makeModel(overrides: Partial<HubVisualModel> = {}): HubVisualModel {
    return {
      productLabel: "idle",
      statusLabel: "—",
      stageLabel: null,
      needsPlan: false,
      progressPercent: 0,
      progressText: "0% idle",
      missingSummary: "",
      logisticsCounts: { imports: 0, reclaims: 0, exports: 0 },
      inboundRows: [],
      inboundOverflow: 0,
      ...overrides,
    };
  }

  function makeProductionRoom(overrides: Partial<ProductionRoomEntry> = {}): ProductionRoomEntry {
    return {
      roomName: "W2N1",
      product: "OH" as ResourceConstant,
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

  function getCalls(): Array<{ roomName: string; method: string; args: any[] }> {
    return (global as any).__roomVisualCalls;
  }

  function findText(predicate: (text: string) => boolean): Array<{ roomName: string; method: string; args: any[] }> {
    return getCalls().filter(c => c.method === "text" && typeof c.args[0] === "string" && predicate(c.args[0]));
  }

  beforeEach(() => {
    (global as any).__resetRoomVisualCalls();
  });

  it("renders Distributed Production section header when production rooms exist", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    const rooms = [makeProductionRoom()];
    drawHubVisualPanel(rv, model, rooms);

    const headers = findText(t => t === "Distributed Production");
    expect(headers).toHaveLength(1);
  });

  it("omits Distributed Production section when no production rooms", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    drawHubVisualPanel(rv, model, []);
    drawHubVisualPanel(rv, model);

    const headers = findText(t => t === "Distributed Production");
    expect(headers).toHaveLength(0);
  });

  it("renders room name, product, and stage for each production room", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    const rooms = [
      makeProductionRoom({ roomName: "W2N1", product: "OH", stage: "synthesizing" }),
    ];
    drawHubVisualPanel(rv, model, rooms);

    const roomTexts = findText(t => t.includes("W2N1") && t.includes("OH") && t.includes("synthesizing"));
    expect(roomTexts).toHaveLength(1);
  });

  it("renders hub room with star marker", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    const rooms = [
      makeProductionRoom({ roomName: "W1N1", product: "XGH2O", isHubRoom: true }),
    ];
    drawHubVisualPanel(rv, model, rooms);

    const hubTexts = findText(t => t.includes("W1N1") && t.includes("★"));
    expect(hubTexts).toHaveLength(1);
  });

  it("renders upstream links with ← prefix", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    const rooms = [
      makeProductionRoom({
        roomName: "W1N1",
        product: "UH2O",
        upstream: [
          { roomName: "W2N1", resource: "OH" as ResourceConstant },
          { roomName: "W3N1", resource: "UH" as ResourceConstant },
        ],
      }),
    ];
    drawHubVisualPanel(rv, model, rooms);

    const upstreamTexts = findText(t => t.includes("←W2N1"));
    expect(upstreamTexts).toHaveLength(1);
  });

  it("renders downstream links with → prefix", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    const rooms = [
      makeProductionRoom({
        roomName: "W2N1",
        product: "OH",
        downstream: [
          { roomName: "W1N1", resource: "OH" as ResourceConstant },
        ],
      }),
    ];
    drawHubVisualPanel(rv, model, rooms);

    const downstreamTexts = findText(t => t.includes("→W1N1"));
    expect(downstreamTexts).toHaveLength(1);
  });

  it("caps upstream links at 2 with overflow count", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    const rooms = [
      makeProductionRoom({
        roomName: "W1N1",
        product: "XGH2O",
        upstream: [
          { roomName: "W2N1", resource: "GH" as ResourceConstant },
          { roomName: "W3N1", resource: "OH" as ResourceConstant },
          { roomName: "W4N1", resource: "UH" as ResourceConstant },
        ],
      }),
    ];
    drawHubVisualPanel(rv, model, rooms);

    const linkTexts = findText(t => t.includes("←") && t.includes("+1"));
    expect(linkTexts).toHaveLength(1);
  });

  it("renders direct supply and hub surplus amounts", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    const rooms = [
      makeProductionRoom({
        roomName: "W2N1",
        directSupplyAmount: 3000,
        hubSurplusAmount: 5000,
      }),
    ];
    drawHubVisualPanel(rv, model, rooms);

    const supplyTexts = findText(t => t.includes("direct:") && t.includes("hub:"));
    expect(supplyTexts).toHaveLength(1);
    expect(supplyTexts[0].args[0]).toContain("3K");
    expect(supplyTexts[0].args[0]).toContain("5K");
  });

  it("renders blocker with error color", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    const rooms = [
      makeProductionRoom({
        roomName: "W1N1",
        product: "XGH2O",
        stage: "blocked",
        blocker: "lab_contaminated",
      }),
    ];
    drawHubVisualPanel(rv, model, rooms);

    const blockerTexts = findText(t => t.includes("lab_contaminated"));
    expect(blockerTexts).toHaveLength(1);
    expect(blockerTexts[0].args[3]?.color).toBe("#ff5555");
  });

  it("caps production room rows at 6", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    const rooms = Array.from({ length: 10 }, (_, i) =>
      makeProductionRoom({ roomName: `W${i}N1`, product: "OH" as ResourceConstant })
    );
    drawHubVisualPanel(rv, model, rooms);

    const roomNameTexts = findText(t => /^W\dN1\s/.test(t));
    expect(roomNameTexts).toHaveLength(6);
  });

  it("renders progress bar for each room with correct percent", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    const rooms = [
      makeProductionRoom({ roomName: "W2N1", product: "OH", progressPercent: 0.75, currentAmount: 750, targetAmount: 1000 }),
    ];
    drawHubVisualPanel(rv, model, rooms);

    const barLabels = findText(t => t.includes("750/1K") && t.includes("75%"));
    expect(barLabels).toHaveLength(1);
  });
});
