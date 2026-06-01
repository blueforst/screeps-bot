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
});
