import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as ts from "typescript";

const PROJECT_PATH = resolve(__dirname, "..", "..");
const SRC_PATH = resolve(__dirname, "..");
const TEST_PATH = resolve(PROJECT_PATH, "test");
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
const ROOM_WORKFORCE_PATH = resolve(__dirname, "roomWorkforce.ts");
const roomWorkforceSource = readFileSync(ROOM_WORKFORCE_PATH, "utf8");
const roomWorkforceAst = ts.createSourceFile(
  ROOM_WORKFORCE_PATH,
  roomWorkforceSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const ROOM_WORKFORCE_IDENTITY_PATH = resolve(__dirname, "roomWorkforceIdentity.ts");
const roomWorkforceIdentitySource = existsSync(ROOM_WORKFORCE_IDENTITY_PATH)
  ? readFileSync(ROOM_WORKFORCE_IDENTITY_PATH, "utf8")
  : "";
const roomWorkforceIdentityAst = ts.createSourceFile(
  ROOM_WORKFORCE_IDENTITY_PATH,
  roomWorkforceIdentitySource,
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

function collectModuleImports(root: ts.SourceFile, predicate: (moduleName: string) => boolean): string[] {
  const modules: string[] = [];
  for (const statement of root.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      predicate(statement.moduleSpecifier.text)
    ) {
      modules.push(statement.moduleSpecifier.text);
    }
  }
  return modules.sort();
}

function isTypeOnlyImport(statement: ts.ImportDeclaration): boolean {
  const importClause = statement.importClause;
  if (!importClause) {
    return false;
  }
  if (importClause.isTypeOnly) {
    return true;
  }

  const namedBindings = importClause.namedBindings;
  return (
    namedBindings !== undefined &&
    ts.isNamedImports(namedBindings) &&
    namedBindings.elements.length > 0 &&
    namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function collectIdentityRuntimeImports(): string[] {
  return roomWorkforceIdentityAst.statements
    .filter(ts.isImportDeclaration)
    .filter((statement) => !isTypeOnlyImport(statement))
    .map((statement) =>
      ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : statement.moduleSpecifier.getText(roomWorkforceIdentityAst),
    )
    .sort();
}

function collectIdentityForbiddenModuleImports(): string[] {
  const forbiddenRuntimeModules = new Set([
    "@/runtime/bootstrap",
    "@/runtime/memoryCleanup",
    "@/runtime/roomWorkforce",
    "@/runtime/runtimeServices",
    "@/runtime/workerTaskPool",
  ]);

  return collectModuleImports(roomWorkforceIdentityAst, (moduleName) => {
    const normalized = moduleName.toLowerCase();
    return (
      forbiddenRuntimeModules.has(moduleName) ||
      [...forbiddenRuntimeModules].some((prefix) => moduleName.startsWith(`${prefix}/`)) ||
      /(^|[/.-])(game|memory)([/.-]|$)/.test(normalized)
    );
  });
}

function collectIdentityGlobalReferences(): string[] {
  const references: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === "Game" || node.text === "Memory")) {
      const position = roomWorkforceIdentityAst.getLineAndCharacterOfPosition(node.getStart(roomWorkforceIdentityAst));
      references.push(`${node.text}@${position.line + 1}:${position.character + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(roomWorkforceIdentityAst);
  return references.sort();
}

function importsNamedBinding(
  root: ts.SourceFile,
  moduleName: string,
  importedName: string,
): boolean {
  return root.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) {
      return false;
    }

    const namedBindings = statement.importClause?.namedBindings;
    return (
      namedBindings !== undefined &&
      ts.isNamedImports(namedBindings) &&
      namedBindings.elements.some(
        (element) =>
          (element.propertyName?.text ?? element.name.text) === importedName &&
          element.name.text === importedName,
      )
    );
  });
}

function collectWorkforceIdentityPropertyViolations(): string[] {
  const identityProperties = new Set(["configName", "deprecatedConfigName"]);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const propertyName = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
        ? node.name.text
        : undefined;
      if (propertyName && identityProperties.has(propertyName)) {
        const initializer = node.initializer;
        const usesFormatter =
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === "formatRoomWorkforceConfigName";
        if (!usesFormatter) {
          const position = roomWorkforceAst.getLineAndCharacterOfPosition(node.getStart(roomWorkforceAst));
          violations.push(`${propertyName}@${position.line + 1}:${position.character + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(roomWorkforceAst);
  return violations.sort();
}

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files.sort();
}

function collectIdentifierReferences(identifierName: string): string[] {
  const references: string[] = [];
  for (const path of [
    ...collectTypeScriptFiles(SRC_PATH),
    ...collectTypeScriptFiles(TEST_PATH),
  ]) {
    if (path === resolve(__dirname, "bootstrapArchitecture.test.ts")) {
      continue;
    }

    const source = readFileSync(path, "utf8");
    const root = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === identifierName) {
        const position = root.getLineAndCharacterOfPosition(node.getStart(root));
        references.push(
          `${relative(PROJECT_PATH, path)}:${position.line + 1}:${position.character + 1}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  }
  return references.sort();
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

  it("builds one inventory in bootstrap", () => {
    expect(countCalls(bootstrapAst, "buildRoomWorkforceInventory")).toBe(1);
  });

  it("keeps memory cleanup independent from the room workforce module", () => {
    expect(
      collectModuleImports(
        memoryCleanupAst,
        (moduleName) => moduleName === "roomWorkforce" || moduleName.endsWith("/roomWorkforce"),
      ),
    ).toEqual([]);
  });

  it("does not project expected managed config names during memory cleanup", () => {
    expect(countCalls(memoryCleanupAst, "getExpectedManagedConfigNames")).toBe(0);
  });

  it("provides a pure room workforce identity module", () => {
    expect(existsSync(ROOM_WORKFORCE_IDENTITY_PATH)).toBe(true);
  });

  it("keeps room workforce identity free of runtime dependencies and global state", () => {
    expect(collectIdentityRuntimeImports()).toEqual([]);
    expect(collectIdentityForbiddenModuleImports()).toEqual([]);
    expect(collectIdentityGlobalReferences()).toEqual([]);
  });

  it("imports the shared workforce identity formatter", () => {
    expect(
      importsNamedBinding(
        roomWorkforceAst,
        "@/runtime/roomWorkforceIdentity",
        "formatRoomWorkforceConfigName",
      ),
    ).toBe(true);
  });

  it("formats every inventory identity through the shared formatter", () => {
    expect(collectWorkforceIdentityPropertyViolations()).toEqual([]);
  });

  it("removes the cross-phase compatibility projection from production and tests", () => {
    expect(collectIdentifierReferences("getExpectedManagedConfigNames")).toEqual([]);
  });

  it("does not move workforce inventory ownership into runtime services", () => {
    expect(importsModule(runtimeServicesAst, "@/runtime/roomWorkforce")).toBe(false);
    expect(runtimeServicesSource).not.toContain("RoomWorkforceInventory");
    expect(runtimeServicesSource).not.toContain("buildRoomWorkforceInventory");
  });
});
