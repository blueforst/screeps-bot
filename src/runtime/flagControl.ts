import { runAutoPlannerByFlag } from "@/modules/autoplanner";
import { runColonizationByFlag } from "@/runtime/colonization";

type FlagProcessor = () => void;

const processors: FlagProcessor[] = [runAutoPlannerByFlag, runColonizationByFlag];

export function runFlagControl(): void {
  for (const processor of processors) {
    processor();
  }
}
