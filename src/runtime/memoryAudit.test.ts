import { buildMemoryAuditSnapshot } from "@/runtime/memoryAudit";

describe("buildMemoryAuditSnapshot", () => {
  it("returns correct totalBytes for a known Memory-like object", () => {
    const mem = {
      cfg: { enabled: true },
      runtime: { hub: { status: "idle" } },
      data: { colonization: { W1N2: { cachedTravelPath: "xyz" } } },
    };
    const expected = JSON.stringify(mem).length;

    const result = buildMemoryAuditSnapshot(mem);

    expect(result.totalBytes).toBe(expected);
  });

  it("returns branches sorted descending by bytes", () => {
    const mem = {
      small: { a: 1 },
      big: { nested: { deep: Array.from({ length: 50 }, (_, i) => `item-${i}`) } },
    };
    const result = buildMemoryAuditSnapshot(mem);

    for (let i = 1; i < result.branches.length; i++) {
      expect(result.branches[i - 1].bytes).toBeGreaterThanOrEqual(result.branches[i].bytes);
    }
    // big branch should be larger than small
    const bigBranch = result.branches.find((b) => b.path.startsWith("big"));
    const smallBranch = result.branches.find((b) => b.path.startsWith("small"));
    expect(bigBranch!.bytes).toBeGreaterThan(smallBranch!.bytes);
  });

  it("respects topN option", () => {
    const mem: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 30; i++) {
      mem[`branch${i}`] = { value: "x".repeat(i * 10) };
    }

    const result = buildMemoryAuditSnapshot(mem, { topN: 5 });

    expect(result.top.length).toBe(5);
    expect(result.branches.length).toBe(30);
  });

  it("returns empty result for null/undefined input", () => {
    expect(buildMemoryAuditSnapshot(null)).toEqual({ totalBytes: 0, branches: [], top: [] });
    expect(buildMemoryAuditSnapshot(undefined)).toEqual({ totalBytes: 0, branches: [], top: [] });
  });

  it("does NOT mutate the input object", () => {
    const mem = {
      creeps: { Scout1: { scoutVisitedRooms: ["W1N1", "W2N2"] } },
      runtime: { hub: { distributedSynthesis: [1, 2, 3] } },
    };
    const before = JSON.stringify(mem);

    buildMemoryAuditSnapshot(mem);

    const after = JSON.stringify(mem);
    expect(after).toBe(before);
  });

  it("handles nested objects up to maxDepth and stops", () => {
    // depth 0: root keys
    // depth 1: a
    // depth 2: b
    // depth 3: c
    // depth 4: d
    // depth 5: e
    // depth 6: f — should NOT be traversed (maxDepth=6 stops at depth 6)
    const mem = {
      a: {
        b: {
          c: {
            d: {
              e: {
                f: { value: "deep" },
              },
            },
          },
        },
      },
    };

    const result = buildMemoryAuditSnapshot(mem, { maxDepth: 6 });

    // Should have branches: a, a.b, a.b.c, a.b.c.d, a.b.c.d.e — 5 branches
    // a.b.c.d.e.f should NOT appear because depth 6 >= maxDepth 6
    const paths = result.branches.map((b) => b.path);
    expect(paths).toContain("a");
    expect(paths).toContain("a.b");
    expect(paths).toContain("a.b.c");
    expect(paths).toContain("a.b.c.d");
    expect(paths).toContain("a.b.c.d.e");
    expect(paths).not.toContain("a.b.c.d.e.f");
  });

  it("handles arrays as branches with index in path", () => {
    const mem = {
      creeps: {
        Scout1: {
          scoutVisitedRooms: ["W1N1", "W2N2", "W3N3"],
        },
      },
    };

    const result = buildMemoryAuditSnapshot(mem);

    const paths = result.branches.map((b) => b.path);
    expect(paths).toContain("creeps");
    expect(paths).toContain("creeps.Scout1");
    expect(paths).toContain("creeps.Scout1.scoutVisitedRooms");
    // Array elements should use bracket notation
    expect(paths).toContain("creeps.Scout1.scoutVisitedRooms[0]");
    expect(paths).toContain("creeps.Scout1.scoutVisitedRooms[1]");
    expect(paths).toContain("creeps.Scout1.scoutVisitedRooms[2]");
  });
});
