import { SourceMapConsumer } from "source-map";

let consumer: SourceMapConsumer | null = null;
const cache: Record<string, string> = {};

function getConsumer(): SourceMapConsumer {
  if (consumer === null) {
    consumer = new SourceMapConsumer(require("main.js.map"));
  }
  return consumer;
}

function sourceMappedStackTrace(error: Error | string): string {
  const stack = error instanceof Error ? error.stack || String(error) : error;
  if (Object.prototype.hasOwnProperty.call(cache, stack)) {
    return cache[stack];
  }

  const re = /^\s+at\s+(.+?\s+)?\(?([0-z._\-\\/]+):(\d+):(\d+)\)?$/gm;
  let outStack = error.toString();
  let match: RegExpExecArray | null;

  while ((match = re.exec(stack)) !== null) {
    if (match[2] !== "main") {
      break;
    }

    const pos = getConsumer().originalPositionFor({
      column: Number.parseInt(match[4], 10),
      line: Number.parseInt(match[3], 10),
    });

    if (!pos.line) {
      break;
    }

    if (pos.name) {
      outStack += `\n    at ${pos.name} (${pos.source}:${pos.line}:${pos.column})`;
    } else if (match[1]) {
      outStack += `\n    at ${match[1]} (${pos.source}:${pos.line}:${pos.column})`;
    } else {
      outStack += `\n    at ${pos.source}:${pos.line}:${pos.column}`;
    }
  }

  cache[stack] = outStack;
  return outStack;
}

export function errorMapper(next: () => void): () => void {
  return (): void => {
    try {
      next();
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      const errorMessage = Game.rooms.sim
        ? `Simulation mode does not support source-map. Raw stack: <br>${_.escape(error.stack || String(error))}`
        : _.escape(sourceMappedStackTrace(error));

      console.log(`<text style="color:#ef9a9a">${errorMessage}</text>`);
    }
  };
}
