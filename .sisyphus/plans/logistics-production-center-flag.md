# Logistics Production Center HUB Flag

## TL;DR
> **Summary**: Add a single `HUB` flag-driven coordinator that centralizes military T3 production in one owned room, imports available source minerals, falls back to highest reachable intermediates when source minerals are incomplete, distributes finished T3 to owned rooms, and immediately offloads destination T3 from terminal to storage for defense safety.
> **Deliverables**:
> - `HUB` flag lifecycle and persistent `Memory.data.hubControl` state
> - Hardcoded military T3 chain data for `XUH2O`, `XKHO2`, `XLHO2`, `XGHO2`, `XZHO2`, `XLH2O`
> - Coordinator that writes ordered reaction plans into existing `synthesisControl`
> - Tagged, tracked inter-room transfer tasks for inbound minerals/intermediates and outbound T3
> - Destination terminal-to-storage carrier tasks for distributed T3
> - Jest TDD coverage for flag lifecycle, chain planning, fallback, cleanup, transfer guardrails, and offload
> **Effort**: Large
> **Parallel**: YES - 3 waves
> **Critical Path**: Task 1 → Task 2 → Task 4 → Task 6 → Task 8

## Context
### Original Request
User wants a flag that marks a room as logistics and production center, moves source/base minerals from other rooms to that room for synthesis/processing, then distributes synthesized T3 to rooms for strategic reserve.

### Interview Summary
- Flag semantics: use `HUB`; enforce a single owned-room production center.
- T3 scope: military-priority set plus repair/build boost: `XUH2O`, `XKHO2`, `XLHO2`, `XGHO2`, `XZHO2`, `XLH2O`.
- Reserve target: 1000 units per selected T3 compound per owned room.
- Non-HUB synthesis: disable HUB-managed compounds/intermediates in non-HUB rooms to avoid competition for source minerals, `X`, labs, and terminal cooldown.
- Flag removal: fully clean HUB config/runtime state and cancel HUB-related pending transfer tasks; do not kill creeps or force-reset active synthesis abruptly.
- Defensive storage rule: after T3 reaches a destination terminal, create carrier tasks to move it into storage because hostile power creep effects can block terminal withdrawals.
- Incomplete source-mineral rule: if participating logistics rooms cannot produce a target T3 because source minerals are missing, produce a capped amount of the highest reachable intermediate instead of deadlocking.
- Test strategy: TDD with Jest.

### Metis Review (gaps addressed)
- `synthesisControl` processes one reaction at a time from ordered `reactions[]`; HUB must write chain steps in correct dependency order.
- Transfer tasks cancel by ID, not reason; HUB must tag reasons and track created task IDs for cleanup.
- Existing terminal energy reserve must be respected; no HUB transfer should be knowingly unserviceable.
- `carrierTaskBoard` supports `fromKind: "terminal"` and `toKind: "storage"`; use producer string `hubControl` for destination offload tasks.
- `main.ts` order means HUB changes to synthesis config affect the next tick; acceptable but must be documented.
- Source-mineral incompleteness needs explicit fallback: produce highest reachable intermediate from available source minerals, capped at 1000 per compound at HUB.

## Work Objectives
### Core Objective
Implement a safe, single-HUB orchestration layer that coordinates existing terminal transfer, synthesis, and carrier task systems without adding new creep roles or rebuilding lab control.

### Deliverables
- New `src/runtime/productionHub.ts` coordinator module.
- `HUB` flag registration in `src/runtime/flagControl.ts`.
- `hubControl` execution in `src/main.ts` after `resourceControl` and before telemetry/cleanup.
- `Memory.data.hubControl` and config/runtime type additions in `src/global.d.ts`.
- Minimal resource transfer cleanup helper if required by implementation, or task-ID cleanup using existing `cancelResourceTransferTask`.
- Jest tests, written first, covering all acceptance criteria below.

### Definition of Done (verifiable conditions with commands)
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- `npm run build` passes.
- New tests prove `HUB` can import available inputs, generate ordered chain plans, fall back to reachable intermediates, distribute T3, offload T3 terminal→storage, and clean up when flag is removed.

### Must Have
- Single `HUB` flag only; reject duplicates with a console warning.
- HUB room must be owned; lost/unowned HUB room triggers cleanup.
- Use existing `resourceTransferTasks` for room-to-room movement.
- Use existing `synthesisControl` for lab execution by writing ordered reaction plans.
- Use existing `carrierTaskBoard` with producer `hubControl` for destination T3 offload.
- All HUB-created transfer tasks use reason prefix `hub:` and are tracked by task ID in `Memory.data.hubControl`.
- Destination T3 is counted as safely reserved only when in storage, not terminal.
- Highest-reachable intermediate fallback when source minerals are incomplete.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do not add market buying/selling.
- Do not add boost application/creep boosting automation.
- Do not add multi-HUB coordination.
- Do not add a new creep role.
- Do not build a generic reaction graph solver; hardcode the six selected chains.
- Do not force-reset or delete active synthesis runtime mid-reaction; let existing synthesis cleanup/unload paths handle contamination.
- Do not treat T3 in terminal as strategic reserve.
- Do not create transfer tasks that would knowingly violate terminal energy reserve or donor floors.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD / Jest (`npm run test`) + TypeScript (`npx tsc --noEmit`) + Rollup build (`npm run build`)
- QA policy: Every task has agent-executed scenarios
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 TDD specification, Task 2 static chain/types, Task 3 transfer/offload integration research and helper tests
Wave 2: Task 4 core coordinator, Task 5 flag lifecycle/cleanup, Task 6 synthesis config and fallback orchestration
Wave 3: Task 7 terminal-to-storage offload + main integration, Task 8 full verification/fixes

### Dependency Matrix (full, all tasks)
- Task 1 blocks Tasks 4-8.
- Task 2 blocks Tasks 4 and 6.
- Task 3 blocks Tasks 4, 5, and 7.
- Task 4 blocks Tasks 5, 6, and 7.
- Task 5 blocks Task 8.
- Task 6 blocks Task 8.
- Task 7 blocks Task 8.
- Task 8 blocks final verification wave.

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 3 tasks → quick, deep, quick
- Wave 2 → 3 tasks → deep, quick, deep
- Wave 3 → 2 tasks → quick, unspecified-high

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add RED Jest coverage for HUB contract

  **What to do**: Create `src/runtime/productionHub.test.ts` before implementation. Follow local factory style from `src/runtime/resourceControl.test.ts`, `src/runtime/synthesisControl.test.ts`, and flag tests. Cover these exact acceptance cases: no-op without `HUB`; owned `HUB` initializes `Memory.data.hubControl`; duplicate `HUB` rejected; unowned/lost HUB cleans up; inbound mineral transfer respects donor floor and terminal energy reserve; ordered chain output for all six selected T3 compounds; missing source minerals falls back to highest reachable intermediate; HUB surplus T3 creates outbound transfer; destination terminal T3 creates terminal→storage carrier task; destination terminal T3 absent creates no task; flag removal cancels tracked HUB tasks and clears state; flag removal does not kill creeps or force-reset active synthesis; lab shortage skips synthesis with warning; idempotent double-run; backlog cap prevents sixth pending HUB task.
  **Must NOT do**: Do not implement production logic in this task beyond minimal exports/stubs needed to make tests compile. Do not add brittle tests requiring exact console message wording except stable prefixes like `[hub]`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused test file creation using established Jest mock patterns.
  - Skills: [`superpowers:test-driven-development`] - Needed because tests must be written before implementation.
  - Omitted: [`frontend-ui-ux`] - No UI/browser work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: Tasks 4, 5, 6, 7, 8 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/resourceControl.test.ts:17` - local `createRoom` factory style and terminal/storage resource assertions.
  - Pattern: `src/runtime/resourceControl.test.ts:212` - existing `terminal_offload` test shape with `fromKind: "terminal"`, `toKind: "storage"`.
  - Pattern: `src/runtime/synthesisControl.test.ts:111` - manual synthesis reaction config assertions.
  - Pattern: `src/runtime/crossShardColonization.test.ts:54` - local `createFlag` mock factory.
  - API/Type: `src/runtime/carrierTaskBoard.ts:1` - allowed carrier task types include `terminal_offload`.
  - API/Type: `src/runtime/carrierTaskBoard.ts:6` - `fromKind` supports `terminal`; `toKind` supports `storage`.
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts:90` - `createResourceTransferTask` API.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- productionHub.test.ts` fails initially for missing implementation, then passes after subsequent tasks.
  - [ ] Tests include exact room names `W1N1` for HUB, `W2N2` and `W3N3` for non-HUB donors/receivers.
  - [ ] Tests include exact resource examples: `5000 RESOURCE_UTRIUM`, `5000 RESOURCE_HYDROGEN`, `5000 RESOURCE_OXYGEN`, `2000 RESOURCE_CATALYST`, `1500 RESOURCE_CATALYZED_UTRIUM_ACID`.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: RED test contract exists
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts` after adding tests and before implementation.
    Expected: Command fails only because productionHub exports/behavior are missing; syntax/type errors in the test itself are fixed.
    Evidence: .sisyphus/evidence/task-1-red-tests.txt

  Scenario: Test isolation
    Tool: Bash
    Steps: Run `npm run test -- resourceControl.test.ts synthesisControl.test.ts productionHub.test.ts`.
    Expected: Existing resource/synthesis tests are not broken by test scaffolding; productionHub assertions are isolated by `beforeEach` resetting `Game`, `Memory`, and carrier task board.
    Evidence: .sisyphus/evidence/task-1-test-isolation.txt
  ```

  **Commit**: YES | Message: `test(hub): define production hub contract` | Files: [`src/runtime/productionHub.test.ts`]

- [x] 2. Add HUB memory types and hardcoded reaction chain data

  **What to do**: Add `Memory.data.hubControl` types to `src/global.d.ts`. Create static chain data in `src/runtime/productionHub.ts` (or a small local constant in that module) for exactly these chains and products:
  - `XUH2O`: `OH(H+O)`, `UH(U+H)`, `UH2O(UH+OH)`, `XUH2O(X+UH2O)`
  - `XKHO2`: `OH(H+O)`, `KO(K+O)`, `KHO2(KO+OH)`, `XKHO2(X+KHO2)`
  - `XLHO2`: `OH(H+O)`, `LO(L+O)`, `LHO2(LO+OH)`, `XLHO2(X+LHO2)`
  - `XGHO2`: `OH(H+O)`, `ZK(Z+K)`, `UL(U+L)`, `G(ZK+UL)`, `GO(G+O)`, `GHO2(GO+OH)`, `XGHO2(X+GHO2)`
  - `XZHO2`: `OH(H+O)`, `ZO(Z+O)`, `ZHO2(ZO+OH)`, `XZHO2(X+ZHO2)`
  - `XLH2O`: `OH(H+O)`, `LH(L+H)`, `LH2O(LH+OH)`, `XLH2O(X+LH2O)`
  Add exported pure helpers for tests: selected product list, chain lookup, source-mineral requirement discovery, ordered synthesis step generation, and highest-reachable-intermediate selection.
  **Must NOT do**: Do not build a dynamic graph solver. Do not make the T3 list configurable in v1. Do not assume `G` is mined directly; for `XGHO2`, produce `G` from `ZK + UL`.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: chain correctness is central and easy to get subtly wrong.
  - Skills: [] - Static TypeScript/data work only.
  - Omitted: [`superpowers:test-driven-development`] - Task 1 already establishes tests; this task implements to satisfy them.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: Tasks 4, 6 | Blocked By: none

  **References**:
  - API/Type: `src/global.d.ts:227` - global `Memory` declaration location.
  - API/Type: `src/global.d.ts:582` - existing `Memory.data.flagHauling` pattern for persistent flag state.
  - External: Screeps `REACTIONS` constants - reaction pairs listed above must match Screeps compound chemistry.
  - Research: Metis review directive - hardcode the six selected chains and avoid generic solver scope creep.

  **Acceptance Criteria**:
  - [ ] `Memory.data.hubControl` type includes per-flag state with `roomName`, `flagName`, `pos`, `createdAt`, `updatedAt`, `taskIds`, `disabledReactionsBackup`, and last warning/summary fields.
  - [ ] Pure chain tests prove each selected T3 has exact ordered products listed above.
  - [ ] Highest-reachable helper returns `UH` for `XUH2O` when `U` and `H` exist but `O`/`X` do not; returns `UH2O` when `U/H/O` exist but `X` does not; returns `XUH2O` when all inputs exist.
  - [ ] `XGHO2` helper requires `Z`, `K`, `U`, `L`, `O`, `H`, and `X` across its full chain.

  **QA Scenarios**:
  ```
  Scenario: Chain unit tests pass
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts -t chain`.
    Expected: All static chain and fallback tests pass with exact product order.
    Evidence: .sisyphus/evidence/task-2-chain-tests.txt

  Scenario: Type declarations compile
    Tool: Bash
    Steps: Run `npx tsc --noEmit`.
    Expected: No TypeScript errors from `global.d.ts` or productionHub exports.
    Evidence: .sisyphus/evidence/task-2-tsc.txt
  ```

  **Commit**: YES | Message: `feat(hub): define hub state and reaction chains` | Files: [`src/global.d.ts`, `src/runtime/productionHub.ts`, `src/runtime/productionHub.test.ts`]

- [x] 3. Implement transfer-task tracking and cleanup primitives

  **What to do**: In `productionHub.ts`, create helper functions that create resource transfer tasks with reason prefixes `hub:inbound:{resource}` and `hub:outbound:{resource}:{destRoom}`, then store returned task IDs in `Memory.data.hubControl[flagName].taskIds`. If existing `cancelResourceTransferTask(taskId)` is sufficient, use it; if tests need bulk cleanup, add a minimal helper in `src/runtime/logistics/resourceTransferTasks.ts` such as `cancelResourceTransferTasksByIds(ids: string[])`, not a broad reason scanner. Cap pending HUB tasks per room at 5. Respect existing terminal energy reserve of 20,000 and donor mineral floor of 2000 before task creation.
  **Must NOT do**: Do not scan and cancel unrelated tasks. Do not enqueue tasks if source terminal lacks enough energy above reserve. Do not create more than five pending HUB tasks for the same source or destination room.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused helper implementation with tests.
  - Skills: [] - No special skill required.
  - Omitted: [`frontend-ui-ux`] - No UI/browser work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: Tasks 4, 5, 7 | Blocked By: Task 1 recommended

  **References**:
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts:90` - create task API.
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts:152` - cancel task by ID API.
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts:198` - pending outgoing task count helper.
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts:209` - pending incoming task count helper.
  - Pattern: `src/runtime/resourceControl.ts:766` - terminal reserve/fee budget logic uses `room.terminalEnergyReserve`.

  **Acceptance Criteria**:
  - [ ] Creating an inbound HUB task stores the task ID in `Memory.data.hubControl.HUB.taskIds`.
  - [ ] Flag cleanup cancels tracked pending HUB task IDs and ignores already done/cancelled tasks safely.
  - [ ] Room with terminal energy `19500` creates no HUB transfer task.
  - [ ] Donor with `5000` mineral and floor `2000` creates a task amount no greater than `3000`.
  - [ ] A room with five pending HUB tasks receives no sixth task.

  **QA Scenarios**:
  ```
  Scenario: Task IDs are tracked and cancelled
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts -t "tracked"`.
    Expected: HUB-created task IDs are present before cleanup and pending tasks are cancelled after cleanup.
    Evidence: .sisyphus/evidence/task-3-task-tracking.txt

  Scenario: Transfer guardrails reject unsafe tasks
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts -t "reserve\|floor\|backlog"`.
    Expected: No transfer tasks violate terminal energy reserve, donor floor, or backlog cap.
    Evidence: .sisyphus/evidence/task-3-transfer-guardrails.txt
  ```

  **Commit**: YES | Message: `feat(hub): track hub transfer tasks safely` | Files: [`src/runtime/productionHub.ts`, `src/runtime/logistics/resourceTransferTasks.ts`, `src/runtime/productionHub.test.ts`]

- [x] 4. Implement core HUB state discovery, deficits, and inbound procurement

  **What to do**: Implement `runProductionHub()` core planning pass. It should discover the active HUB state from `Memory.data.hubControl`, read actual owned rooms from `Game.rooms`, compute resource availability from storage + terminal, compute safe reserve deficits using storage as the only final-safe T3 location, and create inbound tasks for source minerals/intermediates needed by selected chains. For outbound calculation, subtract storage amount plus destination terminal amount plus pending outbound amount to avoid duplicate sends, but only mark reserve satisfied when storage reaches 1000. Use actual game state every planning tick; do not maintain expected balances.
  **Must NOT do**: Do not send resources to unowned rooms. Do not drain HUB below its own production needs. Do not count terminal T3 as defensively safe reserve.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: central planning logic with multiple guardrails and state sources.
  - Skills: [] - Backend TypeScript logic.
  - Omitted: [`frontend-ui-ux`] - No UI/browser work.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: Tasks 5, 6, 7 | Blocked By: Tasks 1, 2, 3

  **References**:
  - Pattern: `src/runtime/resourceControl.ts:593` - create terminal feed tasks from room snapshots.
  - Pattern: `src/runtime/resourceControl.ts:629` - create terminal offload tasks from room snapshots.
  - Pattern: `src/runtime/synthesisControl.ts:785` - active synthesis plan chosen from ordered reactions.
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts:45` - sorted transfer task list for pending/in-flight accounting.

  **Acceptance Criteria**:
  - [ ] No HUB flag/state means `runProductionHub()` has zero side effects.
  - [ ] HUB with donor surplus creates inbound `hub:inbound:{resource}` task from donor to HUB.
  - [ ] Existing pending outbound task is counted so the same destination deficit is not overfilled.
  - [ ] Destination room with `1000 XUH2O` in storage receives no outbound task even if terminal is empty.
  - [ ] Destination room with `1000 XUH2O` only in terminal still creates offload work but no duplicate outbound send.

  **QA Scenarios**:
  ```
  Scenario: Inbound procurement
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts -t "inbound"`.
    Expected: Donor room `W2N2` with surplus `RESOURCE_UTRIUM` creates exactly one inbound task to HUB `W1N1` with reason prefix `hub:inbound:`.
    Evidence: .sisyphus/evidence/task-4-inbound.txt

  Scenario: Safe reserve accounting
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts -t "storage reserve"`.
    Expected: Storage T3 satisfies reserve; terminal T3 does not satisfy final safety but prevents duplicate outbound while offload is pending.
    Evidence: .sisyphus/evidence/task-4-reserve-accounting.txt
  ```

  **Commit**: YES | Message: `feat(hub): plan hub mineral procurement` | Files: [`src/runtime/productionHub.ts`, `src/runtime/productionHub.test.ts`]

- [x] 5. Implement `HUB` flag lifecycle, duplicate rejection, and cleanup

  **What to do**: Add `runProductionHubByFlag()` in `src/runtime/productionHub.ts` following the two-pass style of flag lifecycle modules: scan `Game.flags` for exact `HUB`, validate the flag room is visible and owned, upsert `Memory.data.hubControl.HUB`, reject duplicate HUB-like flags by preserving the first valid `HUB`, then reconcile stored state when the flag disappears or room becomes unowned. On cleanup, cancel tracked HUB transfer task IDs, remove HUB carrier tasks via `replaceCarrierTasksForProducerRoom("hubControl", roomName, [])` for affected rooms, restore non-HUB synthesis reactions from backup, and delete `Memory.data.hubControl.HUB`. Register processor in `src/runtime/flagControl.ts`.
  **Must NOT do**: Do not kill creeps. Do not remove unrelated transfer tasks. Do not delete synthesis runtime state while `synthesisControl` is mid-reaction; only remove HUB-authored config and let `synthesisControl` transition through its normal cleanup.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: flag lifecycle integration follows existing pattern.
  - Skills: [] - No special skill required.
  - Omitted: [`superpowers:test-driven-development`] - Tests already exist from Task 1; update only if implementation reveals missing case.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: Task 8 | Blocked By: Tasks 1, 3, 4

  **References**:
  - Pattern: `src/runtime/flagControl.ts:20` - `FlagProcessor` type.
  - Pattern: `src/runtime/flagControl.ts:22` - processor array registration point.
  - Pattern: `src/runtime/flagHauling.ts:221` - cleanup config lifecycle.
  - Pattern: `src/runtime/flagHauling.ts:257` - upsert config lifecycle.
  - Pattern: `src/runtime/flagHauling.ts:357` - flag scanning entrypoint.
  - API/Type: `src/runtime/carrierTaskBoard.ts:86` - producer-scoped carrier task replacement.

  **Acceptance Criteria**:
  - [ ] Owned `HUB` flag creates/updates `Memory.data.hubControl.HUB` with `roomName`, position, timestamps, and empty task ID list.
  - [ ] Duplicate HUB flags preserve the first valid HUB and emit a warning with `[hub]` prefix.
  - [ ] Removing `HUB` cancels tracked pending tasks, clears `Memory.data.hubControl.HUB`, clears `hubControl` carrier tasks, and restores backed-up non-HUB reactions.
  - [ ] Unowned or lost HUB room follows the same cleanup path and does not receive future inbound resources.
  - [ ] Active creeps are not killed and active synthesis runtime stage is not forcibly reset.

  **QA Scenarios**:
  ```
  Scenario: Flag upsert and duplicate rejection
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts -t "HUB flag"`.
    Expected: One owned HUB state exists; duplicate flag attempt logs warning and leaves original room unchanged.
    Evidence: .sisyphus/evidence/task-5-flag-upsert.txt

  Scenario: Flag removal cleanup
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts -t "flag removal"`.
    Expected: Task IDs cancelled, HUB state deleted, carrier tasks cleared, no creep suicide or synthesis runtime reset.
    Evidence: .sisyphus/evidence/task-5-flag-cleanup.txt
  ```

  **Commit**: YES | Message: `feat(hub): manage hub flag lifecycle` | Files: [`src/runtime/productionHub.ts`, `src/runtime/flagControl.ts`, `src/runtime/productionHub.test.ts`]

- [x] 6. Write ordered synthesis plans and highest-reachable fallback into `synthesisControl` config

  **What to do**: Add HUB synthesis orchestration that edits `Memory.cfg.synthesisControl.rooms[hubRoom].reactions` only for HUB-managed products. For each selected T3, determine the highest product reachable from current HUB stock plus importable source minerals/intermediates across participating owned rooms. If all source inputs exist, include ordered chain steps through T3 with `targetAmount: 1000` for final T3 and intermediate targets sufficient to support final production. If a source mineral is missing, include steps only up to the highest reachable intermediate and cap each fallback intermediate at 1000 in HUB storage/terminal. Disable HUB-managed products/intermediates in non-HUB rooms by removing them from their `reactions[]` and backing them up in `Memory.data.hubControl.HUB.disabledReactionsBackup` for restoration.
  **Must NOT do**: Do not overwrite unrelated user-defined reactions in the HUB room unless they are one of the HUB-managed chain products. Do not remove non-HUB reactions unrelated to these six chains. Do not start a T3 plan requiring `X` when no `X` exists or is importable.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: complex interaction with existing sequential synthesis planner.
  - Skills: [] - Backend TypeScript logic.
  - Omitted: [`frontend-ui-ux`] - No UI/browser work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: Task 8 | Blocked By: Tasks 1, 2, 4

  **References**:
  - Pattern: `src/runtime/synthesisControl.ts:216` - reaction config normalization.
  - Pattern: `src/runtime/synthesisControl.ts:785` - `chooseActivePlan` iterates `reactions[]` in order.
  - Pattern: `src/runtime/synthesisControl.ts:987` - plan change detection resets stage to acquiring through normal path.
  - Pattern: `src/runtime/synthesisControl.ts:1020` - contamination transitions to unloading.
  - Pattern: `src/runtime/synthesisControl.ts:1046` - unloading returns to loading once clean.

  **Acceptance Criteria**:
  - [ ] `XUH2O` chain is written as `[OH, UH, UH2O, XUH2O]`, never with T3 first.
  - [ ] `XGHO2` chain includes `[OH, ZK, UL, G, GO, GHO2, XGHO2]`.
  - [ ] Missing `X` but available lower inputs produces T2 fallback target (for example `UH2O`) capped at 1000.
  - [ ] Missing `O` for `XUH2O` but available `U/H` produces `UH` fallback capped at 1000.
  - [ ] Missing enough source minerals for any step creates no synthesis plan and logs a `[hub]` warning without blocking other targets.
  - [ ] Non-HUB `reactions[]` entries for HUB-managed products are removed and backed up; unrelated reactions remain untouched.
  - [ ] Removing HUB restores backed-up non-HUB reactions exactly once and idempotently.

  **QA Scenarios**:
  ```
  Scenario: Full T3 ordered plan
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts -t "ordered synthesis"`.
    Expected: HUB synthesis config contains chain products in dependency order for all six target compounds.
    Evidence: .sisyphus/evidence/task-6-ordered-plan.txt

  Scenario: Missing source mineral fallback
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts -t "highest reachable"`.
    Expected: With incomplete source minerals, HUB writes capped intermediate reactions only and does not attempt unreachable T3.
    Evidence: .sisyphus/evidence/task-6-fallback.txt
  ```

  **Commit**: YES | Message: `feat(hub): orchestrate hub synthesis chains` | Files: [`src/runtime/productionHub.ts`, `src/runtime/productionHub.test.ts`]

- [x] 7. Add defensive destination T3 terminal-to-storage offload and main-loop integration

  **What to do**: Add destination room carrier tasks through `replaceCarrierTasksForProducerRoom("hubControl", roomName, drafts)`. For each selected T3 in a non-HUB owned room terminal, create `terminal_offload` task from terminal to storage for the exact terminal amount, capped by storage free capacity if available. Use IDs like `hubControl:terminal_offload:{roomName}:{resource}`. Count T3 as safe reserve only after it reaches storage. Import and run `runProductionHub` in `src/main.ts` after `resourceControl` and before `externalTelemetryExport` with `cpuProfiler.measure("hubControl", runProductionHub)`. Register `runProductionHubByFlag` in `flagControl.ts` if not already done in Task 5.
  **Must NOT do**: Do not leave T3 in terminal as the intended final state. Do not create offload tasks for non-selected resources. Do not overwrite carrier tasks from other producers.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused carrier task and main-loop wiring.
  - Skills: [] - No special skill required.
  - Omitted: [`frontend-ui-ux`] - No UI/browser work.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: Task 8 | Blocked By: Tasks 1, 3, 4

  **References**:
  - API/Type: `src/runtime/carrierTaskBoard.ts:1` - `terminal_offload` task type.
  - API/Type: `src/runtime/carrierTaskBoard.ts:6` - terminal to storage step kinds.
  - Pattern: `src/runtime/resourceControl.ts:641` - terminal offload task ID and fields.
  - Pattern: `src/runtime/boostControl.ts:161` - T3 boost terminal offload task for defense compound.
  - Pattern: `src/main.ts:56` - `synthesisControl` phase.
  - Pattern: `src/main.ts:58` - `resourceControl` phase.
  - Pattern: `src/main.ts:59` - insert `hubControl` before `externalTelemetryExport`.

  **Acceptance Criteria**:
  - [ ] Destination `W2N2` terminal with `800 XUH2O` and storage with `0 XUH2O` creates one `terminal_offload` carrier task to storage.
  - [ ] Destination terminal with no selected T3 creates no `hubControl` carrier tasks.
  - [ ] Destination storage with `1000 XUH2O` satisfies reserve after offload; terminal-only amount does not satisfy final reserve assertion.
  - [ ] `runProductionHub` is measured as `hubControl` in `main.ts` after `resourceControl` and before `externalTelemetryExport`.
  - [ ] Carrier task replacement only affects producer `hubControl`, leaving `resourceControl` and `synthesisControl` tasks intact.

  **QA Scenarios**:
  ```
  Scenario: Defensive T3 offload
    Tool: Bash
    Steps: Run `npm run test -- productionHub.test.ts -t "terminal.*storage"`.
    Expected: Selected T3 in destination terminal generates terminal→storage offload task with exact resource and amount.
    Evidence: .sisyphus/evidence/task-7-offload.txt

  Scenario: Main loop integration
    Tool: Bash
    Steps: Run `npm run test -- main.test.ts productionHub.test.ts`.
    Expected: Main loop imports/runs HUB without breaking existing tick orchestration tests.
    Evidence: .sisyphus/evidence/task-7-main-loop.txt
  ```

  **Commit**: YES | Message: `feat(hub): offload distributed t3 to storage` | Files: [`src/runtime/productionHub.ts`, `src/main.ts`, `src/runtime/flagControl.ts`, `src/runtime/productionHub.test.ts`]

- [x] 8. Add memory cleanup, run full verification, and fix regressions

  **What to do**: Add stale HUB cleanup to `src/runtime/memoryCleanup.ts` so state is pruned for unowned rooms and stale tracked task IDs are removed. Run the full verification suite and fix only issues directly related to HUB work. Confirm no existing HAUL, synthesis, resource control, boost control, or carrier behavior regressed.
  **Must NOT do**: Do not broaden scope into market buying, auto-boosting, or multi-HUB. Do not reorder existing main loop phases beyond the single `hubControl` insertion.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: full-system verification and regression repair.
  - Skills: [] - Verification-focused.
  - Omitted: [`frontend-ui-ux`] - No UI/browser work.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: Final Verification Wave | Blocked By: Tasks 1-7

  **References**:
  - Pattern: `src/runtime/memoryCleanup.test.ts:33` - memory cleanup test structure.
  - Pattern: `src/main.ts:53` through `src/main.ts:72` - behavior-critical tick order.
  - Project command: `npm run test` - full Jest suite.
  - Project command: `npx tsc --noEmit` - TypeScript verification.
  - Project command: `npm run build` - Rollup build verification.

  **Acceptance Criteria**:
  - [ ] `memoryCleanup` removes HUB state for rooms no longer owned.
  - [ ] `npm run test` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `npm run build` passes.
  - [ ] Existing `flagHauling`, `resourceControl`, `synthesisControl`, `boostControl`, and carrier tests still pass.
  - [ ] Evidence files are saved under `.sisyphus/evidence/` for test, tsc, and build outputs.

  **QA Scenarios**:
  ```
  Scenario: Full automated verification
    Tool: Bash
    Steps: Run `npm run test`, then `npx tsc --noEmit`, then `npm run build`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-8-full-verification.txt

  Scenario: Regression focus suite
    Tool: Bash
    Steps: Run `npm run test -- flagHauling.test.ts resourceControl.test.ts synthesisControl.test.ts boostControl.test.ts carrier.test.ts productionHub.test.ts`.
    Expected: Existing logistics and synthesis behavior remains green with HUB tests.
    Evidence: .sisyphus/evidence/task-8-regression-suite.txt
  ```

  **Commit**: YES | Message: `test(hub): verify hub cleanup and regressions` | Files: [`src/runtime/memoryCleanup.ts`, `src/runtime/memoryCleanup.test.ts`, `src/runtime/productionHub.test.ts`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle (APPROVED after flag naming + double execution fix)
- [x] F2. Code Quality Review — unspecified-high (APPROVED with minor findings)
- [x] F3. Real Manual QA — unspecified-high (APPROVED — all 6 scenarios pass)
- [x] F4. Scope Fidelity Check — deep (APPROVED — no scope creep, no missing items)

## Commit Strategy
- Do not commit unless the user explicitly asks.
- Suggested atomic commits if requested after verification:
  1. `test(hub): cover production hub flag logistics`
  2. `feat(hub): add production hub coordinator`
  3. `feat(hub): integrate hub flag and defensive offload`

## Success Criteria
- `HUB` flag can safely designate exactly one production center.
- Source/base minerals and existing intermediates flow toward HUB without draining donors below floors.
- HUB produces configured T3 when all inputs exist.
- HUB produces capped highest-reachable intermediates when source minerals are incomplete.
- Finished T3 is sent to rooms below reserve and moved from terminal to storage.
- Removing `HUB` cleans HUB state and pending HUB tasks without killing creeps or corrupting synthesis state.
- All required Jest, TypeScript, and build verification commands pass.
