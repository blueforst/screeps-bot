import { errorMapper } from "@/modules/errorMapper";
import { runAutoPlannerByFlag } from "@/modules/autoplanner";
import { mountAll } from "@/mount";
import { bootstrapRooms } from "@/runtime/bootstrap";
import { registerGlobalApi } from "@/runtime/creepApi";
import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";

mountAll();
registerGlobalApi();

export function addNumbers(num1: number, num2: number): number {
  return num1 + num2;
}

function gameLoop(): void {
  runAutoPlannerByFlag();
  bootstrapRooms();
  scheduleSpawnTasks();

  Object.values(Game.spawns).forEach((spawn) => spawn.work());
  Object.values(Game.creeps).forEach((creep) => creep.work());
}

export const loop = errorMapper(gameLoop);
