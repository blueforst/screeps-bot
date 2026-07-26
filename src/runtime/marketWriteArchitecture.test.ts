import * as fs from "node:fs";
import * as path from "node:path";

const WRITE_API_PATTERN =
  /\bGame\s*(?:\.\s*market|\[\s*["']market["']\s*\])\s*(?:\.\s*(?:deal|createOrder|extendOrder|changeOrderPrice|cancelOrder)|\[\s*["'](?:deal|createOrder|extendOrder|changeOrderPrice|cancelOrder)["']\s*\])\s*\(/g;
const TERMINAL_SEND_PATTERN = /\.\s*send\s*\(/g;

function collectProductionSources(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "mock" || entry.name === "__mocks__") continue;
      files.push(...collectProductionSources(absolute));
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    files.push(absolute);
  }
  return files;
}

describe("market write architecture", () => {
  it("仅 marketActionArbiter 可以直接调用市场写 API 或 terminal.send", () => {
    const sourceRoot = path.resolve(__dirname, "..");
    const arbiterPath = path.join(sourceRoot, "runtime", "marketActionArbiter.ts");
    const violations: string[] = [];

    for (const file of collectProductionSources(sourceRoot)) {
      if (file === arbiterPath) continue;
      const source = fs.readFileSync(file, "utf8");
      WRITE_API_PATTERN.lastIndex = 0;
      TERMINAL_SEND_PATTERN.lastIndex = 0;
      if (
        !WRITE_API_PATTERN.test(source) &&
        !TERMINAL_SEND_PATTERN.test(source)
      ) {
        continue;
      }
      violations.push(path.relative(sourceRoot, file));
    }

    expect(violations).toEqual([]);
  });
});
