import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as ts from "typescript";

const SRC_ROOT = resolve(__dirname, "..");
const GATEWAY_PATH = resolve(__dirname, "linkNetworkMemory.ts");

function collectProductionSourceFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectProductionSourceFiles(absolutePath));
      continue;
    }

    if (
      !entry.isFile() ||
      (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) ||
      entry.name.endsWith(".d.ts") ||
      /\.(?:test|spec)\.[jt]s$/.test(entry.name)
    ) {
      continue;
    }

    files.push(absolutePath);
  }

  return files.sort();
}

function staticPropertyName(node: ts.PropertyName | ts.Expression | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }

  return undefined;
}

function isLinkNetworkPropertyReference(node: ts.Node): boolean {
  if (
    (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
    node.text === "linkNetwork"
  ) {
    return true;
  }

  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "linkNetwork";
  }

  if (ts.isElementAccessExpression(node)) {
    return staticPropertyName(node.argumentExpression) === "linkNetwork";
  }

  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const propertyName = node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined);
    return staticPropertyName(propertyName) === "linkNetwork";
  }

  return false;
}

function collectLinkNetworkPropertyReferences(
  filePath: string,
  sourceText = readFileSync(filePath, "utf8"),
): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const references: string[] = [];

  const visit = (node: ts.Node): void => {
    if (isLinkNetworkPropertyReference(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      references.push(
        `${relative(SRC_ROOT, filePath)}:${position.line + 1}:${position.character + 1}`,
      );
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}

describe("linkNetwork Memory ownership", () => {
  it("detects static slot access across TypeScript and JavaScript syntax", () => {
    const fixtures = [
      ["fixture.ts", "Memory.runtime.linkNetwork = {};"],
      ["fixture.ts", "Memory.runtime['linkNetwork'] = {};"],
      ["fixture.ts", "Memory.runtime = { linkNetwork: {} };"],
      ["fixture.ts", "const { linkNetwork } = Memory.runtime;"],
      ["fixture.js", "const key = 'linkNetwork'; Memory.runtime[key] = {};"],
    ] as const;

    for (const [fileName, sourceText] of fixtures) {
      expect(collectLinkNetworkPropertyReferences(fileName, sourceText)).not.toEqual([]);
    }
    expect(
      collectLinkNetworkPropertyReferences("fixture.ts", "const linkNetworkMemory = {};"),
    ).toEqual([]);
  });

  it("allows production linkNetwork property access only inside linkNetworkMemory gateway", () => {
    const productionFiles = collectProductionSourceFiles(SRC_ROOT);
    expect(productionFiles).toContain(resolve(__dirname, "linkControl.ts"));
    expect(productionFiles).toContain(resolve(__dirname, "memoryCleanup.ts"));
    expect(productionFiles.some((filePath) => filePath.endsWith(".js"))).toBe(true);

    const violations = productionFiles
      .filter((filePath) => filePath !== GATEWAY_PATH)
      .flatMap((filePath) => collectLinkNetworkPropertyReferences(filePath))
      .sort();

    expect(violations).toEqual([]);
  });
});
