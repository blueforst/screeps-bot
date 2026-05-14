# Mineral Harvester Preproduction Depletion Guard

## TL;DR
> **Summary**: Prevent `mineralHarvester` pre-spawn from queueing replacements when the configured mineral is depleted or missing. Add focused spawn-planner regression coverage first, then implement the smallest role-specific guard.
> **Deliverables**:
> - Failing-then-passing depleted-mineral pre-spawn test in `src/runtime/spawnPlanner.test.ts`
> - Missing-mineral-object pre-spawn safety test in `src/runtime/spawnPlanner.test.ts`
> - Role-specific depleted-mineral guard in `src/runtime/spawnPlanner.ts`
> - Targeted Jest, TypeScript, and full Jest verification evidence
> **Effort**: Quick
> **Parallel**: NO
> **Critical Path**: Task 1 → Final Verification Wave

## Context

### Original Request
“mineral的harvester的预生产有些问题, 即使mineral空了还是在生产harvester”

### Interview Summary
- User reports mineral harvester preproduction continues after mineral depletion.
- No user preference tradeoff is required: this is a correctness bug and the expected behavior is to stop new/replacement mineral harvester spawning while the mineral has `mineralAmount <= 0`.

### Metis Review (gaps addressed)
- Put the fix in the spawn decision path, not bootstrap/config creation.
- Use `src/runtime/spawnPlanner.ts:shouldQueueConfig()` for the `mineralHarvester` branch before shared pre-spawn logic.
- Do not add mineral-specific logic to shared `shouldPreSpawnSourceWorker()` because it also serves `harvester`, `miner`, and `colonizerHarvester`.
- Treat `Game.getObjectById(mineralId)` returning `null` as not harvestable and skip spawn queueing.
- Add coverage for depleted mineral suppression and preserve active-mineral pre-spawn behavior.

## Work Objectives

### Core Objective
Stop `mineralHarvester` configs from queueing new/pre-spawn creeps when their configured mineral currently has no harvestable amount.

### Deliverables
- Test coverage in `src/runtime/spawnPlanner.test.ts` proving depleted minerals do not queue pre-spawn replacements.
- Test coverage in `src/runtime/spawnPlanner.test.ts` proving missing mineral objects do not crash or queue pre-spawn replacements.
- Implementation in `src/runtime/spawnPlanner.ts` that checks the configured mineral before pre-spawn queueing.
- Verification commands passing with captured evidence.

### Definition of Done (verifiable conditions with commands)
- `npx jest src/runtime/spawnPlanner.test.ts --testNamePattern="mineral"` exits 0.
- `npx tsc --noEmit` exits 0.
- `npm run test` exits 0.
- No source files outside `src/runtime/spawnPlanner.ts` and `src/runtime/spawnPlanner.test.ts` are changed.

### Must Have
- Use TDD: add the depleted-mineral test before implementation and observe it fail for the current behavior.
- The guard must apply only to `mineralHarvester` configs.
- The guard must use the configured mineral ID from existing `getMineralIdFromConfig()` pattern.
- `mineralAmount > 0` must continue allowing existing mineral pre-spawn behavior.
- `mineralAmount <= 0` and missing mineral object must both skip queueing.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do not modify `src/runtime/bootstrap.ts`, `src/runtime/roomWorkforce.ts`, `src/roles/mineralHarvester.ts`, or `src/runtime/resourceControl.ts`.
- Do not add creep suicide/recycle behavior.
- Do not change source harvester, miner, or colonizer harvester pre-spawn semantics.
- Do not import `isMineralEligibleForHarvest()` into `spawnPlanner.ts`; extractor/container eligibility is already represented by the existing config lifecycle.
- Do not deploy (`npm run push`) as part of this fix plan.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD + Jest/ts-jest
- QA policy: Every task has agent-executed scenarios
- Evidence: `.sisyphus/evidence/task-1-mineral-preproduction.{log,txt}` and final verification evidence files

## Execution Strategy

### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (`quick`) — TDD regression + minimal implementation + targeted verification
Final Wave: F1-F4 review agents in parallel after implementation verification

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1. Add depleted-mineral pre-spawn guard | None | F1-F4 |
| F1-F4. Final Verification Wave | Task 1 | Completion |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|---|---:|---|
| 1 | 1 | quick |
| Final | 4 | oracle, unspecified-high, unspecified-high, deep |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add depleted-mineral pre-spawn guard

  **What to do**:
  1. Open `src/runtime/spawnPlanner.test.ts` and find the existing managed mineral harvester queueing tests.
  2. Add a regression test named exactly: `does not pre-spawn mineral harvesters when mineral is depleted`.
  3. Use the existing `createMineral()` helper with `amount: 0` for the configured mineral.
  4. Set up the same room/spawn/config pattern as the existing mineral pre-spawn TTL tests, including an existing mineral harvester whose `ticksToLive` is low enough that the current implementation would queue a replacement.
  5. Assert `spawn.memory.spawnList` does **not** contain the mineral harvester config name.
  6. Add a second regression test named exactly: `does not pre-spawn mineral harvesters when configured mineral is missing`.
  7. For the missing-object test, create the same mineralHarvester config but ensure `Game.getObjectById(mineralId)` returns `null`; assert `spawn.memory.spawnList` does **not** contain the config name and the scheduler does not throw.
  8. Run both targeted new tests and confirm they fail before implementation; save output to `.sisyphus/evidence/task-1-mineral-preproduction-red.log`.
  9. In `src/runtime/spawnPlanner.ts`, add a `mineralHarvester`-specific guard in `shouldQueueConfig()` before it calls `shouldPreSpawnSourceWorker()`.
  10. Implement the guard using existing `getMineralIdFromConfig(config)` and `Game.getObjectById<Mineral>(mineralId)` pattern:
     - if no mineral ID is present, return `false` for this config;
     - if `Game.getObjectById` returns `null`, return `false`;
     - if `mineral.mineralAmount <= 0`, return `false`;
     - otherwise continue to existing `shouldPreSpawnSourceWorker()` behavior.
  11. Run targeted mineral tests and full `spawnPlanner.test.ts`; save passing output to `.sisyphus/evidence/task-1-mineral-preproduction-green.log`.

  **Must NOT do**:
  - Do not add the check inside `shouldPreSpawnSourceWorker()`.
  - Do not alter cleanup behavior in `bootstrap.ts`.
  - Do not change mineral harvester role runtime behavior.
  - Do not weaken existing queue skip checks for queued/spawning configs.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: small, localized bugfix with established tests and a single implementation touch point.
  - Skills: [`superpowers:test-driven-development`] - Needed because this is a bugfix with a clear missing regression test.
  - Omitted: [`frontend-ui-ux`, `playwright`] - No UI/browser work.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: F1-F4 | Blocked By: None

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/spawnPlanner.ts:getMineralIdFromConfig` - Existing helper for extracting mineral ID from a creep config.
  - Pattern: `src/runtime/spawnPlanner.ts:getSourceWorkerWorkPos` - Existing mineral ID/object lookup pattern in spawn planner.
  - Bug Site: `src/runtime/spawnPlanner.ts:shouldQueueConfig` - Mineral harvester branch currently delegates to shared pre-spawn logic without checking `mineralAmount`.
  - Shared Logic: `src/runtime/spawnPlanner.ts:shouldPreSpawnSourceWorker` - Do not modify; shared by source roles and should remain generic.
  - Existing Guard: `src/runtime/roomWorkforce.ts:isMineralEligibleForHarvest` - Initial config creation already rejects `mineralAmount <= 0`; spawn planner needs an equivalent runtime spawn decision guard.
  - Lifecycle Context: `src/runtime/bootstrap.ts:cleanupSourceConfigs` - Existing configs are retained while live creeps exist, explaining why spawn planner must guard replacements.
  - Test Pattern: `src/runtime/spawnPlanner.test.ts` - Existing mineral pre-spawn describe block and `createMineral()` helper; adapt existing TTL pre-spawn setup.
  - Test Pattern: `src/runtime/roomWorkforce.test.ts` - Empty mineral expected-config exclusion already tested; do not duplicate this in room workforce.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest src/runtime/spawnPlanner.test.ts --testNamePattern="does not pre-spawn mineral harvesters when mineral is depleted"` fails before implementation and passes after implementation.
  - [ ] `npx jest src/runtime/spawnPlanner.test.ts --testNamePattern="does not pre-spawn mineral harvesters when configured mineral is missing"` fails before implementation and passes after implementation.
  - [ ] `npx jest src/runtime/spawnPlanner.test.ts --testNamePattern="mineral"` passes.
  - [ ] `npx jest src/runtime/spawnPlanner.test.ts` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `npm run test` passes.
  - [ ] `git diff -- src/runtime/spawnPlanner.ts src/runtime/spawnPlanner.test.ts` shows only the test and the role-specific guard.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Depleted mineral does not queue replacement
    Tool: Bash
    Steps: npx jest src/runtime/spawnPlanner.test.ts --testNamePattern="does not pre-spawn mineral harvesters when mineral is depleted"
    Expected: Exit code 0 after implementation; assertion proves spawn.memory.spawnList does not contain the mineralHarvester config for amount 0.
    Evidence: .sisyphus/evidence/task-1-mineral-preproduction-green.log

  Scenario: Missing mineral object does not crash or queue replacement
    Tool: Bash
    Steps: npx jest src/runtime/spawnPlanner.test.ts --testNamePattern="does not pre-spawn mineral harvesters when configured mineral is missing"
    Expected: Exit code 0 after implementation; scheduler does not throw and spawn.memory.spawnList does not contain the missing-mineral config.
    Evidence: .sisyphus/evidence/task-1-mineral-preproduction-missing.log

  Scenario: Active mineral still pre-spawns normally
    Tool: Bash
    Steps: npx jest src/runtime/spawnPlanner.test.ts --testNamePattern="pre-spawns mineral harvesters when ttl is below"
    Expected: Exit code 0; existing behavior for mineralAmount > 0 remains unchanged and the mineral config is queued at low TTL.
    Evidence: .sisyphus/evidence/task-1-mineral-preproduction-active.log

  Scenario: Spawn planner suite has no collateral regression
    Tool: Bash
    Steps: npx jest src/runtime/spawnPlanner.test.ts
    Expected: Exit code 0; all spawn planner tests pass.
    Evidence: .sisyphus/evidence/task-1-spawnplanner-suite.log
  ```

  **Commit**: NO | Message: `fix(spawn): skip depleted mineral pre-spawn` | Files: `src/runtime/spawnPlanner.ts`, `src/runtime/spawnPlanner.test.ts`

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Do not commit unless the user explicitly asks for a commit after implementation.
- If the user asks for a commit, use: `fix(spawn): skip depleted mineral pre-spawn`.
- Include only `src/runtime/spawnPlanner.ts` and `src/runtime/spawnPlanner.test.ts`.

## Success Criteria
- Depleted mineral harvester configs are not queued for replacement while `mineralAmount <= 0`.
- Active mineral harvester pre-spawn behavior is unchanged while `mineralAmount > 0`.
- Missing mineral object is handled safely by skipping queueing.
- Targeted spawn planner tests, TypeScript check, and full Jest suite pass.
