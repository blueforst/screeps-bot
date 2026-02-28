import { runAutoPlannerByFlag } from "@/modules/autoplanner";
import { runColonizationByFlag } from "@/runtime/colonization";
import { runCrossShardColonizationByFlag } from "@/runtime/crossShardColonization";

type FlagProcessor = () => void;

const processors: FlagProcessor[] = [runAutoPlannerByFlag, runColonizationByFlag, runCrossShardColonizationByFlag];

export function runFlagControl(): void {
  for (const processor of processors) {
    processor();
  }
}
