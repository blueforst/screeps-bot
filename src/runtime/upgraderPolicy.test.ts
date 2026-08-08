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

  it("accepts only the exact active minimal maintenance config", () => {
    expect(isRcl8MaintenanceUpgraderConfig("E4N58:upgrader:0", createConfig())).toBe(true);
  });

  it.each([
    ["missing task", () => { delete Memory.data?.manualUpgraders?.E4N58; }, "E4N58:upgrader:0", createConfig()],
    ["wrong config name", () => undefined, "E4N58:upgrader:other", createConfig()],
    ["wrong body", () => undefined, "E4N58:upgrader:0", { ...createConfig(), body: [WORK, WORK, CARRY, MOVE] }],
    ["lost ownership", () => { Game.rooms.E4N58.controller = createController(RCL8_UPGRADER_RECOVERY_START_TICKS, false); }, "E4N58:upgrader:0", createConfig()],
    ["stop threshold", () => { Game.rooms.E4N58.controller = createController(RCL8_UPGRADER_RECOVERY_STOP_TICKS); }, "E4N58:upgrader:0", createConfig()],
  ])("rejects %s", (_label, mutate, configName, config) => {
    mutate();
    expect(isRcl8MaintenanceUpgraderConfig(configName, config)).toBe(false);
  });
});
