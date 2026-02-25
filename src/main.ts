import { BUILD_INFO } from "@/buildMeta";
import { errorMapper } from "@/modules/errorMapper";
import { runAutoPlannerByFlag } from "@/modules/autoplanner";
import { mountAll } from "@/mount";
import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { runPixelGenerator } from "@/runtime/pixelGenerator";
import { bootstrapRooms } from "@/runtime/bootstrap";
import { runRoomPlannerConstruction } from "@/runtime/roomPlannerConstruction";
import { registerGlobalApi } from "@/runtime/creepApi";
import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";
import { refreshWorkerTasks } from "@/runtime/workerTaskPool";

mountAll();
registerGlobalApi();

function announceDeploy(): void {
  if (Memory.lastDeployTag === BUILD_INFO.tag) {
    return;
  }

  Memory.lastDeployTag = BUILD_INFO.tag;
  console.log(`[deploy] ${BUILD_INFO.tag}`);
}

export function addNumbers(num1: number, num2: number): number {
  return num1 + num2;
}

function gameLoop(): void {
  announceDeploy();
  runPixelGenerator();
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
