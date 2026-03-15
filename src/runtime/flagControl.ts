import { runAutoPlannerByFlag } from "@/modules/autoplanner";
import { runColonizationByFlag } from "@/runtime/colonization";
import { runCrossShardColonizationByFlag } from "@/runtime/crossShardColonization";
import { runRescueByFlag } from "@/runtime/rescue";
import { runScoutByFlag } from "@/runtime/scoutFlag";

type FlagProcessor = () => void;

const processors: FlagProcessor[] = [runAutoPlannerByFlag, runColonizationByFlag, runCrossShardColonizationByFlag, runRescueByFlag, runScoutByFlag];

export function runFlagControl(): void {
  for (const processor of processors) {
    processor();
  }
}
