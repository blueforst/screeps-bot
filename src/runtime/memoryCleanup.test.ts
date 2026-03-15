import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { clearTileReservationsForTest, reserveNextTile } from "@/movement/reservations";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createOwnedRoom(name: string): Room {
  return {
    name,
    memory: {} as RoomMemory,
    controller: {
      my: true,
      level: 8,
    } as StructureController,
    find: () => [],
  } as unknown as Room;
}

describe("runMemoryCleanup", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearTileReservationsForTest();
    Game.time = 17;
    Game.rooms = {
      W1N1: createOwnedRoom("W1N1"),
    };
    Game.creeps = {};
    Game.spawns = {};
    Memory.rooms = {
      W2N2: {
        pickupReservations: {
          target1: {
            kind: "structure",
            claims: {
              DeadCarrier: {
                amount: 50,
                until: 10,
              },
            },
          },
        },
      } as RoomMemory,
    };
    Memory.creeps = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
  });

  it("removes foreign room pickup reservation memory after claims expire", () => {
    runMemoryCleanup();

    expect(Memory.rooms?.W2N2).toBeUndefined();
  });

  it("releases tile reservations for dead creeps", () => {
    Memory.creeps = {
      DeadCarrier: {} as CreepMemory,
    };

    reserveNextTile({ name: "DeadCarrier" } as Creep, { x: 10, y: 10, roomName: "W1N1" } as RoomPosition);

    runMemoryCleanup();

    expect(reserveNextTile({ name: "LiveCarrier" } as Creep, { x: 10, y: 10, roomName: "W1N1" } as RoomPosition)).toBe(true);
  });
});
