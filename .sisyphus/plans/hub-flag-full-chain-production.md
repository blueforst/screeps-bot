# HUB Flag Full-Chain T3 Production Center

## TL;DR
> **Summary**: Add a `HUB` flag and full-chain production planner so one owned hub room pulls surplus/base/intermediate resources from satellite rooms, drives existing lab synthesis toward five war-core T3 reserves, and redistributes finished T3 to each eligible room's storage.
> **Deliverables**:
> - `HUB` flag setup writing `Memory.cfg.hub.hubRoomName` from the flag room and removing the flag.
> - New hub planning runtime that runs before `synthesisControl`, computes resource shortages, plans 19-step T3 reaction chains, reclaims surplus compounds/intermediates, and creates transfer tasks through existing terminal logistics.
> - TDD coverage for flag setup, chain accounting, import/reclaim/distribution task creation, blocked states, resourceControl interference guards, and full integration flow.
> **Effort**: Large
> **Parallel**: YES - 4 waves
> **Critical Path**: Task 1 → Task 3 → Task 4 → Task 6 → Task 8 → Final Verification

## Context
### Original Request
- User asked: “检查hub flag是否已经可以用于实战”.
- Exploration found no literal `HUB`/`hub` flag implementation; existing `HAUL` flag is production-ready for remote hauling, but it is not storage/production hub orchestration.

### Interview Summary
- HUB means a shared production center: other rooms send base resources through terminals to the hub, hub synthesizes T3, then distributes T3 to room storage for emergency war.
- First version scope is full-chain production.
- War-core T3 set: `XGHO2`, `XGH2O`, `XUH2O`, `XUHO2`, `XLHO2`.
- Target reserve: `1000` units of each selected T3 in each eligible room storage.
- Eligible rooms: owned rooms with both storage and terminal; exclude the hub room from outbound T3 distribution.
- Market strategy: internal resources only; do not auto-buy missing minerals in first version.
- HUB designation: placing `HUB` flag in an owned room writes `Memory.cfg.hub.hubRoomName = flag.pos.roomName`, then consumes/removes the flag.
- Extra requirement: satellite rooms with surplus T3 or intermediate compounds should send them to the hub; hub inventory should reuse reclaimed resources before producing more and then redistribute finished reserves.
- Test strategy: TDD.

### Metis Review (gaps addressed)
- Hub planning must run before `runSynthesisControl`; `flagControl` runs after synthesis and is only suitable for setup.
- Use `synthesisControl` as the sole lab executor; do not create a second reaction runner.
- Use existing `resourceTransferTasks`; do not call `terminal.send()` directly from hub code.
- Guard `resourceControl` from selling/exporting hub intermediates or T3 reserves.
- Account for the full 19-reaction chain and shared intermediates (`OH`, `G`, `ZK`, `UL`) rather than one T3 at a time.
- Exclude hub room from T3 distribution targets.
- Add observable blocked state for missing resources, insufficient labs, no terminal/storage, and near-full storage.

## Work Objectives
### Core Objective
Implement a configuration-driven, TDD-backed HUB production planner that coordinates existing terminal transfer and synthesis systems to build and distribute five war-core T3 reserves from internal resources only.

### Deliverables
- `src/runtime/hubFlag.ts` for one-shot `HUB` flag setup.
- `src/runtime/hubPlanner.ts` for cadence-gated planning before synthesis.
- Type additions in `src/global.d.ts` for `Memory.cfg.hub` and `Memory.runtime.hub`.
- Integration in `src/main.ts` before `runSynthesisControl()` and in `src/runtime/flagControl.ts` processor list.
- Resource-control guard logic so hub intermediates/T3 are not auto-sold or exported away.
- Transfer-task ordering/gating so hub reagent imports outrank T3 exports, and both avoid starving existing essential flows.
- Tests: `src/runtime/hubFlag.test.ts`, `src/runtime/hubPlanner.test.ts`, plus targeted tests in existing suites if behavior is changed.

### Definition of Done (verifiable conditions with commands)
- `npx tsc --noEmit` exits 0.
- `npm run test -- hubFlag hubPlanner` exits 0.
- `npm run test` exits 0.
- Tests prove: flag setup, blocked states, 19-step chain ordering, reclaimed surplus priority, internal-only import behavior, hub-to-satellite T3 distribution, hub room excluded, and resourceControl does not steal hub intermediates.
- No implementation creates raw `terminal.send()` calls outside existing `resourceControl` transfer-task executor.

### Must Have
- One active hub room in first version.
- `HUB` flag must be accepted only in visible owned rooms.
- Hub planner must be cadence-gated and lightweight.
- Hub planner must compute global inventory using storage + terminal + labs where relevant.
- Hub planner must plan these exact reserves: `XGHO2`, `XGH2O`, `XUH2O`, `XUHO2`, `XLHO2`, `1000` each per eligible non-hub room storage.
- Hub planner must reclaim surplus selected T3 and intermediate compounds from satellite rooms to hub before scheduling new production for those resources.
- Missing inputs must set blocked runtime status; no market buy.
- Final T3 should end in satellite storage, not remain in terminal.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- No market buying in first version.
- No multi-hub support in first version.
- No cross-shard hub.
- No factory commodity production.
- No PowerCreep/operator integration.
- No raw terminal sends in hub modules.
- No second lab reaction executor; only `synthesisControl` runs reactions.
- No moving `flagControl` before synthesis to solve planner ordering.
- No main-loop reorder that changes existing `synthesisControl → mineralExtraction → resourceControl` semantics except inserting `hubPlanner` before `synthesisControl`.
- No vague QA requiring manual Screeps observation.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD + Jest + TypeScript.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 schema/config, Task 2 flag setup, Task 3 pure chain planner tests and implementation.
Wave 2: Task 4 main-loop hubPlanner runtime, Task 5 import/reclaim transfer planning, Task 6 synthesisControl config orchestration.
Wave 3: Task 7 transfer priority/gating, Task 8 T3 distribution/offload, Task 9 resourceControl anti-interference guards.
Wave 4: Task 10 cleanup/status observability, Task 11 integration tests, Task 12 final verification hardening.

### Dependency Matrix (full, all tasks)
- Task 1 blocks Tasks 2, 4, 5, 6, 8, 10.
- Task 2 depends on Task 1; blocks no production logic.
- Task 3 depends on Task 1; blocks Tasks 4 and 6.
- Task 4 depends on Tasks 1 and 3; blocks Tasks 5, 6, 8, 10.
- Task 5 depends on Task 4; blocks Task 6 and Task 11.
- Task 6 depends on Tasks 3, 4, 5; blocks Task 11.
- Task 7 depends on Task 5; blocks Task 8 and Task 11.
- Task 8 depends on Tasks 4 and 7; blocks Task 11.
- Task 9 depends on Tasks 1 and 5; blocks Task 11.
- Task 10 depends on Task 4; blocks Task 12.
- Task 11 depends on Tasks 2-10.
- Task 12 depends on Task 11.

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 3 tasks → quick, quick, deep
- Wave 2 → 3 tasks → deep, deep, deep
- Wave 3 → 3 tasks → deep, deep, quick
- Wave 4 → 3 tasks → quick, deep, unspecified-high

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add HUB Memory schema and default policy constants

  **What to do**: Write failing type/runtime tests first, then add `Memory.cfg.hub` and `Memory.runtime.hub` declarations in `src/global.d.ts`. Define defaults in new hub module code: `enabled`, `hubRoomName`, `planInterval` default `50`, `reservePerRoom` default `1000`, `targetCompounds` exactly [`RESOURCE_CATALYZED_GHODIUM_ALKALIDE`, `RESOURCE_CATALYZED_GHODIUM_ACID`, `RESOURCE_CATALYZED_UTRIUM_ACID`, `RESOURCE_CATALYZED_UTRIUM_ALKALIDE`, `RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE`], `storagePauseFreeCapacity` default `100000`, `surplusThreshold` default `reservePerRoom + 500`, and `internalOnly` fixed true for first version.
  **Must NOT do**: Do not add market-buy config. Do not support multiple hubs. Do not change existing `Memory.cfg.resourceControl` shape except where later tasks require guards.

  **Recommended Agent Profile**:
  - Category: `quick` - bounded type/config task.
  - Skills: [`superpowers:test-driven-development`] - tests must precede implementation.
  - Omitted: [`frontend-ui-ux`] - no UI work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 2,3,4,5,6,8,10 | Blocked By: none

  **References**:
  - Pattern: `src/global.d.ts:267-290` - `Memory.cfg.synthesisControl` shape.
  - Pattern: `src/global.d.ts:429-497` - runtime state patterns for resource/synthesis modules.
  - Pattern: `src/runtime/memoryService.ts:1-49` - `ensureCfg`, `ensureRuntime`, `ensureData` namespace access.
  - External: `https://docs.screeps.com/api/#StructureTerminal` - terminal capacity/cooldown constraints used in config comments.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx tsc --noEmit` succeeds after adding hub memory types.
  - [ ] Jest test asserts default policy resolves exactly five target compounds and `reservePerRoom === 1000`.
  - [ ] Jest test asserts config with no `hubRoomName` resolves to disabled/planner no-op.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Default policy resolves war-core T3 list
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand` after adding initial default-policy tests.
    Expected: Test output shows default target list equals XGHO2, XGH2O, XUH2O, XUHO2, XLHO2 and reserve target 1000.
    Evidence: .sisyphus/evidence/task-1-hub-schema.txt

  Scenario: Missing hub config is safe
    Tool: Bash
    Steps: Run `npx tsc --noEmit && npm run test -- hubPlanner --runInBand`.
    Expected: No type errors; test confirms planner returns no actions when `Memory.cfg.hub` is absent.
    Evidence: .sisyphus/evidence/task-1-hub-schema-safe.txt
  ```

  **Commit**: YES | Message: `feat(hub): add hub configuration schema` | Files: `src/global.d.ts`, `src/runtime/hubPlanner.test.ts`, `src/runtime/hubPlanner.ts`

- [x] 2. Implement one-shot HUB flag setup

  **What to do**: Write `src/runtime/hubFlag.test.ts` first. Add `src/runtime/hubFlag.ts` exporting `runHubByFlag(): void`. Detect only `flag.name === "HUB"`. If no hub is configured and the flag room is visible and owned, write `Memory.cfg.hub.enabled = true`, `Memory.cfg.hub.hubRoomName = flag.pos.roomName`, preserve existing user targets if present, set defaults if absent, set `Memory.runtime.hub.needsPlan = true`, then call `flag.remove()`. If a different hub is already configured, or the flag room is non-owned/invisible, leave flag in place and record `Memory.runtime.hub.status = "blocked"` with reason. Register in `src/runtime/flagControl.ts` processors array.
  **Must NOT do**: Do not run production planning in flag processor. Do not accept `HUB_*` names in first version. Do not consume invalid/non-owned flags.

  **Recommended Agent Profile**:
  - Category: `quick` - follows existing flag processor pattern.
  - Skills: [`superpowers:test-driven-development`] - flag tests first.
  - Omitted: [`playwright`] - no browser.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: none | Blocked By: 1

  **References**:
  - Pattern: `src/runtime/flagControl.ts:22` - central flag processor array.
  - Pattern: `src/modules/autoplanner/index.ts` - one-shot planner/save flag behavior.
  - Pattern: `src/runtime/flagHauling.test.ts` - Game.flags test setup.
  - Pattern: `test/mock/index.ts:6` - Game.flags mock.

  **Acceptance Criteria**:
  - [ ] `npm run test -- hubFlag --runInBand` passes.
  - [ ] Test asserts owned visible room consumes flag and writes `Memory.cfg.hub.hubRoomName`.
  - [ ] Test asserts non-owned room leaves flag and writes blocked runtime reason.
  - [ ] Test asserts a new `HUB` flag in a different room does not override an existing configured hub; existing configured hub wins and the new flag remains blocked.

  **QA Scenarios**:
  ```
  Scenario: Owned room HUB flag configures hub
    Tool: Bash
    Steps: Run `npm run test -- hubFlag --runInBand`.
    Expected: Jest assertion `Memory.cfg.hub.hubRoomName === "W1N1"` and `flag.remove` called once.
    Evidence: .sisyphus/evidence/task-2-hub-flag.txt

  Scenario: Invalid HUB flag is not consumed
    Tool: Bash
    Steps: Run `npm run test -- hubFlag --runInBand`.
    Expected: Non-owned/invisible test asserts `flag.remove` not called and `Memory.runtime.hub.status === "blocked"`.
    Evidence: .sisyphus/evidence/task-2-hub-flag-invalid.txt
  ```

  **Commit**: YES | Message: `feat(hub): configure hub room from flag` | Files: `src/runtime/hubFlag.ts`, `src/runtime/hubFlag.test.ts`, `src/runtime/flagControl.ts`

- [x] 3. Build pure reaction-chain planner with shared intermediate accounting

  **What to do**: Write failing pure-function tests in `src/runtime/hubPlanner.test.ts`. Implement deterministic chain definitions for the five selected T3 compounds and shared intermediate requirements. Required sequence for 1000 each: `OH` target 5000, `ZK` target 2000, `UL` target 2000, `G` target 2000, then `UH`, `UO`, `LO`, `GH`, `GO` target 1000 each, then `UH2O`, `UHO2`, `LHO2`, `GHO2`, `GH2O` target 1000 each, then final `XUH2O`, `XUHO2`, `XLHO2`, `XGHO2`, `XGH2O` target 1000 each. Planner must subtract existing hub inventory and reclaimed incoming task amounts before deciding next product.
  **Must NOT do**: Do not hard-code only one linear T3 chain. Do not ignore consumed intermediates. Do not use market availability.

  **Recommended Agent Profile**:
  - Category: `deep` - core algorithm with chain accounting.
  - Skills: [`superpowers:test-driven-development`] - pure tests first.
  - Omitted: [`git-master`] - no git operation unless committing.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 4,6 | Blocked By: 1

  **References**:
  - API/Type: `REACTIONS` global constant - product resolution in Screeps.
  - Pattern: `src/runtime/synthesisControl.ts:143-158` - builds product→reagent map from `REACTIONS`.
  - External: `https://github.com/screeps/common/blob/master/lib/constants.js` - reaction times and resource constants.
  - Research: Official constraints: lab output 5 units, selected T3 require all seven base minerals.

  **Acceptance Criteria**:
  - [ ] Tests assert exact 19-step sequence above for empty hub inventory and one eligible room.
  - [ ] Tests assert `OH` target is 5000 and `G` target is 2000, proving shared intermediate accounting.
  - [ ] Tests assert existing/reclaimed `XUH2O` reduces final production need before planner schedules new `XUH2O`.
  - [ ] Tests assert missing base minerals produce blocked result listing exact missing resources.

  **QA Scenarios**:
  ```
  Scenario: Full 5-T3 chain sequence is deterministic
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand`.
    Expected: Jest verifies the exact 19 products and target amounts in order.
    Evidence: .sisyphus/evidence/task-3-chain-sequence.txt

  Scenario: Reclaimed surplus is consumed before production
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand`.
    Expected: Test with incoming/reclaimed XUH2O shows planner does not overproduce XUH2O.
    Evidence: .sisyphus/evidence/task-3-reclaim-accounting.txt
  ```

  **Commit**: YES | Message: `feat(hub): plan war-core t3 reaction chains` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`

- [x] 4. Add cadence-gated hubPlanner runtime before synthesisControl

  **What to do**: Write tests for runtime no-op/blocking behavior. Add `runHubPlanner(): void` to `src/runtime/hubPlanner.ts`. Register it in `src/main.ts` before `runSynthesisControl()` so hub writes to `Memory.cfg.synthesisControl.rooms[hubRoom].reactions` before synthesis reads config in the same tick. Planner runs only when `Memory.cfg.hub.enabled === true`, `hubRoomName` exists, and either `Game.time % planInterval === 0` or `Memory.runtime.hub.needsPlan === true`; because `flagControl` runs later in the tick, a newly placed `HUB` flag triggers the first immediate plan on the next tick, then clears `needsPlan`. Validate hub room has controller.my, storage, terminal, and at least 3 labs; otherwise set `Memory.runtime.hub.status = "blocked"` with exact reason.
  **Must NOT do**: Do not place recurring planner in `flagControl`. Do not move existing `synthesisControl`, `mineralExtraction`, or `resourceControl` order except inserting hub before synthesis.

  **Recommended Agent Profile**:
  - Category: `deep` - main-loop integration risk.
  - Skills: [`superpowers:test-driven-development`] - ordering/block tests first.
  - Omitted: [`frontend-ui-ux`] - no UI.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 5,6,8,10 | Blocked By: 1,3

  **References**:
  - Pattern: `src/main.ts:49-87` - behavior-critical tick order.
  - Pattern: `src/main.ts:56-58` - current `synthesisControl → mineralExtraction → resourceControl` order.
  - Pattern: `src/runtime/synthesisControl.ts:785` - active plan selection reads config.
  - Guardrail: Metis found planner must run before synthesis, not in flagControl.

  **Acceptance Criteria**:
  - [ ] Test or static assertion verifies `runHubPlanner()` is invoked before `runSynthesisControl()` in `src/main.ts`.
  - [ ] Jest tests assert planner no-ops off cadence and runs on cadence.
  - [ ] Jest tests assert missing terminal, storage, or <3 labs sets blocked runtime status.
  - [ ] `npx tsc --noEmit` succeeds.

  **QA Scenarios**:
  ```
  Scenario: Hub planner precedes synthesis
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand` and `npx tsc --noEmit`.
    Expected: Test inspecting orchestrator or mocked calls confirms hub planner runs before synthesis control.
    Evidence: .sisyphus/evidence/task-4-main-order.txt

  Scenario: Invalid hub infrastructure blocks safely
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand`.
    Expected: Missing terminal/storage/labs tests set `Memory.runtime.hub.status === "blocked"` with reasons.
    Evidence: .sisyphus/evidence/task-4-blocked-infra.txt
  ```

  **Commit**: YES | Message: `feat(hub): schedule hub planner before synthesis` | Files: `src/main.ts`, `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`

- [x] 5. Plan internal base, intermediate, and surplus compound imports to HUB

  **What to do**: TDD first. Extend hubPlanner to scan eligible non-hub owned rooms with storage+terminal. Create `resourceTransferTasks` from satellite to hub for: needed base minerals (`H`, `O`, `U`, `L`, `K`, `Z`, `X`) above satellite safety floors; needed intermediates (`OH`, `ZK`, `UL`, `G`, `UH`, `UO`, `LO`, `GH`, `GO`, `UH2O`, `UHO2`, `LHO2`, `GHO2`, `GH2O`); and surplus selected T3 above target reserve + surplus buffer. Use `createResourceTransferTask` only. Reason strings must be namespaced: `hub:import:<resource>` and `hub:reclaim:<resource>`. Do not create tasks if hub storage free capacity is below `storagePauseFreeCapacity` or destination terminal is near full.
  **Must NOT do**: Do not send resources from rooms in survival energy state if resourceControl snapshot marks them survival. Do not drain a satellite below its own 1000 T3 storage reserve for selected T3. Do not buy missing inputs.

  **Recommended Agent Profile**:
  - Category: `deep` - cross-room resource policy.
  - Skills: [`superpowers:test-driven-development`] - policy tests first.
  - Omitted: [`playwright`] - no UI.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 6,7,9,11 | Blocked By: 4

  **References**:
  - Pattern: `src/runtime/logistics/resourceTransferTasks.ts:1-249` - persistent transfer task CRUD and merge support.
  - Pattern: `src/runtime/resourceControl.ts:1-1244` - terminal transfer executor and room economy states.
  - Pattern: `src/runtime/synthesisControl.ts` - donor selection uses internal terminal sends; hub should reuse task queue.
  - Official: Terminal send cooldown 10 ticks and cost paid by sender.

  **Acceptance Criteria**:
  - [ ] Tests assert base mineral import tasks are created only from internal rooms with surplus.
  - [ ] Tests assert surplus selected T3 above 1500 in satellite storage creates reclaim task to hub, but exactly 1000 does not.
  - [ ] Tests assert intermediate surplus creates reclaim tasks and is counted before new synthesis.
  - [ ] Tests assert no tasks are created when hub storage free capacity is below threshold.

  **QA Scenarios**:
  ```
  Scenario: Satellite surplus T3 returns to hub
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand`.
    Expected: Test finds `Memory.data.resourceControl.tasks` contains reason `hub:reclaim:XGHO2` from satellite to hub for amount above reserve+buffer.
    Evidence: .sisyphus/evidence/task-5-surplus-reclaim.txt

  Scenario: Internal-only resource pull blocks on shortage
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand`.
    Expected: No market calls; runtime blocked status lists missing base resources when no owned room has surplus.
    Evidence: .sisyphus/evidence/task-5-internal-only.txt
  ```

  **Commit**: YES | Message: `feat(hub): reclaim internal resources for production` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`

- [x] 6. Drive synthesisControl reaction config from hubPlanner stages

  **What to do**: TDD first. Extend hubPlanner to write exactly one active reaction plan into `Memory.cfg.synthesisControl.rooms[hubRoom].reactions` at a time, using the next incomplete chain step from Task 3. Preserve existing `reagentLabIds`, `sampleInterval`, `defaultBatchSize`, and `defaultMaxRunsPerTick` if configured. The written reaction must have `product`, `targetAmount`, and donor room list constrained to internal rooms. If a step lacks reagents and imports are pending, runtime status should be `acquiring`; if imports are impossible, `blocked` with `missingResources`.
  **Must NOT do**: Do not call `lab.runReaction`. Do not mutate `Memory.runtime.synthesisControl` directly except reading status for planner decisions. Do not enqueue multiple simultaneous reactions for one hub room.

  **Recommended Agent Profile**:
  - Category: `deep` - orchestrates executor config without owning reactions.
  - Skills: [`superpowers:test-driven-development`] - synthesis config tests first.
  - Omitted: [`frontend-ui-ux`] - no UI.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 11 | Blocked By: 3,4,5

  **References**:
  - Pattern: `src/runtime/synthesisControl.ts:19` - state machine stages.
  - Pattern: `src/runtime/synthesisControl.ts:785` - `chooseActivePlan()` decision point.
  - Pattern: `src/runtime/synthesisControl.ts:890` - room handler entry.
  - API/Type: `src/global.d.ts:267-290` - synthesisControl config shape.

  **Acceptance Criteria**:
  - [ ] Test asserts empty hub inventory writes first reaction `OH` with target 5000.
  - [ ] Test asserts after hub has 5000 OH and 2000 ZK/UL path prerequisites, planner advances to next incomplete step.
  - [ ] Test asserts existing manual `reagentLabIds` are preserved.
  - [ ] Test asserts runtime status `acquiring` while import tasks exist and `blocked` when no internal source can satisfy reagents.

  **QA Scenarios**:
  ```
  Scenario: Planner writes first synthesis reaction
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand`.
    Expected: `Memory.cfg.synthesisControl.rooms[hub].reactions[0].product === RESOURCE_HYDROXIDE` and target 5000.
    Evidence: .sisyphus/evidence/task-6-synthesis-config.txt

  Scenario: Planner preserves lab binding config
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand`.
    Expected: Existing `reagentLabIds` remain unchanged after hubPlanner writes reactions.
    Evidence: .sisyphus/evidence/task-6-preserve-labs.txt
  ```

  **Commit**: YES | Message: `feat(hub): drive synthesis reaction queue` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`

- [x] 7. Add hub-aware transfer ordering and cooldown contention guards

  **What to do**: TDD first in `src/runtime/resourceControl.test.ts` or `src/runtime/logistics/resourceTransferTasks.test.ts`. Without changing the persisted `ResourceTransferTask` schema, adjust transfer execution ordering with this exact priority: (1) existing survival energy transfers to rooms whose resourceControl state is `survival`, (2) existing synthesis/reagent acquisition tasks not owned by hub, (3) `hub:import:*`, (4) `hub:reclaim:*`, (5) `hub:export:*`, (6) other existing resourceControl tasks in their current order. Ensure hub exports are skipped while hub import/reclaim tasks are pending for the same hub room. Keep `taskMaxPerRun` respected.
  **Must NOT do**: Do not add a new raw send loop. Do not break existing resourceControl tests. Do not starve emergency energy balancing for survival rooms; if a survival energy transfer is present, it must outrank hub T3 export.

  **Recommended Agent Profile**:
  - Category: `deep` - changes shared transfer execution behavior.
  - Skills: [`superpowers:test-driven-development`] - existing regression tests first.
  - Omitted: [`playwright`] - no UI.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: 8,11 | Blocked By: 5

  **References**:
  - Pattern: `src/runtime/resourceControl.ts` - `executeTransferTasks` processes persistent tasks and terminal busy set.
  - Pattern: `src/runtime/logistics/resourceTransferTasks.test.ts` - task ordering/merge tests.
  - Official: Terminal sends have 10 tick cooldown; one send per terminal cooldown window.
  - Metis guardrail: avoid terminal cooldown starvation.

  **Acceptance Criteria**:
  - [ ] Test asserts `hub:import:O` executes before `hub:export:XGHO2` when both compete for hub terminal cooldown.
  - [ ] Test asserts survival energy transfer outranks hub export.
  - [ ] Test asserts `taskMaxPerRun` still caps sends.
  - [ ] Existing `npm run test -- resourceControl resourceTransferTasks --runInBand` passes.

  **QA Scenarios**:
  ```
  Scenario: Hub imports outrank exports
    Tool: Bash
    Steps: Run `npm run test -- resourceControl --runInBand`.
    Expected: Mock terminal send called for import/reclaim before export when both are pending.
    Evidence: .sisyphus/evidence/task-7-transfer-priority.txt

  Scenario: Existing transfer behavior remains stable
    Tool: Bash
    Steps: Run `npm run test -- resourceControl resourceTransferTasks --runInBand`.
    Expected: Existing suites pass with no changed expectations except new explicit priority tests.
    Evidence: .sisyphus/evidence/task-7-regression.txt
  ```

  **Commit**: YES | Message: `feat(hub): prioritize hub transfer tasks` | Files: `src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`, optionally `src/runtime/logistics/resourceTransferTasks.test.ts`

- [x] 8. Distribute finished T3 reserves from HUB to satellite storage

  **What to do**: TDD first. Extend hubPlanner to scan eligible non-hub rooms and create `resourceTransferTasks` from hub to satellite for selected T3 compounds where satellite storage has less than 1000 units, counting pending incoming amounts. Reason prefix: `hub:export:<resource>`. Ensure transfer amount never exceeds shortage, hub available stock minus any hub local safety buffer, destination terminal free capacity, and sender terminal fee-energy availability. Ensure local offload to storage is handled by existing `resourceControl` terminal offload tasks; add tests if current offload only handles configured resources and needs extension for compounds.
  **Must NOT do**: Do not distribute to the hub room. Do not send T3 to rooms lacking storage or terminal. Do not push if destination storage free capacity is near zero.

  **Recommended Agent Profile**:
  - Category: `deep` - cross-room distribution logic.
  - Skills: [`superpowers:test-driven-development`] - distribution tests first.
  - Omitted: [`frontend-ui-ux`] - no UI.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: 11 | Blocked By: 4,7

  **References**:
  - Pattern: `src/runtime/resourceControl.ts` - terminal offload carrier tasks.
  - Pattern: `src/runtime/carrierTaskBoard.ts:1-183` - terminal offload task producer/consumer model.
  - Pattern: `src/roles/carrier.ts` - carrier consumes task board tasks.
  - Official: Terminal store capacity 300,000; storage capacity 1,000,000.

  **Acceptance Criteria**:
  - [ ] Test asserts satellite with 250 `XGHO2` in storage receives task for 750 from hub.
  - [ ] Test asserts satellite with 1000 `XGHO2` receives no task.
  - [ ] Test asserts hub room is excluded even if below reserve.
  - [ ] Test asserts destination terminal capacity prevents task creation or caps amount.
  - [ ] Test asserts terminal offload task moves received T3 from terminal to storage.

  **QA Scenarios**:
  ```
  Scenario: T3 reserve shortage creates export task
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand`.
    Expected: `Memory.data.resourceControl.tasks` contains `hub:export:XGHO2` from hub to satellite for exact shortage.
    Evidence: .sisyphus/evidence/task-8-t3-export.txt

  Scenario: T3 lands in storage via offload
    Tool: Bash
    Steps: Run `npm run test -- resourceControl --runInBand` for compound terminal offload case.
    Expected: Carrier task board includes terminal_offload task for received T3 to storage.
    Evidence: .sisyphus/evidence/task-8-terminal-offload.txt
  ```

  **Commit**: YES | Message: `feat(hub): distribute war reserve compounds` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`, possibly `src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`

- [x] 9. Prevent resourceControl from selling or exporting HUB intermediates/reserves

  **What to do**: TDD first. Add guard logic in `resourceControl` so if `Memory.cfg.hub.hubRoomName === room.name`, mineral export/market sell logic skips all hub-managed resources: selected T3, chain intermediates, and base minerals reserved for active chain shortages. For non-hub rooms, selected T3 below reserve must not be sold/exported; surplus above reserve+buffer may be reclaimed only by hubPlanner, not normal mineral export. Keep energy balancing behavior unchanged except hub T3 export priority from Task 7.
  **Must NOT do**: Do not disable all resourceControl behavior in hub room. Do not block terminal feed/offload tasks needed by synthesis and distribution.

  **Recommended Agent Profile**:
  - Category: `quick` - bounded guard and tests.
  - Skills: [`superpowers:test-driven-development`] - guard tests first.
  - Omitted: [`playwright`] - no UI.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 11 | Blocked By: 1,5

  **References**:
  - Pattern: `src/runtime/resourceControl.ts:951` - market operations/export decision area.
  - Pattern: `src/runtime/resourceControl.test.ts` - market sell/buy and export behavior coverage.
  - Metis risk: `resourceControl` may steal OH/intermediates/T3 without explicit guard.

  **Acceptance Criteria**:
  - [ ] Test asserts hub room does not create sell/export task for `OH`, `G`, `UH2O`, or selected T3 above normal mineral export thresholds.
  - [ ] Test asserts non-hub room with 1000 selected T3 does not sell/export it.
  - [ ] Test asserts non-hub surplus selected T3 is left for hubPlanner reclaim, not resourceControl sell.
  - [ ] Existing resourceControl market tests for unrelated minerals still pass.

  **QA Scenarios**:
  ```
  Scenario: HUB intermediates are protected
    Tool: Bash
    Steps: Run `npm run test -- resourceControl --runInBand`.
    Expected: No market/order/transfer task generated for OH/G/T3 in hub room despite high amounts.
    Evidence: .sisyphus/evidence/task-9-protect-intermediates.txt

  Scenario: Non-hub reserves are protected
    Tool: Bash
    Steps: Run `npm run test -- resourceControl hubPlanner --runInBand`.
    Expected: ResourceControl does not sell reserve T3; hubPlanner may reclaim only surplus above reserve+buffer.
    Evidence: .sisyphus/evidence/task-9-protect-reserves.txt
  ```

  **Commit**: YES | Message: `fix(resource): protect hub production resources` | Files: `src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`

- [x] 10. Add hub runtime cleanup and observable status

  **What to do**: TDD first. Add cleanup for `Memory.runtime.hub` stale room references in `src/runtime/memoryCleanup.ts`. Runtime status must include `updatedAt`, `status` (`idle`, `importing`, `synthesizing`, `distributing`, `blocked`), `activeProduct`, `activeStep`, `missingResources`, `lastPlanActions`, and counts of pending hub import/reclaim/export tasks. Add console status helper only if existing console command pattern supports it; otherwise runtime memory is sufficient.
  **Must NOT do**: Do not persist large per-task histories in Memory. Do not store full global inventory snapshots indefinitely; keep latest compact summary only.

  **Recommended Agent Profile**:
  - Category: `quick` - cleanup/status support.
  - Skills: [`superpowers:test-driven-development`] - cleanup tests first.
  - Omitted: [`frontend-ui-ux`] - no UI.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: 12 | Blocked By: 4

  **References**:
  - Pattern: `src/runtime/memoryCleanup.ts:237-304` - resource/synthesis cleanup patterns.
  - Pattern: `src/runtime/memoryCleanup.ts:447-453` - transfer/carrier task cleanup.
  - Pattern: `src/runtime/console/resourceTransferCommands.ts` - console command registration style if needed.

  **Acceptance Criteria**:
  - [ ] Test asserts stale `Memory.runtime.hub` room is removed or blocked when hub room no longer owned.
  - [ ] Test asserts blocked status includes exact missing resource names.
  - [ ] Test asserts runtime summary does not grow unbounded across repeated planner runs.
  - [ ] `npm run test -- memoryCleanup hubPlanner --runInBand` passes.

  **QA Scenarios**:
  ```
  Scenario: Blocked hub status is inspectable
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner --runInBand`.
    Expected: Missing input test sets `Memory.runtime.hub.missingResources` to exact resources.
    Evidence: .sisyphus/evidence/task-10-runtime-status.txt

  Scenario: Cleanup removes stale hub runtime
    Tool: Bash
    Steps: Run `npm run test -- memoryCleanup --runInBand`.
    Expected: Stale hub runtime/config references are cleaned or safely blocked without deleting valid config.
    Evidence: .sisyphus/evidence/task-10-cleanup.txt
  ```

  **Commit**: YES | Message: `feat(hub): expose planner status and cleanup` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`, `src/runtime/memoryCleanup.ts`, relevant tests

- [x] 11. Add full TDD integration coverage for HUB lifecycle

  **What to do**: Create integration-style Jest tests using mocks across `hubFlag`, `hubPlanner`, `resourceTransferTasks`, and relevant `resourceControl` behavior. Simulate: place `HUB` flag → config written → next-tick hubPlanner sees `needsPlan` → imports/reclaims resources → writes `OH` first reaction → advances when inventory changes → creates `hub:export` T3 task when final stock exists → terminal offload sends to storage. Include edge cases from Metis: no terminal, <3 labs, no base minerals, storage >90% full, non-owned flag, and existing configured hub plus a new `HUB` flag in another room.
  **Must NOT do**: Do not rely on real Screeps server state. Do not skip edge cases because unit tests exist.

  **Recommended Agent Profile**:
  - Category: `deep` - integration coverage across modules.
  - Skills: [`superpowers:test-driven-development`] - write failing integration tests before any remaining fixes.
  - Omitted: [`playwright`] - no browser.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: 12 | Blocked By: 2,3,4,5,6,7,8,9

  **References**:
  - Pattern: `src/runtime/synthesisControl.test.ts` - lab structure mocks.
  - Pattern: `src/runtime/resourceControl.test.ts` - terminal/store transfer mocks.
  - Pattern: `src/runtime/logistics/resourceTransferTasks.test.ts` - persistent transfer task assertions.
  - Pattern: `src/runtime/flagHauling.test.ts` - flag lifecycle assertions.

  **Acceptance Criteria**:
  - [ ] Integration test asserts full lifecycle from flag to first reaction and final export task.
  - [ ] Edge-case tests listed above all pass.
  - [ ] `npm run test -- hub --runInBand` passes.
  - [ ] `npm run test -- synthesisControl resourceControl resourceTransferTasks --runInBand` passes.

  **QA Scenarios**:
  ```
  Scenario: Full HUB lifecycle integration
    Tool: Bash
    Steps: Run `npm run test -- hub --runInBand`.
    Expected: Test sequence proves flag config, import/reclaim tasks, first reaction config, stage advancement, export task, and offload behavior.
    Evidence: .sisyphus/evidence/task-11-full-lifecycle.txt

  Scenario: Edge cases block safely
    Tool: Bash
    Steps: Run `npm run test -- hub --runInBand`.
    Expected: No terminal, <3 labs, missing resources, near-full storage, non-owned flag, and existing-hub/new-flag conflict all produce deterministic assertions.
    Evidence: .sisyphus/evidence/task-11-edge-cases.txt
  ```

  **Commit**: YES | Message: `test(hub): cover full production lifecycle` | Files: `src/runtime/hubPlanner.test.ts`, `src/runtime/hubFlag.test.ts`, relevant existing test files

- [x] 12. Final hardening, commands, and production-rate expectation

  **What to do**: Run complete verification. Add code comments or runtime status fields documenting that producing 1000 each of five T3 compounds is roughly 10k-15k ticks under one-room sequential lab execution, depending on lab count/cooldowns/cleanup/terminal contention. Ensure no `.secret.json` or generated `dist/` changes are included. Ensure project commands pass.
  **Must NOT do**: Do not deploy (`npm run push`) unless user explicitly requests execution/deploy in a later Sisyphus run. Do not commit secrets.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - final QA and hardening.
  - Skills: [`superpowers:verification-before-completion`] - evidence before success claims.
  - Omitted: [`frontend-ui-ux`] - no UI.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: final verification | Blocked By: 10,11

  **References**:
  - Commands: `npx tsc --noEmit`, `npm run test`, `npm run build` from `AGENTS.md`.
  - Constraint: `.secret.json` contains credentials; never commit.
  - Metis estimate: 19 sequential reactions, ~27k base minerals, ~10k-15k ticks for 5000 final T3 units.

  **Acceptance Criteria**:
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test` exits 0.
  - [ ] `npm run build` exits 0.
  - [ ] `git status --short` shows no `.secret.json` or generated `dist/` staged unless user explicitly chooses deployment workflow.

  **QA Scenarios**:
  ```
  Scenario: Full local verification
    Tool: Bash
    Steps: Run `npx tsc --noEmit && npm run test && npm run build`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-12-verification.txt

  Scenario: No secret/generated artifacts included
    Tool: Bash
    Steps: Run `git status --short`.
    Expected: No `.secret.json`; no generated `dist/` staged unless user explicitly requested deploy artifacts.
    Evidence: .sisyphus/evidence/task-12-git-status.txt
  ```

  **Commit**: YES | Message: `chore(hub): verify production planner` | Files: verification-only changes if any; otherwise no commit

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Use atomic semantic commits in English with scope, following repository convention: `feat(hub): ...`, `fix(resource): ...`, `test(hub): ...`, `chore(hub): ...`.
- Minimum commit split: schema/flag, planner algorithm, runtime integration, resource transfer/distribution, resourceControl guards, integration tests/final hardening.
- Do not push or deploy unless explicitly requested after `/start-work` execution.
- Do not commit `.secret.json`; avoid generated `dist/` unless deployment workflow explicitly requires it.

## Success Criteria
- `HUB` flag in an owned visible room configures exactly one hub room and removes itself.
- Hub planner runs before synthesis and uses existing `synthesisControl` as sole lab executor.
- Hub planner computes the full 19-step chain for the five selected T3 targets and accounts for shared intermediates.
- Other owned rooms can send surplus selected T3/intermediates to hub; hub reuses reclaimed inventory before producing more.
- Hub creates internal-only transfer tasks for base minerals/intermediates/T3; no market buy occurs.
- Hub distributes selected T3 to each eligible non-hub room until storage has 1000 units per selected compound.
- ResourceControl does not sell/export protected hub intermediates or selected T3 reserves.
- Blocked states are visible in `Memory.runtime.hub` with exact reasons.
- Full TypeScript, Jest, and build verification pass.
