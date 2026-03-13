import { isReceiverLink } from "@/runtime/linkControl";

function createLink(options: { controllerRange?: number; storageRange?: number }): StructureLink {
  const controllerRange = options.controllerRange ?? Number.POSITIVE_INFINITY;
  const storageRange = options.storageRange ?? Number.POSITIVE_INFINITY;

  return {
    id: `link:${controllerRange}:${storageRange}`,
    pos: {
      getRangeTo(target: { structureType?: StructureConstant }): number {
        if (target.structureType === STRUCTURE_STORAGE) {
          return storageRange;
        }

        return controllerRange;
      },
    } as RoomPosition,
    room: {
      name: "W1N1",
      controller: {
        pos: {} as RoomPosition,
      } as StructureController,
      storage: {
        structureType: STRUCTURE_STORAGE,
        pos: {} as RoomPosition,
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
});
