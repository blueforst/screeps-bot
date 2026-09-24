import { runPowerBankHarvest } from "@/runtime/powerBankHarvest";
import { getPowerBankConfigName, POWER_BANK_STATUS } from "@/runtime/powerBankConstants";
import { runPowerBankVisionDispatch } from "@/runtime/powerBankMission";
import { runPowerBankObserverIntake } from "@/runtime/powerBankObserver";
import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";
import { getCreepConfigService, registerRuntimeServices } from "@/runtime/runtimeServices";
import { createMockLab, createMockPowerBank, createMockStore, MockPos } from "@mock/powerBank";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
type SearchResult = { path: Array<Pick<RoomPosition, "x" | "y" | "roomName">>; incomplete: boolean; ops: number };

const HOME = "E3N59";
const CORRIDOR = "E4N59";
const TARGET = "E4N60";

function makeRoom(name: string, structures: Structure[] = [], bank?: StructurePowerBank): Room {
  return {
    name,
    controller: name === HOME ? { my: true, level: 8 } : undefined,
    energyAvailable: 8000,
    energyCapacityAvailable: 8000,
    storage: name === HOME ? {
      id: `${HOME}-storage` as Id<StructureStorage>,
      pos: new MockPos(25, 25, HOME) as unknown as RoomPosition,
      store: createMockStore({
        [RESOURCE_ENERGY]: 50_000,
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
        [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 5000,
      }, 100_000),
    } as unknown as StructureStorage : undefined,
    terminal: name === HOME ? {
      id: `${HOME}-terminal` as Id<StructureTerminal>,
      pos: new MockPos(26, 25, HOME) as unknown as RoomPosition,
      store: createMockStore({}, 50_000),
      cooldown: 0,
    } as unknown as StructureTerminal : undefined,
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_MY_STRUCTURES) return structures;
      if (type === FIND_STRUCTURES) return [...structures, ...(bank ? [bank] : [])];
      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_POWER_CREEPS || type === FIND_HOSTILE_STRUCTURES) return [];
      return [];
    }),
  } as unknown as Room;
}

function setupWorld(pathResult: "complete" | "unreachable"): { observer: StructureObserver; spawn: StructureSpawn } {
  delete (global as RuntimeGlobal).__runtimeServices;
  registerRuntimeServices();
  Game.time = 100;
  Game.rooms = {};
  Game.spawns = {};
  Game.creeps = {};
  Memory.data = {};
  Memory.runtime = {};
  Memory.creeps = {};
  Object.assign(global, { RoomPosition: MockPos });

  const labs = Array.from({ length: 3 }, (_, index) => createMockLab({ id: `${HOME}-lab${index}`, roomName: HOME }));
  const baseStructures: Structure[] = [...labs];
  const home = makeRoom(HOME, baseStructures);
  const observer = {
    id: `${HOME}-observer` as Id<StructureObserver>,
    structureType: STRUCTURE_OBSERVER,
    room: home,
    pos: new MockPos(10, 10, HOME) as unknown as RoomPosition,
    isActive: () => true,
    observeRoom: jest.fn(() => OK),
  } as unknown as StructureObserver;
  const spawn = {
    id: `${HOME}-spawn` as Id<StructureSpawn>,
    name: `${HOME}-spawn`,
    structureType: STRUCTURE_SPAWN,
    room: home,
    pos: new MockPos(48, 25, HOME) as unknown as RoomPosition,
    memory: { spawnList: [] },
    spawning: null,
    owner: { username: "me" },
    isActive: () => true,
    addTask(configName: string) {
      if (!this.memory.spawnList!.includes(configName)) this.memory.spawnList!.push(configName);
      return this.memory.spawnList!.length;
    },
  } as unknown as StructureSpawn;
  baseStructures.push(observer, spawn);
  (home.find as jest.Mock).mockImplementation((type: FindConstant) => {
    if (type === FIND_MY_STRUCTURES) return baseStructures;
    if (type === FIND_STRUCTURES) return baseStructures;
    if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_POWER_CREEPS || type === FIND_HOSTILE_STRUCTURES) return [];
    return [];
  });
  Game.rooms[HOME] = home;
  Game.spawns[spawn.name] = spawn;

  Game.map = {
    ...Game.map,
    describeExits: jest.fn((roomName: string) => roomName === HOME
      ? { [FIND_EXIT_RIGHT]: CORRIDOR }
      : roomName === CORRIDOR
        ? { [FIND_EXIT_TOP]: TARGET }
        : null),
    findRoute: jest.fn(() => [
      { room: CORRIDOR, exit: FIND_EXIT_RIGHT },
    ]),
    getRoomLinearDistance: jest.fn(() => 1),
    getRoomStatus: jest.fn(() => ({ status: "normal" })),
    getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
  } as unknown as GameMap;

  (global as any).PathFinder = {
    search: jest.fn((origin: RoomPosition, goal: { pos: RoomPosition }) => {
      if (pathResult === "unreachable") return { path: [], incomplete: false, ops: 500 } as SearchResult;
      if (origin.roomName === HOME) {
        return {
          path: [
            { x: 0, y: 25, roomName: CORRIDOR },
            { x: 25, y: 49, roomName: TARGET },
          ],
          incomplete: false,
          ops: 500,
        } as SearchResult;
      }
      return {
        path: [
          { x: 25, y: 49, roomName: TARGET },
          { x: 25, y: 0, roomName: CORRIDOR },
          { x: 49, y: 25, roomName: HOME },
        ],
        incomplete: false,
        ops: 500,
      } as SearchResult;
    }),
  };

  return { observer, spawn };
}

function runIntegratedTick(): void {
  runPowerBankObserverIntake();
  runPowerBankHarvest();
  runPowerBankVisionDispatch();
}

describe("Power Bank mission production path", () => {
  it("discovers an off-list Bank through Observer vision, waits for corridor vision, plans real paths and queues the selected base", () => {
    const { observer, spawn } = setupWorld("complete");

    runIntegratedTick();
    expect(observer.observeRoom).toHaveBeenCalledWith(TARGET);
    expect(Memory.data?.powerBankHarvest).toEqual({});

    Game.time = 101;
    const bank = createMockPowerBank({
      id: "dynamic-bank",
      roomName: TARGET,
      hits: 50_000,
      power: 1000,
      ticksToDecay: 5000,
    });
    Game.rooms[TARGET] = makeRoom(TARGET, [], bank);
    runIntegratedTick();

    const discovered = Memory.data?.powerBankHarvest?.[bank.id];
    expect(discovered).toMatchObject({
      status: POWER_BANK_STATUS.DISCOVERED,
      targetRoom: TARGET,
      sourceRoom: HOME,
      blocker: "route_requires_fresh_vision",
      planningRooms: [CORRIDOR],
    });
    expect(spawn.memory.spawnList?.filter((name) => name.includes(":powerbank:"))).toEqual([]);
    expect(observer.observeRoom).toHaveBeenCalledWith(CORRIDOR);

    Game.time = 102;
    Game.rooms[CORRIDOR] = makeRoom(CORRIDOR);
    runIntegratedTick();
    const planned = Memory.data?.powerBankHarvest?.[bank.id];
    expect(planned).toMatchObject({
      status: POWER_BANK_STATUS.PREPARING_BOOSTS,
      sourceRoom: HOME,
      routeRooms: [HOME, CORRIDOR, TARGET],
      routeConfidence: "observed",
      receiverRoom: HOME,
    });
    expect(planned?.combatTravelTicks).toBeGreaterThan(0);
    expect(planned?.haulerOutboundTravelTicks).toBeGreaterThan(0);
    expect(planned?.haulerReturnTravelTicks).toBeGreaterThanOrEqual(planned?.haulerOutboundTravelTicks ?? 0);
    expect(planned?.plannedHaulerReturnTick).toBeGreaterThan(planned?.plannedHaulerArrivalTick ?? 0);

    jest.spyOn(require("@/runtime/powerBankBoost"), "prepareBoosts").mockReturnValue({ status: "ready", labs: [] });
    Game.time = 103;
    runIntegratedTick();
    Game.time = 104;
    runIntegratedTick();
    scheduleSpawnTasks();

    const attacker = getPowerBankConfigName(HOME, TARGET, "attacker", 0, bank.id, 0);
    const healer = getPowerBankConfigName(HOME, TARGET, "healer", 0, bank.id, 0);
    expect(getCreepConfigService().get(attacker)).toBeDefined();
    expect(getCreepConfigService().get(healer)).toBeDefined();
    expect(spawn.memory.spawnList).toEqual(expect.arrayContaining([attacker, healer]));
  });

  it("does not enqueue a Bank when complete tile searches show no reachable combat position", () => {
    const { observer, spawn } = setupWorld("unreachable");
    runIntegratedTick();
    expect(observer.observeRoom).toHaveBeenCalledWith(TARGET);

    Game.time = 101;
    const bank = createMockPowerBank({ id: "blocked-bank", roomName: TARGET, hits: 50_000, power: 1000 });
    Game.rooms[TARGET] = makeRoom(TARGET, [], bank);
    Game.rooms[CORRIDOR] = makeRoom(CORRIDOR);
    runIntegratedTick();
    scheduleSpawnTasks();

    expect(Memory.data?.powerBankHarvestHistory).toContainEqual(expect.objectContaining({
      taskId: bank.id,
      failReason: expect.stringContaining("path_unreachable"),
    }));
    expect(Object.keys(getCreepConfigService().list()).filter((name) => name.includes(":powerbank:"))).toEqual([]);
    expect(spawn.memory.spawnList?.filter((name) => name.includes(":powerbank:"))).toEqual([]);
  });
});
