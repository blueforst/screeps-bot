import clear from "rollup-plugin-clear";
import screeps from "rollup-plugin-screeps";
import copy from "rollup-plugin-copy";
import typescript from "rollup-plugin-typescript2";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import replace from "@rollup/plugin-replace";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const packageJson = require("./package.json");
const screepsPluginRequire = createRequire(require.resolve("rollup-plugin-screeps/package.json"));
const { ScreepsAPI } = screepsPluginRequire("screeps-api");

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

function createAwaitedScreepsPlugin(deployConfig) {
  // rollup-plugin-screeps@1.0.1 does not return its upload Promise from
  // writeBundle. Keep its source-map handling, but perform and await the
  // upload here so `npm run push` cannot report success before the API does.
  const sourceMapPlugin = screeps({ config: deployConfig, dryRun: true });
  return {
    ...sourceMapPlugin,
    async writeBundle(options, bundle) {
      await sourceMapPlugin.writeBundle.call(this, options, bundle);
      if (!deployConfig) {
        return;
      }

      const outputDirectory = path.dirname(options.file);
      const modules = {};
      for (const file of readdirSync(outputDirectory)) {
        const absolutePath = path.join(outputDirectory, file);
        // Keep source maps locally, but do not count the generated map module
        // against Screeps' 5 MB code upload limit.
        if (file.endsWith(".map.js")) {
          continue;
        }
        if (file.endsWith(".js")) {
          modules[file.replace(/\.js$/i, "")] = readFileSync(absolutePath, "utf8");
        } else if (file.endsWith(".wasm")) {
          modules[file] = { binary: readFileSync(absolutePath).toString("base64") };
        }
      }

      if (Object.keys(modules).length === 0) {
        throw new Error("Screeps upload failed: no runtime modules were generated");
      }
      const api = new ScreepsAPI(deployConfig);
      if (!deployConfig.token) {
        await api.auth();
      }
      const configuredBranch = deployConfig.branch === "auto"
        ? run("git branch --show-current", "default")
        : deployConfig.branch;
      const branch = configuredBranch || "default";
      const branches = await api.raw.user.branches();
      const response = branches.list.some((entry) => entry.branch === branch)
        ? await api.code.set(branch, modules)
        : await api.raw.user.cloneBranch("", branch, modules);
      if (response?.ok !== 1) {
        throw new Error(`Screeps upload failed: ${JSON.stringify(response)}`);
      }
      console.log(
        `Uploaded ${Object.keys(modules).length} module(s) to Screeps branch ${branch}.`,
      );
    },
  };
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
    : createAwaitedScreepsPlugin(config);

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
    typescript({ tsconfig: "./tsconfig.json" }),
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
    deployPlugin,
  ],
};
