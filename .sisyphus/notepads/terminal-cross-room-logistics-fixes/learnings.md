# Learnings

## 2026-05-09 Session Start
- Core files: `src/runtime/resourceControl.ts` (~1205 lines), `src/runtime/logistics/resourceTransferTasks.ts` (~243 lines)
- Test file: `src/runtime/resourceControl.test.ts` covers feed/offload/market but NOT executeTransferTasks failure paths
- `resourceTransferTasks.ts` has NO dedicated test file yet
- Main tick order: `runSynthesisControl` → `runResourceControl` — must NOT change
- `terminalBusy` is local to `runResourceControl()` — auto-balance sets it, executeTransferTasks reads it
- Synthesis binding deduplication is real but OUT OF SCOPE for this plan

## 2026-05-09 resourceTransferTasks.test.ts
- Created `src/runtime/logistics/resourceTransferTasks.test.ts` — 49 tests covering all pure task-store exports
- Test pattern: `resetRuntimeServices()` + `Memory.data = undefined` in `beforeEach` is sufficient for task-store isolation (no need to mock rooms/terminals)
- `createResourceTransferTask` uses module-level `taskIdSequence`/`taskIdSequenceTick` — tests that change `Game.time` between calls will reset the sequence
- Merge logic: same from/to/resource/reason → amount merge; any field difference → new task
- `cleanupResourceTransferTaskStore` removes tasks when sourceOrTargetLost OR terminalStale (pending tasks are never stale)
- `cleanupResourceTransferTaskStore` also deletes `Memory.data.resourceControl` when last task removed

## 2026-05-09 Survival room native mineral auto-sell exclusion
- Room states: "survival" (storageEnergy < energyFloor 120k), "balanced", "export" (storageEnergy >= energyExportStart 250k)
- `applyMarketOps` filter chain: terminal cooldown → (NEW) state !== "survival" → export or native mineral surplus
- Fix: Added `.filter((snapshot) => snapshot.state !== "survival")` before the export/surplus filter
- This prevents survival rooms from spending terminal energy on market fees
- Test: survival room with 50k storage energy + keanium surplus → no `Game.market.deal` call
- Existing tests for balanced/export rooms still pass (17/17 total)

## 2026-05-09 Final flush for below-minimum transfer remainder
- Replaced permanent `"failed"` with `lastError: "remaining_below_transfer_min"` → final flush logic in `executeTransferTasks`
- When `remainingAmount < transferMinAmount`: check terminal resource + fee budget → send remainder (final flush), or keep `"pending"` with `lastError: "waiting_for_final_flush"`
- Fee calculation for final flush mirrors `computeSendAmount` pattern: energy resources need `amount + fee` in terminal, non-energy needs just `fee`
- Uses `getEnergyAvailableForFees(donor)` which is `terminalEnergy - terminalEnergyReserve`
- Did NOT modify `computeSendAmount` — that function handles normal batch sends only
- Test pattern: manipulate `result.task.remainingAmount` after `createResourceTransferTask` to simulate partial sends
- 5 new test cases: final flush success, waiting for resource, waiting for fee, normal batch unaffected, cooldown bypass
- All 24 tests pass (19 existing + 5 new)

## 2026-05-09 Auto-balance donor starvation fix
- `applyInternalBalancing` runs before `executeTransferTasks` in `runResourceControl`; both share a `terminalBusy` set
- Problem: auto-balance sends energy → donor added to `terminalBusy` → mineral transfer task skipped for that tick
- Fix: skip donor in `applyInternalBalancing` if `countPendingOutgoingResourceTransferTasksByRoom(donor.roomName) > 0`
- `countPendingOutgoingResourceTransferTasksByRoom` was already imported in `resourceControl.ts` (line 5)
- Only pending tasks trigger the skip; completed/failed/cancelled tasks do not
- Test pattern: check `donor.terminal.send` mock for auto-balance description string
- Default thresholds: energyFloor=120k (survival), energyExportStart=250k (export), terminalEnergyReserve=20k
- All 24 tests pass including 2 new ones (donor starvation + regression)

## 2026-05-09 executeTransferTasks failure/retry test coverage
- Added 16 new tests in `describe("executeTransferTasks failure and retry paths")` — all 41 tests now pass
- Key test patterns discovered:
  - Rooms without terminals must use `as unknown as Room` cast (TS2352 on direct `as Room`)
  - `runResourceControl()` creates snapshots via `collectResourceControlSnapshots()` which filters `Game.rooms` for rooms with `controller.my` and a terminal
  - If a room isn't in snapshots (no terminal), `!donor || !receiver` → task.status = "failed", lastError = "room_not_ready"
  - Terminal cooldown: just `continue` (no lastError set), task stays pending
  - Same-room tasks: `createResourceTransferTask` blocks creation, must inject via `ensureResourceTransferTaskStore()` directly
  - Fee-halving: `computeSendAmount` halves candidate until fee fits within `getEnergyAvailableForFees(donor)` (terminalEnergy - terminalEnergyReserve)
  - `terminalBusy` set causes all tasks from same donor to be skipped after the first successful send
  - `taskMaxPerRun` (default 1, max 5) limits `executed` counter — but `terminalBusy` often binds first
  - Permanent errors: ERR_INVALID_ARGS (-10), ERR_INVALID_TARGET (-7) → status "failed"
  - Retryable errors: ERR_BUSY (-4), ERR_NOT_ENOUGH_RESOURCES (-6) → stays pending with lastError
  - `ensureResourceTransferTaskStore` already imported in test file — can be used directly for assertions
  - `findTask` helper pattern: filters `Object.values(ensureResourceTransferTaskStore())` by fromRoomName/toRoomName

## T-hardened-cleanup-resourceTransferTaskStore

- `Memory.data.resourceControl` currently only holds `tasks` — no other code writes sibling fields there. Safe-delete pattern is future-proofing.
- Cleanup pattern: delete the `tasks` sub-key first, then check `Object.keys(rc).length === 0` before deleting the parent. Two-step deletion avoids wiping sibling data.
- The existing regression test ("deletes resourceControl from Memory.data when last task is removed") covers the no-sibling case; added a new test for the sibling-present case.
- Test count went from 49 → 51 (2 new tests added to cleanupResourceTransferTaskStore describe block).
