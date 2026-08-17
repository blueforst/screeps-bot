import {
  TERMINAL_BOOTSTRAP_RECOVERY_STABLE_TICKS,
  noteTerminalBootstrapRecoveryPickup,
  observeTerminalBootstrapRecovery,
} from "@/runtime/terminalBootstrapRecovery";

const ROOM_NAME = "E7N58";
const CANONICAL_CARRIER = `${ROOM_NAME}:carrier:0`;
const LOCAL_MINER = `${ROOM_NAME}:miner:source-1`;

function installRoom(options: {
  flag?: boolean;
  energyAvailable?: number;
  carrierSpawning?: boolean;
  includeCanonicalCarrier?: boolean;
  includeManualCarrier?: boolean;
  includeMiner?: boolean;
} = {}): Room {
  const room = {
    name: ROOM_NAME,
    controller: { my: true, level: 7 },
    energyAvailable: options.energyAvailable ?? 2_800,
    energyCapacityAvailable: 5_600,
    terminal: {
      id: "terminal-e7n58",
      structureType: STRUCTURE_TERMINAL,
    },
  } as unknown as Room;
  Game.rooms[ROOM_NAME] = room;

  Memory.cfg = {
    energyPickup: {
      terminalBootstrapRecoveryRooms: options.flag === false
        ? {}
        : { [ROOM_NAME]: true },
    },
    resourceControl: {
      rooms: {
        [ROOM_NAME]: { terminalEnergyReserve: 20_000 },
      },
    },
  };
  Memory.data = {
    creepConfigs: {
      [CANONICAL_CARRIER]: {
        role: "carrier",
        args: [],
        roomName: ROOM_NAME,
      },
      [LOCAL_MINER]: {
        role: "miner",
        args: ["source-1"],
        roomName: ROOM_NAME,
      },
    },
  };
  Memory.runtime = {};

  const creeps: Record<string, Creep> = {};
  if (options.includeCanonicalCarrier !== false) {
    creeps.canonicalCarrier = {
      name: "canonicalCarrier",
      spawning: options.carrierSpawning ?? false,
      memory: { role: "carrier", configName: CANONICAL_CARRIER },
      room,
    } as unknown as Creep;
  }
  if (options.includeManualCarrier) {
    creeps.manualCarrier = {
      name: "manualCarrier",
      spawning: false,
      memory: { role: "carrier", configName: `${ROOM_NAME}:manual:maxcarrier:1` },
      room,
    } as unknown as Creep;
  }
  if (options.includeMiner !== false) {
    creeps.localMiner = {
      name: "localMiner",
      spawning: false,
      memory: { role: "miner", configName: LOCAL_MINER },
      room,
    } as unknown as Creep;
  }
  Game.creeps = creeps;
  return room;
}

describe("Terminal bootstrap recovery policy", () => {

  it("auto-clears only after 25 consecutive healthy ticks", () => {
    installRoom();
    Game.time = 1_000;

    for (let offset = 0; offset < TERMINAL_BOOTSTRAP_RECOVERY_STABLE_TICKS - 1; offset += 1) {
      Game.time = 1_000 + offset;
      expect(observeTerminalBootstrapRecovery(ROOM_NAME)).toBe(20_000);
      expect(Memory.cfg?.energyPickup?.terminalBootstrapRecoveryRooms?.[ROOM_NAME]).toBe(true);
    }

    Game.time = 1_000 + TERMINAL_BOOTSTRAP_RECOVERY_STABLE_TICKS - 1;
    expect(observeTerminalBootstrapRecovery(ROOM_NAME)).toBeUndefined();
    expect(Memory.cfg?.energyPickup?.terminalBootstrapRecoveryRooms?.[ROOM_NAME]).toBeUndefined();
    expect(Memory.runtime?.energyPickup?.terminalBootstrapRecovery?.[ROOM_NAME]).toBeUndefined();
  });

  it("resets the stable window when bootstrap Terminal Energy is used", () => {
    installRoom();
    Game.time = 3_000;
    observeTerminalBootstrapRecovery(ROOM_NAME);
    noteTerminalBootstrapRecoveryPickup(ROOM_NAME);

    expect(Memory.runtime?.energyPickup?.terminalBootstrapRecovery?.[ROOM_NAME]).toEqual(
      expect.objectContaining({ lastRecoveryPickupAt: Game.time }),
    );
    expect(Memory.runtime?.energyPickup?.terminalBootstrapRecovery?.[ROOM_NAME]?.healthySince).toBeUndefined();

    for (let offset = 1; offset < TERMINAL_BOOTSTRAP_RECOVERY_STABLE_TICKS; offset += 1) {
      Game.time = 3_000 + offset;
      expect(observeTerminalBootstrapRecovery(ROOM_NAME)).toBe(20_000);
    }
    expect(Memory.cfg?.energyPickup?.terminalBootstrapRecoveryRooms?.[ROOM_NAME]).toBe(true);
  });
});
