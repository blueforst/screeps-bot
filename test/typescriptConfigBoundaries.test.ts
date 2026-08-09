import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import * as ts from "typescript";

const REPO_ROOT = resolve(__dirname, "..");

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function repositoryPath(value: string): string {
  return normalizePath(relative(REPO_ROOT, value));
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => REPO_ROOT,
    getNewLine: () => "\n",
  });
}

function parseConfig(fileName: string): ts.ParsedCommandLine {
  const configPath = resolve(REPO_ROOT, fileName);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(formatDiagnostics([loaded.error]));
  }

  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(formatDiagnostics(parsed.errors));
  }
  return parsed;
}

function repositoryProgramFiles(config: ts.ParsedCommandLine): string[] {
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: {
      ...config.options,
      noEmit: true,
    },
  });
  return program
    .getSourceFiles()
    .map((sourceFile) => repositoryPath(sourceFile.fileName))
    .filter((fileName) => !fileName.startsWith("../") && !fileName.includes("node_modules/"))
    .sort();
}

function listTypeScriptTests(directory: string): string[] {
  const absoluteDirectory = resolve(REPO_ROOT, directory);
  if (!existsSync(absoluteDirectory)) {
    return [];
  }

  const results: string[] = [];
  const visit = (currentDirectory: string): void => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (/\.(?:test|spec)\.tsx?$/.test(entry.name)) {
        results.push(repositoryPath(absolutePath));
      }
    }
  };
  visit(absoluteDirectory);
  return results.sort();
}

function listRuntimeJavaScriptSources(): string[] {
  const results: string[] = [];
  const visit = (currentDirectory: string): void => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (/\.[cm]?js$/.test(entry.name)) {
        results.push(absolutePath);
      }
    }
  };
  visit(resolve(REPO_ROOT, "src"));
  return results.sort();
}

function listJestTests(): string[] {
  const output = execFileSync(
    process.execPath,
    [
      resolve(REPO_ROOT, "node_modules/jest/bin/jest.js"),
      "--config",
      resolve(REPO_ROOT, "jest.config.cjs"),
      "--listTests",
      "--json",
      "--runInBand",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return (JSON.parse(output) as string[]).map(repositoryPath).sort();
}

function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const results: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      results.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      results.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      results.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

function rollupTypeScriptConfigPaths(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    "rollup.config.js",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const results: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "typescript" &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const property of node.arguments[0].properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ((ts.isIdentifier(property.name) && property.name.text === "tsconfig") ||
            (ts.isStringLiteralLike(property.name) && property.name.text === "tsconfig")) &&
          ts.isStringLiteralLike(property.initializer)
        ) {
          results.push(property.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

describe("TypeScript build/test boundaries", () => {
  test("production config contains runtime sources without tests or test ambient types", () => {
    const buildConfig = parseConfig("tsconfig.build.json");
    const buildFiles = repositoryProgramFiles(buildConfig);
    const forbiddenBuildFiles = buildFiles.filter(
      (fileName) =>
        /\.(?:test|spec)\.tsx?$/.test(fileName) ||
        /^(?:test|scripts)\//.test(fileName) ||
        /\/__tests__\//.test(fileName),
    );

    expect(buildFiles).toContain("src/main.ts");
    expect(buildFiles).toContain("src/global.d.ts");
    expect(forbiddenBuildFiles).toEqual([]);
    expect(buildConfig.options.types).toEqual(["screeps", "node", "lodash"]);
    expect(buildConfig.options.paths).toEqual({
      "@/*": ["./src/*"],
    });
  });

  test("workspace config covers every TypeScript Jest source including monitor service", () => {
    const workspaceConfig = parseConfig("tsconfig.json");
    const workspaceFiles = new Set(repositoryProgramFiles(workspaceConfig));
    const discoveredTests = ["src", "test", "scripts"].flatMap(listTypeScriptTests);
    const jestTests = new Set(listJestTests());

    expect(workspaceFiles).toContain("scripts/monitor-service.test.ts");
    expect(discoveredTests.length).toBeGreaterThanOrEqual(130);
    for (const testFile of discoveredTests) {
      expect(workspaceFiles).toContain(testFile);
      expect(jestTests).toContain(testFile);
    }
    for (const jestTest of jestTests) {
      if (/\.tsx?$/.test(jestTest)) {
        expect(workspaceFiles).toContain(jestTest);
      }
    }
    expect(workspaceConfig.options.types).toEqual(["screeps", "node", "jest", "lodash"]);
    expect(workspaceConfig.options.paths).toEqual({
      "@/*": ["./src/*"],
      "@mock/*": ["./test/mock/*"],
    });
  });

  test("runtime TypeScript and legacy JavaScript cannot import test or script modules", () => {
    const buildConfig = parseConfig("tsconfig.build.json");
    const program = ts.createProgram({
      rootNames: buildConfig.fileNames,
      options: { ...buildConfig.options, noEmit: true },
    });
    const violations: string[] = [];

    for (const sourceFile of program.getSourceFiles()) {
      const fileName = repositoryPath(sourceFile.fileName);
      if (!fileName.startsWith("src/") || sourceFile.isDeclarationFile) {
        continue;
      }
      for (const specifier of moduleSpecifiers(sourceFile)) {
        if (
          specifier.startsWith("@mock/") ||
          /(?:^|\/)(?:test|__tests__|scripts)(?:\/|$)/.test(specifier) ||
          /\.(?:test|spec)(?:\.[cm]?[jt]sx?)?$/.test(specifier)
        ) {
          violations.push(`${fileName} -> ${specifier}`);
        }
      }
    }

    for (const absolutePath of listRuntimeJavaScriptSources()) {
      const fileName = repositoryPath(absolutePath);
      const sourceFile = ts.createSourceFile(
        absolutePath,
        readFileSync(absolutePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      for (const specifier of moduleSpecifiers(sourceFile)) {
        if (
          specifier.startsWith("@mock/") ||
          /(?:^|\/)(?:test|__tests__|scripts)(?:\/|$)/.test(specifier) ||
          /\.(?:test|spec)(?:\.[cm]?[jt]sx?)?$/.test(specifier)
        ) {
          violations.push(`${fileName} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("Rollup and package scripts use the explicit production boundary", () => {
    const rollupConfig = readFileSync(resolve(REPO_ROOT, "rollup.config.js"), "utf8");
    const packageJson = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(rollupTypeScriptConfigPaths(rollupConfig)).toEqual(["./tsconfig.build.json"]);
    expect(packageJson.scripts?.["typecheck:build"]).toBe(
      "tsc -p tsconfig.build.json --noEmit",
    );
    expect(packageJson.scripts?.["typecheck:test"]).toBe("tsc -p tsconfig.json --noEmit");
    expect(packageJson.scripts?.typecheck).toBe(
      "npm run typecheck:build && npm run typecheck:test",
    );
  });
});
