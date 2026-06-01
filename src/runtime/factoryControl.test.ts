import { createMockFactory, createMockStore, MockFactoryConfig } from "@mock/powerBank";

interface FactoryRoomOptions {
  name?: string;
  rcl?: number;
  storageResources?: Record<string, number>;
  terminalResources?: Record<string, number>;
  factoryOverrides?: Partial<MockFactoryConfig>;
}

interface FactoryRoomHandle {
  room: Room;
  factory: StructureFactory;
  storage: StructureStorage;
  terminal: StructureTerminal;
}

function createFactoryRoom(options: FactoryRoomOptions = {}): FactoryRoomHandle {
  const roomName = options.name ?? "W1N1";
  const rcl = options.rcl ?? 7;

  const storage: StructureStorage = {
    id: `${roomName}-storage` as Id<StructureStorage>,
    structureType: STRUCTURE_STORAGE,
    store: createMockStore(options.storageResources ?? { [RESOURCE_ENERGY]: 300000 }),
  } as unknown as StructureStorage;

  const terminal: StructureTerminal = {
    id: `${roomName}-terminal` as Id<StructureTerminal>,
    structureType: STRUCTURE_TERMINAL,
    cooldown: 0,
    store: createMockStore(options.terminalResources ?? { [RESOURCE_ENERGY]: 25000 }),
  } as unknown as StructureTerminal;

  const factory = createMockFactory({
    id: `${roomName}-factory`,
    roomName,
    level: rcl >= 7 ? 1 : 0,
    store: createMockStore({}),
    ...options.factoryOverrides,
  });

  const allStructures: any[] = [factory, storage, terminal];

  const roomObj: Partial<Room> = {
    name: roomName,
    controller: { my: true, level: rcl } as StructureController,
    storage,
    terminal,
  };
  Object.assign(roomObj, {
    factory,
    find: ((type: FindConstant, opts?: { filter?: (s: Structure) => boolean }) => {
      if (type === FIND_MY_STRUCTURES) {
        return opts?.filter
          ? allStructures.filter((s: any) => opts.filter!(s as Structure))
          : allStructures;
      }
      return [];
    }) as Room["find"],
  });

  return {
    room: roomObj as Room,
    factory,
    storage,
    terminal,
  };
}

describe("factory mock", () => {
  it("calls produce on a mocked factory and returns OK", () => {
    const { room, factory } = createFactoryRoom({
      factoryOverrides: {
        store: createMockStore({ [RESOURCE_ENERGY]: 50000, [RESOURCE_BATTERY]: 5000 }),
        level: 1,
      },
    });

    expect((room as any).factory).toBeDefined();
    expect((room as any).factory.structureType).toBe(STRUCTURE_FACTORY);
    expect((room as any).factory.level).toBe(1);

    const result = factory.produce(RESOURCE_BATTERY);
    expect(result).toBe(OK);
    expect(factory.produce).toHaveBeenCalledWith(RESOURCE_BATTERY);
    expect(factory.produce).toHaveBeenCalledTimes(1);
  });

  it("discovers factory via room.find(FIND_MY_STRUCTURES)", () => {
    const { room } = createFactoryRoom();

    const factories = room.find(FIND_MY_STRUCTURES, {
      filter: (s: Structure) => s.structureType === STRUCTURE_FACTORY,
    });

    expect(factories.length).toBe(1);
    expect(factories[0].structureType).toBe(STRUCTURE_FACTORY);
  });

  it("returns custom error code from overridden produce", () => {
    const factory = createMockFactory({
      id: "W1N1-factory-2",
      roomName: "W1N1",
      produce: jest.fn(() => ERR_NOT_ENOUGH_RESOURCES),
    });

    const result = factory.produce(RESOURCE_BATTERY);
    expect(result).toBe(ERR_NOT_ENOUGH_RESOURCES);
    expect(factory.produce).toHaveBeenCalledTimes(1);
  });

  it("exposes cooldown and store helpers on the factory mock", () => {
    const factory = createMockFactory({
      id: "W1N1-factory-3",
      roomName: "W1N1",
      cooldown: 5,
      store: createMockStore({ [RESOURCE_ENERGY]: 10000 }),
    });

    expect(factory.cooldown).toBe(5);
    expect(factory.store.getUsedCapacity(RESOURCE_ENERGY)).toBe(10000);
    expect(factory.store.getUsedCapacity()).toBe(10000);
  });
});
