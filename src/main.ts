import { BUILD_INFO } from "@/buildMeta";
import { errorMapper } from "@/modules/errorMapper";
import { mountAll } from "@/mount";
import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { runInterShardControl } from "@/runtime/interShardControl";
import { runCrossShardSignals } from "@/runtime/crossShardSignals";
import { runPixelGenerator } from "@/runtime/pixelGenerator";
import { runPortalDiscovery } from "@/runtime/portalDiscovery";
import { registerProductionApi, runProductionMonitor } from "@/runtime/productionMonitor";
import { bootstrapRooms } from "@/runtime/bootstrap";
import { runCoreDefense } from "@/runtime/coreDefense";
import { runFlagControl } from "@/runtime/flagControl";
import { runLinkControl } from "@/runtime/linkControl";
import { runRoomPlannerConstruction } from "@/runtime/roomPlannerConstruction";
import { registerGlobalApi } from "@/runtime/creepApi";
import { registerConsoleCommands } from "@/runtime/consoleCommands";
import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";
import { runTowerControl } from "@/runtime/towerControl";
import { runWarControl } from "@/runtime/warControl";
import { refreshWorkerTasks } from "@/runtime/workerTaskPool";

mountAll();
registerGlobalApi();
registerConsoleCommands();
registerProductionApi();

function announceDeploy(): void {
  Memory.runtime = Memory.runtime || {};
  if (Memory.runtime.lastDeployTag === BUILD_INFO.tag) {
    return;
  }

  Memory.runtime.lastDeployTag = BUILD_INFO.tag;
  console.log(`[deploy] ${BUILD_INFO.tag}`);
}

export function addNumbers(num1: number, num2: number): number {
  return num1 + num2;
}

function gameLoop(): void {
  announceDeploy();
  runPixelGenerator();
  runProductionMonitor();
  runMemoryCleanup();
  runPortalDiscovery();
  runFlagControl();
  runCrossShardSignals();
  runInterShardControl();
  runWarControl();
  runRoomPlannerConstruction();
  runLinkControl();
  runCoreDefense();
  runTowerControl();
  refreshWorkerTasks();
  bootstrapRooms();
  scheduleSpawnTasks();

  Object.values(Game.spawns).forEach((spawn) => spawn.work());
  Object.values(Game.creeps).forEach((creep) => creep.work());
}

export const loop = errorMapper(gameLoop);
