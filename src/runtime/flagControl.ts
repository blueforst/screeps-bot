import { runAutoPlannerByFlag } from "@/modules/autoplanner";
import { runColonizationByFlag } from "@/runtime/colonization";
import { runCrossShardColonizationByFlag } from "@/runtime/crossShardColonization";
import { runRescueByFlag } from "@/runtime/rescue";

type FlagProcessor = () => void;

const processors: FlagProcessor[] = [runAutoPlannerByFlag, runColonizationByFlag, runCrossShardColonizationByFlag, runRescueByFlag];

export function runFlagControl(): void {
  for (const processor of processors) {
    processor();
  }
}
