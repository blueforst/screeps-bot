import { ensureRuntimeMemoryRoot } from "@/runtime/memoryService";

type LinkNetworkRuntime = NonNullable<
  NonNullable<Memory["runtime"]>["linkNetwork"]
>;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type LinkRoomRuntimeSnapshot = LinkNetworkRuntime[string];
export type LinkRoomRuntimeView = DeepReadonly<LinkRoomRuntimeSnapshot>;

export function peekLinkRoomRuntime(roomName: string): LinkRoomRuntimeView | undefined {
  return Memory.runtime?.linkNetwork?.[roomName];
}

export function writeLinkRoomRuntime(roomName: string, snapshot: LinkRoomRuntimeSnapshot): void {
  const runtime = ensureRuntimeMemoryRoot();
  runtime.linkNetwork = runtime.linkNetwork || {};
  runtime.linkNetwork[roomName] = snapshot;
}

export function pruneLinkNetworkRuntime(ownedRoomNames: ReadonlySet<string>): number {
  const linkNetwork = Memory.runtime?.linkNetwork;
  if (!linkNetwork) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(linkNetwork)) {
    if (ownedRoomNames.has(roomName)) {
      continue;
    }

    delete linkNetwork[roomName];
    removed += 1;
  }

  return removed;
}
