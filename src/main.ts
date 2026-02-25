import { BUILD_INFO } from "@/buildMeta";
import { errorMapper } from "@/modules/errorMapper";
import { runAutoPlannerByFlag } from "@/modules/autoplanner";
import { mountAll } from "@/mount";
import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { runPixelGenerator } from "@/runtime/pixelGenerator";
import { registerProductionApi, runProductionMonitor } from "@/runtime/productionMonitor";
import { bootstrapRooms } from "@/runtime/bootstrap";
import { runRoomPlannerConstruction } from "@/runtime/roomPlannerConstruction";
import { registerGlobalApi } from "@/runtime/creepApi";
import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";
import { refreshWorkerTasks } from "@/runtime/workerTaskPool";

mountAll();
registerGlobalApi();
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
  runAutoPlannerByFlag();
  runRoomPlannerConstruction();
  bootstrapRooms();
  refreshWorkerTasks();
  scheduleSpawnTasks();

  Object.values(Game.spawns).forEach((spawn) => spawn.work());
  Object.values(Game.creeps).forEach((creep) => creep.work());
}

export const loop = errorMapper(gameLoop);
