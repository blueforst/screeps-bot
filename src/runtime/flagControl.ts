import { runAutoPlannerByFlag, savePlannerForRoom } from "@/modules/autoplanner";
import { placeProtoSourceContainersForRoom } from "@/runtime/roomPlannerConstruction";
import { runColonizationByFlag } from "@/runtime/colonization";
import { runCrossShardColonizationByFlag } from "@/runtime/crossShardColonization";
import { runRescueByFlag } from "@/runtime/rescue";
import { runScoutByFlag } from "@/runtime/scoutFlag";

function runSavePlannerByFlag(): void {
  const saveFlag = Game.flags.SP;
  if (!saveFlag) return;
  const roomName = saveFlag.pos.roomName;
  if (savePlannerForRoom(roomName)) {
    placeProtoSourceContainersForRoom(roomName);
    saveFlag.remove();
  }
}

type FlagProcessor = () => void;

const processors: FlagProcessor[] = [runAutoPlannerByFlag, runSavePlannerByFlag, runColonizationByFlag, runCrossShardColonizationByFlag, runRescueByFlag, runScoutByFlag];

export function runFlagControl(): void {
  for (const processor of processors) {
    processor();
  }
}
