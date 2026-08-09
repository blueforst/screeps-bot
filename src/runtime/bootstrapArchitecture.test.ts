import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

const BOOTSTRAP_PATH = resolve(__dirname, "bootstrap.ts");
const bootstrapSource = readFileSync(BOOTSTRAP_PATH, "utf8");
const bootstrapAst = ts.createSourceFile(
  BOOTSTRAP_PATH,
  bootstrapSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const MEMORY_CLEANUP_PATH = resolve(__dirname, "memoryCleanup.ts");
const memoryCleanupSource = readFileSync(MEMORY_CLEANUP_PATH, "utf8");
const memoryCleanupAst = ts.createSourceFile(
  MEMORY_CLEANUP_PATH,
  memoryCleanupSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const RUNTIME_SERVICES_PATH = resolve(__dirname, "runtimeServices.ts");
const runtimeServicesSource = readFileSync(RUNTIME_SERVICES_PATH, "utf8");
const runtimeServicesAst = ts.createSourceFile(
  RUNTIME_SERVICES_PATH,
  runtimeServicesSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function containsCall(node: ts.Node, calleeName: string): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === calleeName
  ) {
    return true;
  }

  let found = false;
  ts.forEachChild(node, (child) => {
    found ||= containsCall(child, calleeName);
  });
  return found;
}

function countCalls(root: ts.Node, calleeName: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === calleeName
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return count;
}

function importsModule(root: ts.SourceFile, moduleName: string): boolean {
  return root.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName,
  );
}

function collectDirectWorkforceInterpretationViolations(): string[] {
  const violations = new Set<string>();

  for (const statement of bootstrapAst.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }

    const moduleName = statement.moduleSpecifier.text;
    if (moduleName === "@/runtime/sourceLink") {
      violations.add("import:sourceLink");
    }
    if (moduleName === "@/runtime/roomReserve") {
      violations.add("import:roomReserve");
    }
    if (moduleName === "@/runtime/roomWorkforce") {
      const namedBindings = statement.importClause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if (element.propertyName?.text === "getEligibleMineralIds" || element.name.text === "getEligibleMineralIds") {
            violations.add("import:getEligibleMineralIds");
          }
        }
      }
    }
  }

  const forbiddenCalls = new Set([
    "hasSourceAdjacentLink",
    "getEligibleMineralIds",
    "isRoomInReserveMode",
  ]);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      forbiddenCalls.has(node.expression.text)
    ) {
      violations.add(`call:${node.expression.text}`);
    }

    if (ts.isIfStatement(node) && containsCall(node.thenStatement, "upsertConfig")) {
      const condition = node.expression.getText(bootstrapAst);
      if (condition.includes(".startsWith") && condition.includes(":carrier:")) {
        violations.add("payload-prefix:carrier");
      }
      if (condition.includes(".startsWith") && condition.includes(":worker:")) {
        violations.add("payload-prefix:worker");
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(bootstrapAst);

  return [...violations].sort();
}

describe("bootstrap typed workforce architecture", () => {
  it("consumes workforce decisions without directly reinterpreting room policy or prefix payloads", () => {
    expect(collectDirectWorkforceInterpretationViolations()).toEqual([]);
  });

  it("builds one inventory in bootstrap while cleanup keeps the independent compatibility projection", () => {
    expect(countCalls(bootstrapAst, "buildRoomWorkforceInventory")).toBe(1);
    expect(importsModule(memoryCleanupAst, "@/runtime/roomWorkforce")).toBe(true);
    expect(countCalls(memoryCleanupAst, "getExpectedManagedConfigNames")).toBe(1);
  });

  it("does not move workforce inventory ownership into runtime services", () => {
    expect(importsModule(runtimeServicesAst, "@/runtime/roomWorkforce")).toBe(false);
    expect(runtimeServicesSource).not.toContain("RoomWorkforceInventory");
    expect(runtimeServicesSource).not.toContain("buildRoomWorkforceInventory");
  });
});
