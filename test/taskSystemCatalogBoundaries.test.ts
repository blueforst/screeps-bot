import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript";

const REPO_ROOT = resolve(__dirname, "..");
const BUILD_CONFIG_PATH = resolve(REPO_ROOT, "tsconfig.build.json");
const MODEL_PATH = "src/runtime/taskSystem/model.ts";
const CATALOG_PATH = "src/runtime/taskSystem/catalog.ts";
const SCREEPS_POSITIVE_CONTROL_PATH = "src/config/spawnProfiles.ts";

const EXPECTED_SYSTEMS = [
  "worker-work",
  "carrier-logistics",
  "power-creep-action",
  "resource-transfer",
  "factory-command",
  "remote-mining-workflow",
  "colonization-workflow",
  "rescue-workflow",
  "flag-hauling-workflow",
  "cross-shard-colonization-workflow",
  "war-workflow",
  "power-bank-workflow",
  "spawn-production",
] as const;

const EXPECTED_ENTRY_FIELDS = [
  "claim",
  "domainOwner",
  "durability",
  "model",
  "reconcile",
  "scope",
];
const FORBIDDEN_ADAPTER_METHODS = new Set([
  "execute",
  "assign",
  "claim",
  "cancel",
  "complete",
  "delete",
  "transition",
  "upsert",
]);

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

function parseBuildConfig(): ts.ParsedCommandLine {
  const loaded = ts.readConfigFile(BUILD_CONFIG_PATH, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(formatDiagnostics([loaded.error]));
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(BUILD_CONFIG_PATH),
    { noEmit: true },
    BUILD_CONFIG_PATH,
  );
  if (parsed.errors.length > 0) {
    throw new Error(formatDiagnostics(parsed.errors));
  }
  return parsed;
}

const buildConfig = parseBuildConfig();
const productionProgram = ts.createProgram({
  rootNames: buildConfig.fileNames,
  options: buildConfig.options,
});
const typeChecker = productionProgram.getTypeChecker();

function productionSourceFile(fileName: string): ts.SourceFile {
  const absolutePath = normalizePath(resolve(REPO_ROOT, fileName));
  const sourceFile = productionProgram.getSourceFiles().find(
    (candidate) => normalizePath(resolve(candidate.fileName)) === absolutePath,
  );
  if (!sourceFile || sourceFile.isDeclarationFile) {
    throw new Error(`${fileName} is not a production source file in tsconfig.build.json`);
  }
  return sourceFile;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function unwrapFreeze(expression: ts.Expression): ts.Expression {
  const unwrapped = unwrapExpression(expression);
  if (
    ts.isCallExpression(unwrapped) &&
    unwrapped.arguments.length === 1 &&
    ts.isPropertyAccessExpression(unwrapped.expression) &&
    ts.isIdentifier(unwrapped.expression.expression) &&
    unwrapped.expression.expression.text === "Object" &&
    unwrapped.expression.name.text === "freeze"
  ) {
    return unwrapExpression(unwrapped.arguments[0]);
  }
  return unwrapped;
}

function exportedConstObject(sourceFile: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        const initializer = unwrapFreeze(declaration.initializer);
        if (ts.isObjectLiteralExpression(initializer)) {
          return initializer;
        }
      }
    }
  }
  throw new Error(`${repositoryPath(sourceFile.fileName)} must export const ${name} as an object literal`);
}

function staticPropertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error(`computed property is forbidden: ${name.getText()}`);
}

interface ImportRecord {
  readonly moduleName: string;
  readonly typeOnly: boolean;
}

function importsOf(sourceFile: ts.SourceFile): ImportRecord[] {
  const imports: ImportRecord[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      imports.push({
        moduleName: statement.moduleSpecifier.text,
        typeOnly: statement.importClause?.isTypeOnly === true,
      });
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier)
    ) {
      imports.push({ moduleName: statement.getText(), typeOnly: false });
    }
  }
  return imports;
}

function resolvedSymbol(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? typeChecker.getAliasedSymbol(symbol)
    : symbol;
}

function symbolDeclarationPaths(symbol: ts.Symbol | undefined): string[] {
  return (resolvedSymbol(symbol)?.declarations ?? []).map((declaration) =>
    repositoryPath(declaration.getSourceFile().fileName));
}

function screepsAmbientIdentifiers(sourceFile: ts.SourceFile): string[] {
  const matches = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      symbolDeclarationPaths(typeChecker.getSymbolAtLocation(node)).some(
        (path) => path.startsWith("node_modules/@types/screeps/"),
      )
    ) {
      matches.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...matches].sort();
}

function forbiddenGlobalIdentifiers(sourceFile: ts.SourceFile): string[] {
  const forbidden = new Set(["Game", "Memory", "RawMemory", "global", "globalThis"]);
  const matches: string[] = [];
  const visit = (node: ts.Node): void => {
    const isStaticPropertyName =
      ts.isIdentifier(node) &&
      ((ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
        (ts.isPropertySignature(node.parent) && node.parent.name === node) ||
        (ts.isMethodSignature(node.parent) && node.parent.name === node));
    if (ts.isIdentifier(node) && forbidden.has(node.text) && !isStaticPropertyName) {
      matches.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches.sort();
}

function exportedInterface(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === name &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true,
  );
  if (!declaration) {
    throw new Error(`${repositoryPath(sourceFile.fileName)} must export interface ${name}`);
  }
  return declaration;
}

describe("task system core and catalog architecture boundaries", () => {
  test("catalog has exact static systems and capability-only fields", () => {
    const catalogObject = exportedConstObject(productionSourceFile(CATALOG_PATH), "TASK_SYSTEM_CATALOG");
    const systems = catalogObject.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error("TASK_SYSTEM_CATALOG accepts only explicit property assignments");
      }
      const entry = unwrapFreeze(property.initializer);
      if (!ts.isObjectLiteralExpression(entry)) {
        throw new Error(`${staticPropertyName(property.name)} must use a static metadata object`);
      }
      expect(entry.properties.map((field) => {
        if (!ts.isPropertyAssignment(field)) {
          throw new Error("catalog metadata accepts only explicit property assignments");
        }
        return staticPropertyName(field.name);
      }).sort()).toEqual(EXPECTED_ENTRY_FIELDS);
      return staticPropertyName(property.name);
    });

    expect(systems.sort()).toEqual([...EXPECTED_SYSTEMS].sort());
    expect(new Set(systems).size).toBe(EXPECTED_SYSTEMS.length);
  });

  test("model and catalog remain pure production modules without domain or Screeps dependencies", () => {
    const model = productionSourceFile(MODEL_PATH);
    const catalog = productionSourceFile(CATALOG_PATH);
    expect(importsOf(catalog)).toEqual([]);
    expect(importsOf(model)).toEqual([
      { moduleName: "@/runtime/taskSystem/catalog", typeOnly: true },
    ]);

    for (const sourceFile of [model, catalog]) {
      expect(forbiddenGlobalIdentifiers(sourceFile)).toEqual([]);
      expect(screepsAmbientIdentifiers(sourceFile)).toEqual([]);
    }
    expect(screepsAmbientIdentifiers(productionSourceFile(SCREEPS_POSITIVE_CONTROL_PATH))).toEqual(
      expect.arrayContaining(["CARRY", "MOVE", "WORK"]),
    );
  });

  test("WorkRef includes namespace and WorkScope is a structured discriminated union", () => {
    const model = productionSourceFile(MODEL_PATH);
    const workRef = exportedInterface(model, "WorkRef");
    expect(workRef.members.map((member) => {
      if (!member.name) throw new Error("WorkRef member must be named");
      return staticPropertyName(member.name);
    }).sort()).toEqual(["localId", "namespace", "scope", "system"]);

    const workScope = model.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === "WorkScope",
    );
    expect(workScope).toBeDefined();
    expect(workScope && ts.isUnionTypeNode(workScope.type)).toBe(true);
    if (workScope && ts.isUnionTypeNode(workScope.type)) {
      expect(workScope.type.types).toHaveLength(6);
      for (const member of workScope.type.types) {
        expect(ts.isTypeLiteralNode(member)).toBe(true);
      }
    }
  });

  test("adapter and result public contracts expose only read capability", () => {
    const model = productionSourceFile(MODEL_PATH);
    const adapter = exportedInterface(model, "TaskSystemAdapter");
    const adapterNames = adapter.members.map((member) => {
      if (!member.name) throw new Error("TaskSystemAdapter member must be named");
      return staticPropertyName(member.name);
    });
    expect(adapterNames.sort()).toEqual(["snapshot", "system"]);
    expect(adapterNames.filter((name) => FORBIDDEN_ADAPTER_METHODS.has(name))).toEqual([]);

    const result = exportedInterface(model, "TaskSystemAdapterResult");
    expect(result.members.map((member) => {
      if (!member.name) throw new Error("TaskSystemAdapterResult member must be named");
      return staticPropertyName(member.name);
    }).sort()).toEqual(["entries", "invalidCount", "issues"]);
  });
});
