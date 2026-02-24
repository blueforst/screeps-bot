import clear from "rollup-plugin-clear";
import screeps from "rollup-plugin-screeps";
import copy from "rollup-plugin-copy";
import typescript from "rollup-plugin-typescript2";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import replace from "@rollup/plugin-replace";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const packageJson = require("./package.json");

function run(command, fallback) {
  try {
    return execSync(command, { encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

const buildVersion = packageJson.version || "0.0.0";
const buildGitHash = run("git rev-parse --short HEAD", "nogit");
const buildTime = new Date().toISOString();
const buildTag = `${buildVersion}+${buildGitHash}@${buildTime}`;

let config;
if (!process.env.DEST) {
  console.log("No deployment target set. Build only.");
} else {
  const secret = require("./.secret.json");
  config = secret[process.env.DEST];
  if (!config) {
    throw new Error("Invalid DEST. Use DEST:main or DEST:local.");
  }
}

const deployPlugin =
  config && config.copyPath
    ? copy({
        targets: [
          {
            src: "dist/main.js",
            dest: config.copyPath,
          },
          {
            src: "dist/main.js.map",
            dest: config.copyPath,
            rename: (name) => `${name}.map.js`,
            transform: (contents) => `module.exports = ${contents.toString()};`,
          },
        ],
        hook: "writeBundle",
        verbose: true,
      })
    : screeps({ config, dryRun: !config });

export default {
  input: "src/main.ts",
  output: {
    file: "dist/main.js",
    format: "cjs",
    sourcemap: true,
  },
  plugins: [
    clear({ targets: ["dist"] }),
    resolve(),
    replace({
      preventAssignment: true,
      values: {
        __BUILD_VERSION__: JSON.stringify(buildVersion),
        __BUILD_GIT_HASH__: JSON.stringify(buildGitHash),
        __BUILD_TIME__: JSON.stringify(buildTime),
        __BUILD_TAG__: JSON.stringify(buildTag),
      },
    }),
    commonjs(),
    typescript({ tsconfig: "./tsconfig.json" }),
    deployPlugin,
  ],
};
