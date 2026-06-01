/**
 * Generic production stage helpers. Pure functions with no dependency on Memory
 * shape or specific producer business logic. Consumers apply them to their own
 * state objects.
 */

export function updateTransitionAt(state: { lastTransitionAt: number }, currentTick: number): void {
  state.lastTransitionAt = currentTick;
}

export function markLoadingStart(state: { loadingSinceTick?: number }, currentTick: number): void {
  if (!state.loadingSinceTick) {
    state.loadingSinceTick = currentTick;
  }
}

export function clearLoadingSince(state: { loadingSinceTick?: number }): void {
  state.loadingSinceTick = undefined;
}

export function isLoadingTimedOut(
  loadingSinceTick: number | undefined,
  currentTick: number,
  timeoutTicks: number,
): boolean {
  if (!loadingSinceTick) return false;
  return currentTick - loadingSinceTick > timeoutTicks;
}

export function isStageBlocked(stage: string): boolean {
  return stage === "blocked";
}

export function isStageIdle(stage: string): boolean {
  return stage === "idle" || stage === "sleeping";
}

/**
 * Whether current inventory satisfies the target at LAB_REACTION_AMOUNT granularity.
 * A small remainder (< one reaction batch) counts as satisfied when current > 0.
 */
export function isTargetSatisfiedByReactionGranularity(current: number, targetAmount: number): boolean {
  return current >= targetAmount || (current > 0 && targetAmount - current < LAB_REACTION_AMOUNT);
}
