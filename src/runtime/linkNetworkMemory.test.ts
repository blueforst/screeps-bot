import {
  peekLinkRoomRuntime,
  pruneLinkNetworkRuntime,
  writeLinkRoomRuntime,
  type LinkRoomRuntimeView,
} from "@/runtime/linkNetworkMemory";

function assertLinkRoomRuntimeViewIsDeepReadonly(view: LinkRoomRuntimeView): void {
  // @ts-expect-error LinkNetwork readers cannot replace persisted scalar fields.
  view.updatedAt = 1;
  // @ts-expect-error LinkNetwork readers cannot mutate persisted ID arrays.
  view.senderIds.push("sender");
}

void assertLinkRoomRuntimeViewIsDeepReadonly;

type LinkRoomRuntime = NonNullable<
  NonNullable<Memory["runtime"]>["linkNetwork"]
>[string];

function createSnapshot(
  updatedAt: number,
  senderIds: string[],
  receiverIds: string[],
): LinkRoomRuntime {
  return { updatedAt, senderIds, receiverIds };
}

describe("linkNetworkMemory", () => {
  describe("peekLinkRoomRuntime", () => {
    it("does not create runtime state when Memory is empty", () => {
      Object.assign(global, { Memory: {} as Memory });

      expect(peekLinkRoomRuntime("W1N1")).toBeUndefined();
      expect(Memory).toEqual({});
      expect(Object.prototype.hasOwnProperty.call(Memory, "runtime")).toBe(false);
    });

    it("does not create linkNetwork when runtime already exists", () => {
      const runtime = {} as NonNullable<Memory["runtime"]>;
      Memory.runtime = runtime;

      expect(peekLinkRoomRuntime("W1N1")).toBeUndefined();
      expect(Memory.runtime).toBe(runtime);
      expect(Object.prototype.hasOwnProperty.call(runtime, "linkNetwork")).toBe(false);
    });

    it("does not add a room entry when linkNetwork already exists", () => {
      const linkNetwork = {} as NonNullable<
        NonNullable<Memory["runtime"]>["linkNetwork"]
      >;
      Memory.runtime = { linkNetwork };

      expect(peekLinkRoomRuntime("W1N1")).toBeUndefined();
      expect(Memory.runtime.linkNetwork).toBe(linkNetwork);
      expect(Memory.runtime.linkNetwork).toEqual({});
    });

    it("returns the persisted snapshot by reference", () => {
      const snapshot = createSnapshot(73, ["sender-b", "sender-a"], ["receiver-z"]);
      Memory.runtime = { linkNetwork: { W1N1: snapshot } };

      expect(peekLinkRoomRuntime("W1N1")).toBe(snapshot);
    });
  });

  describe("writeLinkRoomRuntime", () => {
    it("creates the missing path and stores the exact snapshot and array order", () => {
      Object.assign(global, { Memory: {} as Memory });
      delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
      const senderIds = ["sender-z", "sender-a", "sender-m"];
      const receiverIds = ["receiver-c", "receiver-b"];
      const snapshot = createSnapshot(91, senderIds, receiverIds);

      writeLinkRoomRuntime("W9N9", snapshot);

      expect(Memory.runtime?.linkNetwork?.W9N9).toBe(snapshot);
      expect(Memory.runtime?.linkNetwork?.W9N9.senderIds).toBe(senderIds);
      expect(Memory.runtime?.linkNetwork?.W9N9.receiverIds).toBe(receiverIds);
      expect(Memory.runtime?.linkNetwork?.W9N9.senderIds).toEqual([
        "sender-z",
        "sender-a",
        "sender-m",
      ]);
      expect(Memory.runtime?.linkNetwork?.W9N9.receiverIds).toEqual([
        "receiver-c",
        "receiver-b",
      ]);
      expect(Object.prototype.hasOwnProperty.call(global, "__runtimeServices")).toBe(false);
    });

    it("atomically replaces an existing room entry without changing sibling entries", () => {
      const sibling = createSnapshot(10, ["sibling-sender"], ["sibling-receiver"]);
      const previous = createSnapshot(11, ["old-sender"], ["old-receiver"]);
      const replacement = createSnapshot(12, ["new-sender-b", "new-sender-a"], []);
      const linkNetwork = { W1N1: previous, W2N2: sibling };
      Memory.runtime = { linkNetwork };

      writeLinkRoomRuntime("W1N1", replacement);

      expect(Memory.runtime.linkNetwork).toBe(linkNetwork);
      expect(Memory.runtime.linkNetwork.W1N1).toBe(replacement);
      expect(Memory.runtime.linkNetwork.W2N2).toBe(sibling);
    });
  });

  describe("pruneLinkNetworkRuntime", () => {
    it("keeps owned entries by reference, removes every other key, and reports the exact count", () => {
      const kept = createSnapshot(20, ["kept-b", "kept-a"], ["kept-receiver"]);
      const lost = createSnapshot(21, ["lost-sender"], []);
      const invisible = createSnapshot(22, [], ["invisible-receiver"]);
      const linkNetwork = { W1N1: kept, W2N2: lost, W3N3: invisible };
      Memory.runtime = { linkNetwork };

      expect(pruneLinkNetworkRuntime(new Set(["W1N1"]))).toBe(2);
      expect(Memory.runtime.linkNetwork).toBe(linkNetwork);
      expect(Memory.runtime.linkNetwork).toEqual({ W1N1: kept });
      expect(Memory.runtime.linkNetwork.W1N1).toBe(kept);
      expect(Memory.runtime.linkNetwork.W1N1.senderIds).toEqual(["kept-b", "kept-a"]);
    });

    it("returns zero without writing when runtime or linkNetwork is absent", () => {
      Object.assign(global, { Memory: {} as Memory });

      expect(pruneLinkNetworkRuntime(new Set(["W1N1"]))).toBe(0);
      expect(Memory).toEqual({});

      const runtime = {} as NonNullable<Memory["runtime"]>;
      Memory.runtime = runtime;

      expect(pruneLinkNetworkRuntime(new Set(["W1N1"]))).toBe(0);
      expect(Memory.runtime).toBe(runtime);
      expect(Object.prototype.hasOwnProperty.call(runtime, "linkNetwork")).toBe(false);
    });

    it("returns zero and preserves an existing empty container", () => {
      const linkNetwork = {} as NonNullable<
        NonNullable<Memory["runtime"]>["linkNetwork"]
      >;
      Memory.runtime = { linkNetwork };

      expect(pruneLinkNetworkRuntime(new Set())).toBe(0);
      expect(Memory.runtime.linkNetwork).toBe(linkNetwork);
      expect(Memory.runtime.linkNetwork).toEqual({});
    });

    it("keeps the empty container after deleting the last non-owned entry", () => {
      const linkNetwork = {
        W8N8: createSnapshot(33, ["sender"], ["receiver"]),
      };
      Memory.runtime = { linkNetwork };

      expect(pruneLinkNetworkRuntime(new Set())).toBe(1);
      expect(Memory.runtime.linkNetwork).toBe(linkNetwork);
      expect(Memory.runtime.linkNetwork).toEqual({});
    });

    it("is idempotent after the first prune", () => {
      const kept = createSnapshot(40, ["sender"], ["receiver"]);
      const linkNetwork = {
        W1N1: kept,
        W4N4: createSnapshot(41, [], []),
      };
      Memory.runtime = { linkNetwork };
      const ownedRooms = new Set(["W1N1"]);

      expect(pruneLinkNetworkRuntime(ownedRooms)).toBe(1);
      expect(pruneLinkNetworkRuntime(ownedRooms)).toBe(0);
      expect(Memory.runtime.linkNetwork).toBe(linkNetwork);
      expect(Memory.runtime.linkNetwork).toEqual({ W1N1: kept });
      expect(Memory.runtime.linkNetwork.W1N1).toBe(kept);
    });
  });
});
