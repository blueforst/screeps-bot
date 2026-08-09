import { readFileSync } from "fs";
import { resolve } from "path";
import { addNumbers } from "./main";

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

  it("runs the market safety preflight before production and final planning after ResourceControl", () => {
    const order = extractMeasureOrder(mainSrc);
    const announceIdx = order.indexOf("announceDeploy");
    const preflightIdx = order.indexOf("marketSalePreflight");
    const hubIdx = order.indexOf("hubPlanner");
    const synthesisIdx = order.indexOf("synthesisControl");
    const factoryIdx = order.indexOf("factoryControl");
    const resourceIdx = order.indexOf("resourceControl");
    const marketIdx = order.indexOf("marketSaleAutomation");

    expect(preflightIdx).toBeGreaterThan(announceIdx);
    expect(preflightIdx).toBeLessThan(hubIdx);
    expect(preflightIdx).toBeLessThan(synthesisIdx);
    expect(preflightIdx).toBeLessThan(factoryIdx);
    expect(marketIdx).toBeGreaterThan(resourceIdx);
  });

  it("keeps the Pixel phase while the module owns the permanent disabled latch", () => {
    const pixelSrc = readFileSync(
      resolve(__dirname, "runtime/pixelGenerator.ts"),
      "utf-8",
    );
    expect(mainSrc).toContain(
      'cpuProfiler.measure("pixelGenerator", runPixelGenerator)',
    );
    expect(pixelSrc).toContain(
      "PIXEL_GENERATOR_PERMANENTLY_DISABLED = true",
    );
    expect(pixelSrc).not.toContain("Game.cpu.generatePixel(");
  });
});

describe("spawn/creep inner wrapper regression", () => {
  const mainSrc = readFileSync(resolve(__dirname, "main.ts"), "utf-8");

  it("spawnWork wraps each spawn.work() with measureRoomPhase", () => {
    expect(mainSrc).toMatch(
      /cpuProfiler\.measure\("spawnWork"[^)]*\)[\s\S]*?cpuProfiler\.measureRoomPhase\(\s*"spawnWork"\s*,\s*spawn\.room\.name\s*,\s*\(\)\s*=>\s*spawn\.work\(\)\s*\)/,
    );
  });
});
