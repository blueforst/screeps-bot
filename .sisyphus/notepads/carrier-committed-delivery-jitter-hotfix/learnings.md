
## Session: Committed-delivery guard implementation

### Root cause confirmed
`pendingStepId` expires when `synthesisCarrierPendingPickupTick` is older than `Game.time - 1`. The snapshot fallback (lines 616-646) is nested inside `if (pendingStepId)`, so when pendingStepId is falsy, the entire snapshot path is skipped and the carrier falls through to generic cleanup which routes to terminal/storage.

### Guard placement
Added at top of `deliverSynthesisCarrierResource()`, before pendingStepId calculation. Checks: snapshot toId exists, snapshot resource exists, creep store has that resource. Resolves target, transfers/moves, clears snapshot on success or fallthrough.

### Test mock fixes required
- Test 1 ("stale committed"): Store mock was static (always returned 100). Fixed to use a dynamic `staleCarried` variable connected to the transfer mock, so `done = true` is achievable after transfer.
- Test 2 ("multi-tick"): Already had `transferRangeOK` flag for simulating out-of-range at tick N+1 and OK at tick N+2. The `tick1Done` assertion was already corrected to `false`. No changes needed for test 2.
