import { BUILD_INFO } from "@/buildMeta";
import { errorMapper } from "@/modules/errorMapper";
import { mountAll } from "@/mount";
import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { runInterShardControl } from "@/runtime/interShardControl";
import { runCrossShardSignals } from "@/runtime/crossShardSignals";
import { runPixelGenerator } from "@/runtime/pixelGenerator";
import { runPortalDiscovery } from "@/runtime/portalDiscovery";
import { registerProductionApi, runProductionMonitor } from "@/runtime/productionMonitor";
import { runResourceControl } from "@/runtime/resourceControl";
import { runSynthesisControl } from "@/runtime/synthesisControl";
import { runMineralExtraction } from "@/runtime/mineralExtraction";
import { runExternalTelemetryExport } from "@/runtime/externalTelemetry";
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
import { createTickCpuProfiler, setActiveTickCpuProfiler } from "@/runtime/cpuPhaseProfiler";

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
  const cpuProfiler = createTickCpuProfiler();
  setActiveTickCpuProfiler(cpuProfiler);

  cpuProfiler.measure("announceDeploy", announceDeploy);
  cpuProfiler.measure("pixelGenerator", runPixelGenerator);
  cpuProfiler.measure("productionMonitor", runProductionMonitor);
  cpuProfiler.measure("synthesisControl", runSynthesisControl);
  cpuProfiler.measure("mineralExtraction", runMineralExtraction);
  cpuProfiler.measure("resourceControl", runResourceControl);
  cpuProfiler.measure("externalTelemetryExport", runExternalTelemetryExport);
  cpuProfiler.measure("memoryCleanup", runMemoryCleanup);
  cpuProfiler.measure("portalDiscovery", runPortalDiscovery);
  cpuProfiler.measure("flagControl", runFlagControl);
  cpuProfiler.measure("crossShardSignals", runCrossShardSignals);
  cpuProfiler.measure("interShardControl", runInterShardControl);
  cpuProfiler.measure("warControl", runWarControl);
  cpuProfiler.measure("roomPlannerConstruction", runRoomPlannerConstruction);
  cpuProfiler.measure("linkControl", runLinkControl);
  cpuProfiler.measure("coreDefense", runCoreDefense);
  cpuProfiler.measure("towerControl", runTowerControl);
  cpuProfiler.measure("refreshWorkerTasks", refreshWorkerTasks);
  cpuProfiler.measure("bootstrapRooms", bootstrapRooms);
  cpuProfiler.measure("scheduleSpawnTasks", scheduleSpawnTasks);

  cpuProfiler.measure("spawnWork", () => {
    Object.values(Game.spawns).forEach((spawn) => spawn.work());
  });
  cpuProfiler.measure("creepWork", () => {
    Object.values(Game.creeps).forEach((creep) => creep.work());
  });
  cpuProfiler.flush();
}

export const loop = errorMapper(gameLoop);
