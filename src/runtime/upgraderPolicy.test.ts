import {
  RCL8_UPGRADER_MAINTENANCE_BODY,
  RCL8_UPGRADER_RECOVERY_START_TICKS,
  isDedicatedUpgraderControllerRunnable,
  isRcl8MaintenanceUpgraderConfig,
  shouldMaintainDedicatedUpgrader,
} from "@/runtime/upgraderPolicy";
import type { CreepConfig } from "@/types/system";

function createController(
  ticksToDowngrade = RCL8_UPGRADER_RECOVERY_START_TICKS,
  my = true,
  level = 8,
): StructureController {
  return {
    level,
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
        E4N58: { createdAt: Game.time, updatedAt: Game.time, maintenance: true },
      },
    };
    Game.rooms.E4N58 = {
      name: "E4N58",
      controller: createController(),
    } as Room;
  });

  it("accepts only the exact active minimal maintenance config", () => {
    expect(isRcl8MaintenanceUpgraderConfig("E4N58:upgrader:0", createConfig())).toBe(true);
  });

  it("preserves the RCL8 recovery hysteresis boundaries", () => {
    expect(shouldMaintainDedicatedUpgrader(createController(175_001), false)).toBe(false);
    expect(shouldMaintainDedicatedUpgrader(createController(175_000), false)).toBe(true);
    expect(shouldMaintainDedicatedUpgrader(createController(194_999), true)).toBe(true);
    expect(shouldMaintainDedicatedUpgrader(createController(195_000), true)).toBe(false);
    expect(isDedicatedUpgraderControllerRunnable(createController(194_999))).toBe(true);
    expect(isDedicatedUpgraderControllerRunnable(createController(195_000))).toBe(false);
  });
});
