import {
  RCL8_UPGRADER_MAINTENANCE_BODY,
  RCL8_UPGRADER_RECOVERY_START_TICKS,
  RCL8_UPGRADER_RECOVERY_STOP_TICKS,
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

  it("locks the recovery hysteresis to 175000/195000 ticks", () => {
    expect(RCL8_UPGRADER_RECOVERY_START_TICKS).toBe(175_000);
    expect(RCL8_UPGRADER_RECOVERY_STOP_TICKS).toBe(195_000);
    expect(RCL8_UPGRADER_MAINTENANCE_BODY).toEqual([WORK, CARRY, MOVE]);
    expect(RCL8_UPGRADER_MAINTENANCE_BODY.reduce((sum, part) => sum + BODYPART_COST[part], 0)).toBe(200);
  });

  it("accepts only the exact active minimal maintenance config", () => {
    expect(isRcl8MaintenanceUpgraderConfig("E4N58:upgrader:0", createConfig())).toBe(true);
  });

  it("rejects a minimal RCL8 config without maintenance provenance", () => {
    delete Memory.data!.manualUpgraders!.E4N58.maintenance;

    expect(isRcl8MaintenanceUpgraderConfig("E4N58:upgrader:0", createConfig())).toBe(false);
  });

  it("never treats an owned RCL1-7 controller as a dedicated-upgrader target", () => {
    const controller = createController(20_000, true, 7);

    expect(shouldMaintainDedicatedUpgrader(controller, false)).toBe(false);
    expect(shouldMaintainDedicatedUpgrader(controller, true)).toBe(false);
    expect(isDedicatedUpgraderControllerRunnable(controller)).toBe(false);
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
