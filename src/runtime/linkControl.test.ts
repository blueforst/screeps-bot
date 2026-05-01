import { hasSharedStorageControllerLinkCluster, isReceiverLink, isStorageReceiverLink } from "@/runtime/linkControl";

function createPosition(rangeToTarget?: (target: { structureType?: StructureConstant }) => number): RoomPosition {
  return {
    getRangeTo(target: { structureType?: StructureConstant }): number {
      return rangeToTarget?.(target) ?? Number.POSITIVE_INFINITY;
    },
  } as RoomPosition;
}

function createLink(options: {
  controllerRange?: number;
  storageRange?: number;
  storageControllerRange?: number;
}): StructureLink {
  const controllerRange = options.controllerRange ?? Number.POSITIVE_INFINITY;
  const storageRange = options.storageRange ?? Number.POSITIVE_INFINITY;
  const storageControllerRange = options.storageControllerRange ?? Number.POSITIVE_INFINITY;
  const controllerPos = createPosition();
  const storagePos = createPosition((target) => (target === controllerPos ? storageControllerRange : Number.POSITIVE_INFINITY));

  return {
    id: `link:${controllerRange}:${storageRange}`,
    pos: createPosition((target) => (target.structureType === STRUCTURE_STORAGE ? storageRange : controllerRange)),
    room: {
      name: "W1N1",
      controller: {
        pos: controllerPos,
      } as StructureController,
      storage: {
        structureType: STRUCTURE_STORAGE,
        pos: storagePos,
      } as StructureStorage,
    } as Room,
  } as StructureLink;
}

describe("isReceiverLink", () => {
  beforeEach(() => {
    Memory.runtime = undefined;
  });

  it("treats controller-adjacent links at range 3 as receivers", () => {
    const link = createLink({ controllerRange: 3, storageRange: 10 });

    expect(isReceiverLink(link)).toBe(true);
  });

  it("does not treat controller-distant links beyond range 3 as receivers", () => {
    const link = createLink({ controllerRange: 4, storageRange: 10 });

    expect(isReceiverLink(link)).toBe(false);
  });

  it("keeps storage receiver classification at range 2", () => {
    const link = createLink({ controllerRange: 10, storageRange: 3 });

    expect(isReceiverLink(link)).toBe(false);
  });

  it("treats controller receiver links as storage receivers when storage and controller share a link cluster", () => {
    const link = createLink({ controllerRange: 3, storageRange: 4, storageControllerRange: 5 });

    expect(hasSharedStorageControllerLinkCluster(link.room)).toBe(true);
    expect(isReceiverLink(link)).toBe(true);
    expect(isStorageReceiverLink(link)).toBe(true);
  });

  it("keeps distant controller receiver links separate from storage receivers", () => {
    const link = createLink({ controllerRange: 3, storageRange: 4, storageControllerRange: 6 });

    expect(hasSharedStorageControllerLinkCluster(link.room)).toBe(false);
    expect(isReceiverLink(link)).toBe(true);
    expect(isStorageReceiverLink(link)).toBe(false);
  });
});
