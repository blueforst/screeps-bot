import { runPowerBankObserver } from "@/runtime/powerBankObserver";
import { reconcileRemoteMiningVisionScouts } from "@/runtime/remoteMining";

/** The production dispatch phase: one Observer scheduler followed by pure-vision fallback reconciliation. */
export function runPowerBankVisionDispatch(): void {
  runPowerBankObserver();
  reconcileRemoteMiningVisionScouts();
}
