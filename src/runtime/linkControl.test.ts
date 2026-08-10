import {
  hasSharedStorageControllerLinkCluster,
  isReceiverLink,
  isStorageReceiverLink,
  runLinkControl,
} from "@/runtime/linkControl";
import { setActiveTickCpuProfiler, type TickCpuProfiler } from "@/runtime/cpuPhaseProfiler";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function createNoopProfiler(recordFixedAction: jest.Mock = jest.fn()): TickCpuProfiler {
  return {
    measure<T>(_phase: string, fn: () => T): T {
      return fn();
    },
    recordFixedAction,
    measureCreep(_creep: Creep, fn: () => void): void {
      fn();
    },
    measureRoomPhase<T>(_phase: string, _roomName: string, fn: () => T): T {
      return fn();
    },
    flush(): void {},
  };
}

function createPosition(rangeToTarget?: (target: { structureType?: StructureConstant }) => number): RoomPosition {
  return {
    getRangeTo(target: { structureType?: StructureConstant }): number {
      return rangeToTarget?.(target) ?? Number.POSITIVE_INFINITY;
    },
  } as RoomPosition;
}

function createLink(options: {
  id?: string;
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
    id: options.id ?? `link:${controllerRange}:${storageRange}`,
    pos: createPosition((target) => (target === storagePos ? storageRange : controllerRange)),
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

function createOwnedRoom(
  roomName = "W1N1",
  myStructures: Structure<StructureConstant>[] = [],
  sources: Source[] = [],
): { room: Room; find: jest.Mock } {
  const find = jest.fn((findType: FindConstant) => {
    if (findType === FIND_MY_STRUCTURES) {
      return myStructures;
    }
    if (findType === FIND_SOURCES) {
      return sources;
    }
    if (findType === FIND_STRUCTURES) {
      return myStructures;
    }
    if (findType === FIND_CONSTRUCTION_SITES) {
      return [];
    }
    return [];
  });
  const room = {
    name: roomName,
    controller: {
      my: true,
      pos: createPosition(),
    } as StructureController,
    storage: {
      structureType: STRUCTURE_STORAGE,
      pos: createPosition(),
    } as StructureStorage,
    find,
  } as unknown as Room;
  return { room, find };
}

function createControlLink(options: {
  id: string;
  room: Room;
  sourcePos?: RoomPosition;
  controllerRange?: number;
  storageRange?: number;
  sourceRange?: number;
  energy?: number;
  capacity?: number;
  cooldown?: number;
  transferCode?: ScreepsReturnCode;
}): StructureLink {
  const transferEnergy = jest.fn(() => options.transferCode ?? OK);
  const link = {
    id: options.id,
    structureType: STRUCTURE_LINK,
    room: options.room,
    pos: createPosition((target) => {
      if (target === options.room.storage?.pos) {
        return options.storageRange ?? Number.POSITIVE_INFINITY;
      }
      if (target === options.room.controller?.pos) {
        return options.controllerRange ?? Number.POSITIVE_INFINITY;
      }
      if (target === options.sourcePos) {
        return options.sourceRange ?? Number.POSITIVE_INFINITY;
      }
      return Number.POSITIVE_INFINITY;
    }),
    cooldown: options.cooldown ?? 0,
    store: {
      getUsedCapacity: jest.fn(() => options.energy ?? 0),
      getCapacity: jest.fn(() => options.capacity ?? 800),
    },
    transferEnergy,
  } as unknown as StructureLink;
  return link;
}

beforeEach(() => {
  delete (global as RuntimeGlobal).__runtimeServices;
  Memory.runtime = undefined;
  Game.time = 100;
  Game.rooms = {};
  Game.getObjectById = jest.fn(() => null);
  setActiveTickCpuProfiler(createNoopProfiler());
});

afterEach(() => {
  delete (global as RuntimeGlobal).__runtimeServices;
  setActiveTickCpuProfiler(createNoopProfiler());
});

describe("isReceiverLink", () => {
  it("does not treat controller-distant links beyond range 3 as receivers", () => {
    const link = createLink({ controllerRange: 4, storageRange: 10 });

    expect(isReceiverLink(link)).toBe(false);
  });

  it("keeps storage receiver classification at range 2", () => {
    const link = createLink({ controllerRange: 10, storageRange: 3 });

    expect(isReceiverLink(link)).toBe(false);
  });

  it("keeps distant controller receiver links separate from storage receivers", () => {
    const link = createLink({ controllerRange: 3, storageRange: 4, storageControllerRange: 6 });

    expect(hasSharedStorageControllerLinkCluster(link.room)).toBe(false);
    expect(isReceiverLink(link)).toBe(true);
    expect(isStorageReceiverLink(link)).toBe(false);
  });

  it("falls back to positions without creating runtime memory when the cache is absent", () => {
    const link = createLink({ controllerRange: 10, storageRange: 2, storageControllerRange: 10 });

    expect(isReceiverLink(link)).toBe(true);
    expect(isStorageReceiverLink(link)).toBe(true);
    expect(Memory.runtime).toBeUndefined();
  });

  it("uses cached receiver membership while retaining positional storage semantics", () => {
    const cachedControllerLink = createLink({
      id: "cached-controller",
      controllerRange: 10,
      storageRange: 10,
      storageControllerRange: 10,
    });
    const uncachedStorageLink = createLink({
      id: "uncached-storage",
      controllerRange: 10,
      storageRange: 2,
      storageControllerRange: 10,
    });
    Memory.runtime = {
      linkNetwork: {
        W1N1: {
          updatedAt: Game.time,
          senderIds: [],
          receiverIds: [cachedControllerLink.id],
        },
      },
    };

    expect(isReceiverLink(cachedControllerLink)).toBe(true);
    expect(isStorageReceiverLink(cachedControllerLink)).toBe(false);
    expect(isReceiverLink(uncachedStorageLink)).toBe(true);
    expect(isStorageReceiverLink(uncachedStorageLink)).toBe(false);
  });
});

describe("runLinkControl cache lifecycle", () => {
  it("reuses a cache younger than 11 ticks without rescanning or rewriting it", () => {
    const { room, find } = createOwnedRoom();
    Game.rooms = { W1N1: room };
    Game.time = 110;
    const cached = {
      updatedAt: 100,
      senderIds: [],
      receiverIds: ["receiver"],
    };
    Memory.runtime = { linkNetwork: { W1N1: cached } };

    runLinkControl();

    expect(Memory.runtime?.linkNetwork?.W1N1).toBe(cached);
    expect(find.mock.calls.map(([findType]) => findType)).not.toContain(FIND_MY_STRUCTURES);
  });

  it("reclassifies the room when the cache is exactly 11 ticks old", () => {
    const structures: Structure<StructureConstant>[] = [];
    const sourcePos = createPosition();
    const sources = [{ id: "source", pos: sourcePos }] as unknown as Source[];
    const { room, find } = createOwnedRoom("W1N1", structures, sources);
    const sender = createControlLink({
      id: "sender",
      room,
      sourcePos,
      sourceRange: 1,
      controllerRange: 10,
      storageRange: 10,
    });
    const receiver = createControlLink({
      id: "receiver",
      room,
      sourcePos,
      sourceRange: 10,
      controllerRange: 10,
      storageRange: 2,
    });
    structures.push(sender, receiver);
    Game.rooms = { W1N1: room };
    Game.time = 111;
    const cached = {
      updatedAt: 100,
      senderIds: ["stale-sender"],
      receiverIds: ["stale-receiver"],
    };
    Memory.runtime = { linkNetwork: { W1N1: cached } };

    runLinkControl();

    expect(Memory.runtime?.linkNetwork?.W1N1).toEqual({
      updatedAt: 111,
      senderIds: [sender.id],
      receiverIds: [receiver.id],
    });
    expect(Memory.runtime?.linkNetwork?.W1N1).not.toBe(cached);
    expect(find.mock.calls.map(([findType]) => findType)).toContain(FIND_MY_STRUCTURES);
  });
});

describe("runLinkControl transfer intent", () => {
  it("transfers to an underfilled cached receiver and records a successful fixed CPU action", () => {
    const { room } = createOwnedRoom();
    const sender = createControlLink({ id: "sender", room, energy: 800 });
    const receiver = createControlLink({
      id: "receiver",
      room,
      storageRange: 2,
      energy: 100,
      capacity: 800,
    });
    const objects = new Map<string, StructureLink>([
      [sender.id, sender],
      [receiver.id, receiver],
    ]);
    Game.rooms = { W1N1: room };
    Game.getObjectById = jest.fn((id: Id<_HasId>) => objects.get(id) ?? null) as typeof Game.getObjectById;
    Memory.runtime = {
      linkNetwork: {
        W1N1: {
          updatedAt: Game.time,
          senderIds: [sender.id],
          receiverIds: [receiver.id],
        },
      },
    };
    const recordFixedAction = jest.fn();
    setActiveTickCpuProfiler(createNoopProfiler(recordFixedAction));

    runLinkControl();

    expect(sender.transferEnergy).toHaveBeenCalledWith(receiver);
    expect(recordFixedAction).toHaveBeenCalledWith("linkControl", 1);
  });
});
