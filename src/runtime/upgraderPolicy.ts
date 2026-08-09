import type { CreepConfig } from "@/types/system";

export const RCL8_UPGRADER_RECOVERY_START_TICKS = 175_000;
export const RCL8_UPGRADER_RECOVERY_STOP_TICKS = 195_000;
export const RCL8_UPGRADER_MAINTENANCE_BODY: readonly BodyPartConstant[] = [WORK, CARRY, MOVE];

function getControllerDowngradeTicks(controller: StructureController): number {
  return controller.ticksToDowngrade ?? RCL8_UPGRADER_RECOVERY_STOP_TICKS;
}

export function shouldMaintainDedicatedUpgrader(
  controller: StructureController,
  hasExistingTask: boolean,
): boolean {
  if (!controller.my || controller.level !== 8) return false;

  const ticksToDowngrade = getControllerDowngradeTicks(controller);
  return hasExistingTask
    ? ticksToDowngrade < RCL8_UPGRADER_RECOVERY_STOP_TICKS
    : ticksToDowngrade <= RCL8_UPGRADER_RECOVERY_START_TICKS;
}

export function isDedicatedUpgraderControllerRunnable(controller: StructureController): boolean {
  if (!controller.my || controller.level !== 8) return false;
  return getControllerDowngradeTicks(controller) < RCL8_UPGRADER_RECOVERY_STOP_TICKS;
}

export function isRcl8MaintenanceUpgraderConfig(
  configName: string,
  config: CreepConfig | undefined,
): boolean {
  if (
    !config?.roomName ||
    config.role !== "upgrader" ||
    configName !== `${config.roomName}:upgrader:0` ||
    Memory.data?.manualUpgraders?.[config.roomName]?.maintenance !== true ||
    config.body?.length !== RCL8_UPGRADER_MAINTENANCE_BODY.length ||
    !config.body.every((part, index) => part === RCL8_UPGRADER_MAINTENANCE_BODY[index])
  ) {
    return false;
  }

  const controller = Game.rooms[config.roomName]?.controller;
  return !!controller &&
    controller.level === 8 &&
    isDedicatedUpgraderControllerRunnable(controller);
}
