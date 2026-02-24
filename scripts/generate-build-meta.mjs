import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

function run(command, fallback) {
  try {
    return execSync(command, { encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version || "0.0.0";
const gitHash = run("git rev-parse --short HEAD", "nogit");
const buildTime = new Date().toISOString();
const tag = `${version}+${gitHash}@${buildTime}`;

const content = `export const BUILD_INFO = {
  version: ${JSON.stringify(version)},
  gitHash: ${JSON.stringify(gitHash)},
  buildTime: ${JSON.stringify(buildTime)},
  tag: ${JSON.stringify(tag)},
} as const;\n`;

mkdirSync("src", { recursive: true });
writeFileSync("src/buildMeta.ts", content, "utf8");
