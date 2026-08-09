import { spawnMaxCarrier } from "@/runtime/emergencySpawning";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

describe("spawnMaxCarrier", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
    Game.rooms = {};
    Game.spawns = {};
    Memory.data = {};
  });

  it("queues the same 1000-capacity body used by the standard carrier policy", () => {
    const room = {
      name: "W1N1",
      energyAvailable: 5_600,
      energyCapacityAvailable: 5_600,
    } as Room;
    const spawn = {
      id: "spawn-a" as Id<StructureSpawn>,
      name: "Spawn1",
      room,
      memory: { spawnList: [] },
      spawning: null,
      isActive: () => true,
    } as unknown as StructureSpawn;
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;

    const result = spawnMaxCarrier(room.name);

    expect(typeof result).not.toBe("string");
    if (typeof result === "string") {
      throw new Error(result);
    }
    const body = Memory.data?.creepConfigs?.[result.configName].body;
    expect(body?.filter((part) => part === CARRY)).toHaveLength(20);
    expect(body?.filter((part) => part === MOVE)).toHaveLength(20);
    expect(result.pairCount).toBe(20);
    expect(spawn.memory.spawnList?.[0]).toBe(result.configName);
  });
});
