import {
  RCL8_UPGRADER_MAINTENANCE_BODY,
  RCL8_UPGRADER_RECOVERY_START_TICKS,
  RCL8_UPGRADER_RECOVERY_STOP_TICKS,
  isRcl8MaintenanceUpgraderConfig,
} from "@/runtime/upgraderPolicy";
import type { CreepConfig } from "@/types/system";

function createController(
  ticksToDowngrade = RCL8_UPGRADER_RECOVERY_START_TICKS,
  my = true,
): StructureController {
  return {
    level: 8,
    my,
    ticksToDowngrade,
  } as StructureController;
}

function createConfig(roomName = "E4N58"): CreepConfig {
  return {
    role: "upgrader",
    args: [roomName],
    roomName,
    body: [...RCL8_UPGRADER_MAINTENANCE_BODY],
  };
}

describe("RCL8 upgrader maintenance authentication", () => {
  beforeEach(() => {
    Memory.data = {
      manualUpgraders: {
        E4N58: { createdAt: Game.time, updatedAt: Game.time },
      },
    };
    Game.rooms.E4N58 = {
      name: "E4N58",
      controller: createController(),
    } as Room;
  });

  it("locks the recovery hysteresis to 175000/195000 ticks", () => {
    expect(RCL8_UPGRADER_RECOVERY_START_TICKS).toBe(175_000);
    expect(RCL8_UPGRADER_RECOVERY_STOP_TICKS).toBe(195_000);
    expect(RCL8_UPGRADER_MAINTENANCE_BODY).toEqual([WORK, CARRY, MOVE]);
    expect(RCL8_UPGRADER_MAINTENANCE_BODY.reduce((sum, part) => sum + BODYPART_COST[part], 0)).toBe(200);
  });

  it("accepts only the exact active minimal maintenance config", () => {
    expect(isRcl8MaintenanceUpgraderConfig("E4N58:upgrader:0", createConfig())).toBe(true);
  });
});
