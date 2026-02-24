import clear from "rollup-plugin-clear";
import screeps from "rollup-plugin-screeps";
import copy from "rollup-plugin-copy";
import typescript from "rollup-plugin-typescript2";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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
    commonjs(),
    typescript({ tsconfig: "./tsconfig.json" }),
    deployPlugin,
  ],
};
