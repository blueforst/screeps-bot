export interface MemoryAuditBranch {
  path: string;
  bytes: number;
}

export interface MemoryAuditSnapshot {
  totalBytes: number;
  branches: MemoryAuditBranch[];
  top: MemoryAuditBranch[];
}

export interface MemoryAuditOptions {
  maxDepth?: number;
  topN?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_TOP_N = 25;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.constructor === Object;
}

function measureBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function collectBranches(
  obj: unknown,
  prefix: string,
  depth: number,
  maxDepth: number,
  branches: MemoryAuditBranch[],
): void {
  if (depth > maxDepth) {
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const child = obj[i];
      const childPath = prefix === "" ? `[${i}]` : `${prefix}[${i}]`;
      const isContainer = Array.isArray(child) || isPlainObject(child);
      if (depth < maxDepth) {
        branches.push({ path: childPath, bytes: measureBytes(child) });
      }
      if (isContainer) {
        collectBranches(child, childPath, depth + 1, maxDepth, branches);
      }
    }
    return;
  }

  if (isPlainObject(obj)) {
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      const childPath = prefix === "" ? key : `${prefix}.${key}`;
      if (Array.isArray(child) || isPlainObject(child)) {
        if (depth < maxDepth) {
          branches.push({ path: childPath, bytes: measureBytes(child) });
        }
        collectBranches(child, childPath, depth + 1, maxDepth, branches);
      }
    }
  }
}

export function buildMemoryAuditSnapshot(memory: unknown, options?: MemoryAuditOptions): MemoryAuditSnapshot {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const topN = options?.topN ?? DEFAULT_TOP_N;

  if (memory == null || typeof memory !== "object") {
    return { totalBytes: 0, branches: [], top: [] };
  }

  const totalBytes = measureBytes(memory);
  const branches: MemoryAuditBranch[] = [];

  collectBranches(memory, "", 1, maxDepth, branches);

  branches.sort((a, b) => b.bytes - a.bytes);

  const top = branches.slice(0, topN);

  return { totalBytes, branches, top };
}
