import { buildHubProgressSnapshot, buildHubVisualModel, collectHubProgressSnapshot, runHubProgressAnalytics, buildHubOverlayLines, renderHubProgressOverlays, drawHubVisualPanel } from "@/runtime/hubProgress";
import type { HubProgressSnapshot, HubVisualModel } from "@/runtime/hubProgress";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

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
      roomTerminalBlockers: [
        { room: "W2N1", terminalEnergy: 0, reserve: 20000, pendingNonEnergy: 0 },
      ],
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
      ...overrides,
    };
  }

  it("active production model: derives productLabel, progressPercent, progressText", () => {
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

  it("progress capped at 1 when inventory exceeds 1000", () => {
    const model = buildHubVisualModel(makeSnapshot({
      activeProduct: "XGH2O",
      hubInventory: { XGH2O: 2000 },
    }));
    expect(model.progressPercent).toBe(1);
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
    const blockers = Array.from({ length: 5 }, (_, i) => ({
      room: `W${i + 1}N1`,
      terminalEnergy: 100 * i,
      reserve: 20000,
      pendingNonEnergy: i,
    }));
    const model = buildHubVisualModel(makeSnapshot({
      roomTerminalBlockers: blockers,
    }));
    expect(model.blockerRows).toHaveLength(2);
    expect(model.blockerOverflow).toBe(3);
  });

  it("no blockers: empty rows and zero overflow", () => {
    const model = buildHubVisualModel(makeSnapshot({
      roomTerminalBlockers: [],
    }));
    expect(model.blockerRows).toHaveLength(0);
    expect(model.blockerOverflow).toBe(0);
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
      blockerRows: [],
      blockerOverflow: 0,
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

  it("logistics summary row with no blockers", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({
      logisticsCounts: { imports: 3, reclaims: 1, exports: 2 },
      blockerRows: [],
      blockerOverflow: 0,
    });
    drawHubVisualPanel(rv, model);

    const textCalls = findCalls("text");
    const logisticsSummary = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("imp 3"));
    expect(logisticsSummary).toBeDefined();
    expect(logisticsSummary!.args[0]).toContain("recl 1");
    expect(logisticsSummary!.args[0]).toContain("exp 2");

    const blockerNone = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("blockers: none"));
    expect(blockerNone).toBeDefined();
  });

  it("renders one blocker row without overflow", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({
      blockerRows: [{ room: "W3N1", terminalEnergy: 500, reserve: 20000, pendingNonEnergy: 2 }],
      blockerOverflow: 0,
    });
    drawHubVisualPanel(rv, model);

    const textCalls = findCalls("text");
    const blockerText = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("W3N1"));
    expect(blockerText).toBeDefined();
    expect(blockerText!.args[0]).toContain("term");
    expect(blockerText!.args[0]).toContain("reserve");
    expect(blockerText!.args[0]).toContain("nonE 2");
    expect(blockerText!.args[3]?.color).toBe("#ffaa00");

    const overflow = textCalls.find(c => typeof c.args[0] === "string" && /\+\d+ more/.test(c.args[0]));
    expect(overflow).toBeUndefined();
  });

  it("caps blocker rows at 2 and shows overflow count", () => {
    const rv = new RoomVisual("W1N1");
    const model = makeModel({
      blockerRows: [
        { room: "W2N1", terminalEnergy: 100, reserve: 20000, pendingNonEnergy: 0 },
        { room: "W3N1", terminalEnergy: 200, reserve: 20000, pendingNonEnergy: 1 },
      ],
      blockerOverflow: 3,
    });
    drawHubVisualPanel(rv, model);

    const textCalls = findCalls("text");
    const blocker1 = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("W2N1"));
    const blocker2 = textCalls.find(c => typeof c.args[0] === "string" && c.args[0].includes("W3N1"));
    expect(blocker1).toBeDefined();
    expect(blocker2).toBeDefined();

    const overflow = textCalls.find(c => typeof c.args[0] === "string" && c.args[0] === "+3 more");
    expect(overflow).toBeDefined();
    expect(overflow!.args[3]?.color).toBe("#888888");
  });
});
