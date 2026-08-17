import {
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
  });
});
