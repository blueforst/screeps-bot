import { buildHubProgressSnapshot, buildHubVisualModel, collectHubProgressSnapshot, collectCarrierCargoInventory, runHubProgressAnalytics, buildHubOverlayLines, renderHubProgressOverlays, drawHubVisualPanel } from "@/runtime/hubProgress";
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
      t3ReserveStatus: { hubSurplus: 0, totalDeficit: [] },
      ...overrides,
    };
  }

  it("returns [] when snapshot.enabled is false", () => {
    const lines = buildHubOverlayLines(makeSnapshot({ enabled: false }));
    expect(lines).toEqual([]);
  });

  it("first line is progress: ...", () => {
    const lines = buildHubOverlayLines(makeSnapshot({
      pendingTasks: [
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 4000, reason: "hub:import:U" },
        { resource: "K", from: "W2N1", to: "W1N1", remaining: 2000, reason: "hub:import:K" },
      ],
    }));
    expect(lines[0]).toBe("progress: XGH2O 0/1000");
    expect(lines[1]).toBe("tasks: 2");
  });

  it("subsequent lines are per-room breakdowns", () => {
    const lines = buildHubOverlayLines(makeSnapshot({
      pendingTasks: [
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 4000, reason: "hub:import:U" },
        { resource: "K", from: "W2N1", to: "W1N1", remaining: 2000, reason: "hub:import:K" },
      ],
    }));
    expect(lines[2]).toBe("W2N1: 2 tasks, 6K");
  });

  it("shows only progress and tasks: 0 when no pending tasks", () => {
    const lines = buildHubOverlayLines(makeSnapshot({ pendingTasks: [] }));
    expect(lines).toEqual(["progress: XGH2O 0/1000", "tasks: 0"]);
  });

  it("caps at 8 lines", () => {
    const tasks = Array.from({ length: 15 }, (_, i) => ({
      resource: `res${i}` as string,
      from: `W${i}N1`,
      to: "W1N1",
      remaining: 1000,
      reason: `hub:import:res${i}`,
    }));
    const lines = buildHubOverlayLines(makeSnapshot({ pendingTasks: tasks }));
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

  it("hub room never gets satellite panel even when misflagged as isHubRoom false", () => {
    (global as any).__resetRoomVisualCalls();

    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.rooms = {
      E4N58: { name: "E4N58", controller: { my: true } } as any,
      W2N1: { name: "W2N1", controller: { my: true } } as any,
    };

    Memory.cfg!.hub!.hubRoomName = "E4N58";
    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: [
        { roomName: "E4N58", product: "XGH2O" as ResourceConstant, targetAmount: 3000, isHubRoom: false },
        { roomName: "E4N58", product: "XUHO2" as ResourceConstant, targetAmount: 3000, isHubRoom: false },
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
    const hubSatelliteHeaders = calls.filter(
      c => c.roomName === "E4N58" && c.method === "text" && String(c.args[0]).startsWith("Production:"),
    );
    expect(hubSatelliteHeaders.length).toBe(0);
    expect(calls.some(c => c.roomName === "E4N58" && c.method === "text")).toBe(true);
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
      roomTerminalBlockers: [],
      hubLabInventory: {},
      hubCarrierCargo: {},
      productionRooms: [],
      t3ReserveStatus: { hubSurplus: 0, totalDeficit: [] },
      ...overrides,
    };
  }

  it("totalTasks counts all pending tasks", () => {
    const model = buildHubVisualModel(makeSnapshot({
      pendingTasks: [
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 4000, reason: "hub:import:U" },
        { resource: "K", from: "W2N1", to: "W1N1", remaining: 2000, reason: "hub:import:K" },
        { resource: "L", from: "W3N1", to: "W1N1", remaining: 1000, reason: "hub:import:L" },
      ],
    }));
    expect(model.totalTasks).toBe(3);
  });

  it("roomBreakdown groups tasks by from room with counts and total resource amount", () => {
    const model = buildHubVisualModel(makeSnapshot({
      pendingTasks: [
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 4000, reason: "hub:import:U" },
        { resource: "K", from: "W2N1", to: "W1N1", remaining: 2000, reason: "hub:import:K" },
        { resource: "U", from: "W2N1", to: "W1N1", remaining: 1000, reason: "hub:import:U" },
      ],
    }));
    expect(model.roomBreakdown).toHaveLength(1);
    expect(model.roomBreakdown[0]).toEqual({ room: "W2N1", taskCount: 3, resourceAmount: 7000 });
    expect(model.activeProduct).toBe("XGH2O");
    expect(model.progressPercent).toBe(0);
    expect(model.progressText).toBe("XGH2O 0/1000");
  });

  it("roomBreakdown sorted by taskCount desc then room name asc", () => {
    const model = buildHubVisualModel(makeSnapshot({
      pendingTasks: [
        { resource: "U", from: "W3N1", to: "W1N1", remaining: 1000, reason: "hub:import:U" },
        { resource: "K", from: "W2N1", to: "W1N1", remaining: 2000, reason: "hub:import:K" },
        { resource: "L", from: "W2N1", to: "W1N1", remaining: 3000, reason: "hub:import:L" },
      ],
    }));
    expect(model.roomBreakdown).toHaveLength(2);
    // W2N1 has 2 tasks, W3N1 has 1 task → W2N1 first
    expect(model.roomBreakdown[0].room).toBe("W2N1");
    expect(model.roomBreakdown[0].taskCount).toBe(2);
    expect(model.roomBreakdown[1].room).toBe("W3N1");
    expect(model.roomBreakdown[1].taskCount).toBe(1);
  });

  it("tie-breaking: sorted by room name ascending when taskCount equal", () => {
    const model = buildHubVisualModel(makeSnapshot({
      pendingTasks: [
        { resource: "U", from: "W3N1", to: "W1N1", remaining: 1000, reason: "hub:import:U" },
        { resource: "K", from: "W2N1", to: "W1N1", remaining: 2000, reason: "hub:import:K" },
      ],
    }));
    expect(model.roomBreakdown[0].room).toBe("W2N1");
    expect(model.roomBreakdown[1].room).toBe("W3N1");
  });

  it("empty pendingTasks → totalTasks=0, roomBreakdown=[]", () => {
    const model = buildHubVisualModel(makeSnapshot({ pendingTasks: [] }));
    expect(model.totalTasks).toBe(0);
    expect(model.roomBreakdown).toEqual([]);
  });

  it("disabled snapshot still returns model", () => {
    const model = buildHubVisualModel(makeSnapshot({
      enabled: false,
      pendingTasks: [],
    }));
    expect(model.totalTasks).toBe(0);
    expect(model.roomBreakdown).toEqual([]);
  });
});

describe("drawHubVisualPanel", () => {
  function makeModel(overrides: Partial<HubVisualModel> = {}): HubVisualModel {
    return {
      totalTasks: 3,
      roomBreakdown: [
        { room: "E1N57", taskCount: 2, resourceAmount: 1000 },
        { room: "E2N57", taskCount: 1, resourceAmount: 500 },
      ],
      activeProduct: null,
      progressPercent: 0,
      progressText: "idle",
      t3Reserve: { hubSurplus: 0, totalDeficit: [] },
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

  it("renders Progress and Logistics section headers", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel();
    drawHubVisualPanel(rv, model);

    const headerRects = findCalls("rect", args => args[4]?.fill === "#1a1a2e");
    expect(headerRects.length).toBeGreaterThanOrEqual(2);

    const progressTitle = findCalls("text", args => args[0] === "Progress");
    expect(progressTitle).toHaveLength(1);

    const logisticsTitle = findCalls("text", args => args[0] === "Logistics");
    expect(logisticsTitle).toHaveLength(1);
  });

  it("renders tasks: N text row", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({ totalTasks: 5 });
    drawHubVisualPanel(rv, model);

    const taskTexts = findCalls("text", args => args[0] === "tasks: 5");
    expect(taskTexts).toHaveLength(1);
  });

  it("renders per-room breakdown lines", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({
      totalTasks: 3,
      roomBreakdown: [
        { room: "E1N57", taskCount: 2, resourceAmount: 3000 },
        { room: "E2N57", taskCount: 1, resourceAmount: 500 },
      ],
    });
    drawHubVisualPanel(rv, model);

    const textCalls = findCalls("text");
    const room1 = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("E1N57"));
    const room2 = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("E2N57"));
    expect(room1).toBeDefined();
    expect(room1!.args[0]).toBe("E1N57: 2 tasks, 3K");
    expect(room2).toBeDefined();
    expect(room2!.args[0]).toBe("E2N57: 1 tasks, 500");
  });

  it("renders none when roomBreakdown is empty", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({ totalTasks: 0, roomBreakdown: [] });
    drawHubVisualPanel(rv, model);

    const textCalls = findCalls("text");
    const noneText = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("none"));
    expect(noneText).toBeDefined();
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

  it("returns empty t3ReserveStatus when hub is disabled", () => {
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

    expect(snapshot.t3ReserveStatus).toEqual({ hubSurplus: 0, totalDeficit: [] });
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

  it("computes hub surplus for compounds above hubReservePerCompound", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: ["XGH2O" as ResourceConstant, "XUHO2" as ResourceConstant],
        hubReservePerCompound: 2000,
      },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: { XGH2O: 5000, XUHO2: 3000 },
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 300,
    });

    expect(snapshot.t3ReserveStatus.hubSurplus).toBe(4000);
  });

  it("computes total deficit per compound across satellites", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: ["XGH2O" as ResourceConstant],
        reservePerRoom: 2000,
      },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 400,
      satelliteStores: [
        { roomName: "W2N1", storage: { XGH2O: 500 }, terminal: { XGH2O: 200 } },
        { roomName: "W3N1", storage: { XGH2O: 2000 }, terminal: null },
      ],
    });

    expect(snapshot.t3ReserveStatus.totalDeficit).toHaveLength(1);
    expect(snapshot.t3ReserveStatus.totalDeficit[0].compound).toBe("XGH2O");
    expect(snapshot.t3ReserveStatus.totalDeficit[0].needed).toBe(1300);
  });

  it("sorts totalDeficit by needed descending", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: ["XGH2O" as ResourceConstant],
        reservePerRoom: 2000,
      },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 500,
      satelliteStores: [
        { roomName: "W2N1", storage: { XGH2O: 1500 }, terminal: null },
        { roomName: "W3N1", storage: { XGH2O: 0 }, terminal: null },
        { roomName: "W4N1", storage: { XGH2O: 1000 }, terminal: null },
      ],
    });

    // totalDeficit aggregates per compound: XGH2O = 500 + 2000 + 1000 = 3500
    expect(snapshot.t3ReserveStatus.totalDeficit).toHaveLength(1);
    expect(snapshot.t3ReserveStatus.totalDeficit[0].compound).toBe("XGH2O");
    expect(snapshot.t3ReserveStatus.totalDeficit[0].needed).toBe(3500);
  });

  it("excludes rooms with no deficit", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: ["XGH2O" as ResourceConstant],
        reservePerRoom: 2000,
      },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 600,
      satelliteStores: [
        { roomName: "W2N1", storage: { XGH2O: 3000 }, terminal: null },
        { roomName: "W3N1", storage: { XGH2O: 2000 }, terminal: null },
      ],
    });

    expect(snapshot.t3ReserveStatus.totalDeficit).toEqual([]);
  });

  it("computes multi-compound totalDeficit across satellites", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: ["XGH2O" as ResourceConstant, "XUHO2" as ResourceConstant],
        reservePerRoom: 2000,
      },
      hubRuntime: { status: "idle" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 700,
      satelliteStores: [
        { roomName: "W2N1", storage: { XGH2O: 500, XUHO2: 1800 }, terminal: null },
      ],
    });

    expect(snapshot.t3ReserveStatus.totalDeficit).toHaveLength(2);
    // sorted by needed desc: XGH2O=1500 > XUHO2=200
    expect(snapshot.t3ReserveStatus.totalDeficit[0].compound).toBe("XGH2O");
    expect(snapshot.t3ReserveStatus.totalDeficit[0].needed).toBe(1500);
    expect(snapshot.t3ReserveStatus.totalDeficit[1].compound).toBe("XUHO2");
    expect(snapshot.t3ReserveStatus.totalDeficit[1].needed).toBe(200);
  });
});

describe("drawHubVisualPanel T3 Reserve section", () => {
  function makeModel(overrides: Partial<HubVisualModel> = {}): HubVisualModel {
    return {
      totalTasks: 0,
      roomBreakdown: [],
      activeProduct: null,
      progressPercent: 0,
      progressText: "idle",
      t3Reserve: { hubSurplus: 0, totalDeficit: [] },
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

  it("renders T3 Reserve section header", () => {
    const rv = new RoomVisual("W1N1");
    drawHubVisualPanel(rv, makeModel());

    const headerTexts = findCalls("text", args => args[0] === "T3 Reserve");
    expect(headerTexts).toHaveLength(1);
  });

  it("renders hub surplus text when positive", () => {
    const rv = new RoomVisual("W1N1");
    drawHubVisualPanel(rv, makeModel({
      t3Reserve: { hubSurplus: 45000, totalDeficit: [] },
    }));

    const hubTexts = findCalls("text", args => typeof args[0] === "string" && args[0].includes("Hub:"));
    expect(hubTexts).toHaveLength(1);
    expect(hubTexts[0].args[0]).toBe("Hub: 45K surplus");
  });

  it("renders all rooms stocked when no deficits and surplus >= 0", () => {
    const rv = new RoomVisual("W1N1");
    drawHubVisualPanel(rv, makeModel({
      t3Reserve: { hubSurplus: 100, totalDeficit: [] },
    }));

    const textCalls = findCalls("text");
    const stockedText = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("all rooms stocked"));
    expect(stockedText).toBeDefined();
  });

  it("renders totalDeficit lines sorted by needed descending", () => {
    const rv = new RoomVisual("W1N1");
    drawHubVisualPanel(rv, makeModel({
      t3Reserve: {
        hubSurplus: 0,
        totalDeficit: [
          { compound: "XGH2O", needed: 3500 },
          { compound: "XUHO2", needed: 1000 },
        ],
      },
    }));

    const textCalls = findCalls("text");
    const def1 = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("XGH2O"));
    const def2 = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("XUHO2"));
    expect(def1).toBeDefined();
    expect(def1!.args[0]).toBe("XGH2O: -3.5K");
    expect(def2).toBeDefined();
    expect(def2!.args[0]).toBe("XUHO2: -1K");
  });

  it("caps totalDeficit display at 3 compounds", () => {
    const totalDeficit = Array.from({ length: 8 }, (_, i) => ({
      compound: `C${i}`,
      needed: (8 - i) * 500,
    }));
    const rv = new RoomVisual("W1N1");
    drawHubVisualPanel(rv, makeModel({
      t3Reserve: { hubSurplus: 0, totalDeficit },
    }));

    const textCalls = findCalls("text");
    const deficitLines = textCalls.filter(c => typeof c.args[0] === "string" && /^C\d+:/.test(c.args[0]));
    expect(deficitLines).toHaveLength(3);
  });
});


