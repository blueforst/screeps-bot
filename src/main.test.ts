import { readFileSync } from "fs";
import { resolve } from "path";
import { addNumbers } from "./main";

it("adds two numbers", () => {
  expect(addNumbers(1, 2)).toBe(3);
});

it("has screeps-like globals in test env", () => {
  expect(Game).toBeDefined();
  expect(Memory).toMatchObject({ creeps: {}, rooms: {} });
  expect(_).toBeDefined();
});

describe("main loop phase ordering", () => {
  const mainSrc = readFileSync(resolve(__dirname, "main.ts"), "utf-8");

  /** Extract the label from each cpuProfiler.measure("label", ...) call in order. */
  function extractMeasureOrder(src: string): string[] {
    const re = /cpuProfiler\.measure\(\s*"([^"]+)"/g;
    const order: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      order.push(m[1]);
    }
    return order;
  }

  it("factoryControl is after synthesisControl and before resourceControl", () => {
    const order = extractMeasureOrder(mainSrc);
    const factoryIdx = order.indexOf("factoryControl");
    const synthIdx = order.indexOf("synthesisControl");
    const resourceIdx = order.indexOf("resourceControl");

    expect(factoryIdx).toBeGreaterThan(-1);
    expect(synthIdx).toBeGreaterThan(-1);
    expect(resourceIdx).toBeGreaterThan(-1);

    // Regression: factoryControl must come after synthesisControl
    expect(factoryIdx).toBeGreaterThan(synthIdx);
    // Regression: factoryControl must come before resourceControl
    expect(factoryIdx).toBeLessThan(resourceIdx);
  });

  it("preserves hubPlanner before synthesisControl ordering", () => {
    const order = extractMeasureOrder(mainSrc);
    const hubIdx = order.indexOf("hubPlanner");
    const synthIdx = order.indexOf("synthesisControl");

    expect(hubIdx).toBeGreaterThan(-1);
    expect(synthIdx).toBeGreaterThan(-1);
    expect(hubIdx).toBeLessThan(synthIdx);
  });

  it("runs hubUpgradeControl after hubPlanner and before synthesisControl", () => {
    const order = extractMeasureOrder(mainSrc);
    const hubPlannerIdx = order.indexOf("hubPlanner");
    const hubUpgradeIdx = order.indexOf("hubUpgradeControl");
    const synthesisIdx = order.indexOf("synthesisControl");

    expect(hubUpgradeIdx).toBeGreaterThan(hubPlannerIdx);
    expect(hubUpgradeIdx).toBeLessThan(synthesisIdx);
  });

  it("remoteMining is after bootstrapRooms and before scheduleSpawnTasks", () => {
    const order = extractMeasureOrder(mainSrc);
    const bootstrapIdx = order.indexOf("bootstrapRooms");
    const remoteMiningIdx = order.indexOf("remoteMining");
    const scheduleIdx = order.indexOf("scheduleSpawnTasks");

    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(remoteMiningIdx).toBeGreaterThan(-1);
    expect(scheduleIdx).toBeGreaterThan(-1);

    // Regression: remoteMining must come after bootstrapRooms
    expect(remoteMiningIdx).toBeGreaterThan(bootstrapIdx);
    // Regression: remoteMining must come before scheduleSpawnTasks
    expect(remoteMiningIdx).toBeLessThan(scheduleIdx);
  });
});

describe("spawn/creep inner wrapper regression", () => {
  const mainSrc = readFileSync(resolve(__dirname, "main.ts"), "utf-8");

  it("spawnWork wraps each spawn.work() with measureRoomPhase", () => {
    expect(mainSrc).toMatch(
      /cpuProfiler\.measure\("spawnWork"[^)]*\)[\s\S]*?cpuProfiler\.measureRoomPhase\(\s*"spawnWork"\s*,\s*spawn\.room\.name\s*,\s*\(\)\s*=>\s*spawn\.work\(\)\s*\)/,
    );
  });

  it("creepWork wraps each creep.work() with measureCreep", () => {
    expect(mainSrc).toMatch(
      /cpuProfiler\.measure\("creepWork"[^)]*\)[\s\S]*?cpuProfiler\.measureCreep\(\s*creep\s*,\s*\(\)\s*=>\s*creep\.work\(\)\s*\)/,
    );
  });

  it("inner wrappers appear after scheduleSpawnTasks outer measure", () => {
    const scheduleIdx = mainSrc.indexOf('cpuProfiler.measure("scheduleSpawnTasks"');
    const spawnWorkIdx = mainSrc.indexOf('cpuProfiler.measure("spawnWork"');
    const creepWorkIdx = mainSrc.indexOf('cpuProfiler.measure("creepWork"');

    expect(scheduleIdx).toBeGreaterThan(-1);
    expect(spawnWorkIdx).toBeGreaterThan(-1);
    expect(creepWorkIdx).toBeGreaterThan(-1);
    expect(spawnWorkIdx).toBeGreaterThan(scheduleIdx);
    expect(creepWorkIdx).toBeGreaterThan(spawnWorkIdx);
  });
});
