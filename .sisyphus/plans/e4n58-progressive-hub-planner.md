# E4N58 Progressive Hub Planner Recovery

## TL;DR
> **Summary**: Fix the E4N58 production blocked loop by separating empty synthesis reactions from explicit room disablement, then make hub planning schedule feasible T3 or intermediate reactions instead of blocking the whole hub when complete T3 chains exceed current base mineral stock.
> **Deliverables**:
> - `synthesisControl` keeps hub-managed rooms enabled when `reactions=[]` unless `enabled:false` is explicit.
> - `hubPlanner` progressively schedules feasible target-chain work, including intermediate products when T3 completion is not currently possible.
> - Jest regression coverage for direct planner behavior, synthesis normalization, and hub/synthesis integration.
> - TypeScript, Jest, and deployment verification.
> **Effort**: Medium
> **Parallel**: YES - 3 waves
> **Critical Path**: Task 1 → Task 2 → Task 4 → Task 6 → Final Verification

## Context
### Original Request
- User asked to confirm Sisyphus agent's diagnosis and propose a repair for E4N58 production being blocked.
- User clarified: when all T3 resources are not enough, the hub should still synthesize needed intermediate products first.

### Interview Summary
- Live memory showed `Memory.runtime.hub.status = "blocked"`, `missingResources = ["H", "O", "Z"]`, `activeProduct = ""`, `needsPlan = false`.
- Live memory showed `Memory.runtime.synthesisControl.rooms.E4N58.stage = "blocked"`, `activeProduct = "UO"`, `targetAmount = 996`, `lastError = "room_config_disabled"`.
- Live memory showed `Memory.cfg.synthesisControl.rooms.E4N58.enabled = true` but `reactions = []`.
- Confirmed code chain: hub blocked clears reactions; synthesis config normalization then converts empty reactions into local `enabled=false`, causing `room_config_disabled`.
- Confirmed design defect: current `planHubChains()` seeds all hard-coded T3 targets to target reserve and blocks on aggregate base mineral shortage, even when some useful intermediate reactions are feasible.
- Default decision: use target-path order for fallback scheduling. Prefer configured `targetCompounds` order and existing process/output order; only report blocked when no useful target-chain reaction can run.
- Test strategy: tests-after using existing Jest runtime tests, with agent-executed QA only.

### Metis Review (gaps addressed)
- Keep the `reagentLabIds.length === 1` disable guard; it is unrelated and correct.
- Do not change `planHubImports()`, `planHubDistribution()`, `writeSynthesisConfig()`, market/resourceControl/carrier logic, or global reaction constants.
- Verify explicit `enabled:false` still blocks the room after removing the empty-reactions disable rule.
- Update existing blocked-behavior tests that will change under progressive feasible-step planning.
- Test incoming resource accounting, true no-reaction blocked state, distributing state, auto-OH behavior, and integration between hub planner and synthesis control.

## Work Objectives
### Core Objective
Make hub production resilient under partial resource availability: a hub-managed synthesis room with empty reactions should idle/cleanup rather than masquerade as disabled, and the hub planner should schedule any feasible configured-target-chain reaction before declaring the hub blocked.

### Deliverables
- Minimal `synthesisControl.ts` normalization fix.
- Progressive feasible-step planning in `hubPlanner.ts`.
- Updated and new Jest tests in `src/runtime/hubPlanner.test.ts`, `src/runtime/hubProductionIntegration.test.ts`, and the existing synthesis-control test area.
- Verification evidence saved under `.sisyphus/evidence/`.

### Definition of Done (verifiable conditions with commands)
- `npx tsc --noEmit` exits 0.
- `npm run test` exits 0.
- `npm run push` exits 0 after final verification approval.
- Direct tests prove `enabled:true, reactions:[]` is not normalized into `room_config_disabled`.
- Direct tests prove partial base minerals can produce useful intermediate steps instead of hub blocked.
- Integration tests prove hub blocked-by-total-T3-shortage no longer clears production when an intermediate step is feasible.

### Must Have
- Empty reactions mean “no active plan / paused / distributing”, not “disabled”, unless `enabled:false` is explicit.
- Progressive planning must only schedule products that contribute to configured T3 target chains.
- Prioritize by configured `targetCompounds` order; within a target path, prefer existing dependency/output order and avoid adding new configuration.
- Preserve incoming transfer accounting through `getIncomingResourceTransferAmount()`.
- Preserve true blocked behavior when no useful reaction has available reagents.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Must not alter market behavior, resourceControl, terminal transfer execution, carrier tasks, mineral mining, lab topology resolution, or synthesis state-machine stages.
- Must not preserve stale hub reactions when the planner has no feasible reaction.
- Must not add new config fields.
- Must not change `REACTION_MAP`, `BASE_MINERALS`, `INTERMEDIATE_COMPOUNDS`, or `T3_TARGETS` constants.
- Must not require manual Screeps console testing for acceptance.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after with existing Jest runtime tests.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (`quick`) synthesis normalization, Task 2 (`deep`) progressive planner algorithm, Task 3 (`quick`) direct regression tests.
Wave 2: Task 4 (`deep`) integration tests/update changed hub behavior, Task 5 (`quick`) targeted affected-test cleanup.
Wave 3: Task 6 (`unspecified-high`) full verification and deploy.

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | none | 4, 6 |
| 2 | none | 3, 4, 5, 6 |
| 3 | 2 | 6 |
| 4 | 1, 2 | 6 |
| 5 | 2 | 6 |
| 6 | 1, 2, 3, 4, 5 | Final Verification |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|------|------------|------------|
| 1 | 3 | quick, deep, quick |
| 2 | 2 | deep, quick |
| 3 | 1 | unspecified-high |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Keep empty synthesis reactions enabled unless explicitly disabled

  **What to do**: In `src/runtime/synthesisControl.ts`, delete only the normalization block at lines 226-228 that sets `roomCfg.enabled = false` when `roomCfg.reactions.length === 0`. Leave the `reagentLabIds.length > 0 && reagentLabIds.length < 2` guard at lines 230-232 unchanged. Add black-box tests through existing synthesis runtime entry points rather than exporting private `normalizeRoomConfig`: configure a room with `Memory.cfg.synthesisControl.enabled = true`, room config `enabled: true`, `reactions: []`, valid room/terminal/labs, then run `runSynthesisControl()` and assert the runtime room is not `stage:"blocked"` with `lastError:"room_config_disabled"`. Add a second test where `enabled:false` is explicit and assert `stage:"blocked"` and `lastError:"room_config_disabled"` still occur.
  **Must NOT do**: Do not export `normalizeRoomConfig`; do not change lab topology resolution; do not change synthesis stage names; do not remove the single-reagent-lab disable guard.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: small, localized logic change with targeted tests.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No UI/browser interaction.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 4, 6 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Bug source: `src/runtime/synthesisControl.ts:196-235` - `normalizeRoomConfig()` currently conflates empty reactions with disabled.
  - Runtime disabled branch: `src/runtime/synthesisControl.ts:1098-1111` - explicit disabled branch writes `room_config_disabled`.
  - Only known error-string consumer: `src/runtime/synthesisControl.ts:1107` - `ast_grep_search` found no other `"room_config_disabled"` usage.
  - Integration pattern: `src/runtime/hubProductionIntegration.test.ts:247-319` - config + `runSynthesisControl()` assertions for non-blocked synthesis state.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `grep -R "roomCfg.reactions.length === 0" src/runtime/synthesisControl.ts` returns no match.
  - [ ] A Jest test proves `enabled:true, reactions:[]` does not produce `lastError:"room_config_disabled"`.
  - [ ] A Jest test proves explicit `enabled:false` still produces `lastError:"room_config_disabled"`.
  - [ ] `npx tsc --noEmit` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Empty hub reactions idle instead of disabled
    Tool: Bash
    Steps: Run the targeted Jest test added for `enabled:true, reactions:[]` using `npm run test -- --runInBand src/runtime/<chosen-test-file>.test.ts -t "empty reactions"`.
    Expected: Test exits 0; assertion confirms no `room_config_disabled` runtime error.
    Evidence: .sisyphus/evidence/task-1-empty-reactions.txt

  Scenario: Explicit disable still blocks
    Tool: Bash
    Steps: Run the targeted Jest test added for explicit `enabled:false` using `npm run test -- --runInBand src/runtime/<chosen-test-file>.test.ts -t "explicit enabled false"`.
    Expected: Test exits 0; assertion confirms `stage:"blocked"` and `lastError:"room_config_disabled"`.
    Evidence: .sisyphus/evidence/task-1-explicit-disable.txt
  ```

  **Commit**: YES | Message: `fix(synthesis): keep empty hub reactions enabled` | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/*synthesis*.test.ts` or `src/runtime/hubProductionIntegration.test.ts`]

- [x] 2. Rewrite hub chain planning as progressive feasible-step scheduling

  **What to do**: In `src/runtime/hubPlanner.ts`, change `planHubChains()` from aggregate all-target blocking to ordered feasible-step selection. Preserve the public function name and keep the existing three-argument call compatibility by adding an optional fourth parameter: `targetCompounds: ResourceConstant[] = T3_TARGETS`. Update `runHubPlanner()` at line 709 to pass the already-normalized `targetCompounds` from lines 705-706 into `planHubChains(hubInventory, incomingResources, chainTarget, targetCompounds)`. Algorithm decision: (1) merge `hubInventory` and healthy `incomingResources` into `available`; (2) seed demand only for `targetCompounds`, not all hard-coded T3 targets; (3) recursively propagate deficits down `REACTION_MAP` using existing `PROCESS_ORDER`; (4) build candidate `ChainStep`s from existing `OUTPUT_ORDER`, but include a product only when it has positive downstream demand and both direct reagents exist in `available`; (5) candidate amount is `min(needed[product], available[reagentA], available[reagentB])`, capped to a positive integer; (6) order candidates by configured target path priority, then by existing output/dependency order so useful T3 steps outrank their intermediates when direct reagents are available; (7) return `blocked:false` when `steps.length > 0`; (8) return `blocked:false, steps:[]` only when all configured targets and intermediates are already at reserve (distributing); (9) return `blocked:true, steps:[]` only when there is unmet demand and no candidate reaction has both direct reagents. `missingResources` should report base minerals that block every remaining demanded path, not aggregate shortages for already-progressable paths.
  **Must NOT do**: Do not change `REACTION_MAP`, `PROCESS_ORDER`, `OUTPUT_ORDER` membership, `BASE_MINERALS`, `INTERMEDIATE_COMPOUNDS`, `T3_TARGETS`, `writeSynthesisConfig()` target semantics, `planHubImports()`, `planHubDistribution()`, market/resourceControl, or carrier logic.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: algorithmic change in a behavior-dense runtime planner.
  - Skills: [] - No external docs required.
  - Omitted: [`frontend-ui-ux`, `playwright`] - No UI/browser work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 3, 4, 5, 6 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Current all-or-nothing algorithm: `src/runtime/hubPlanner.ts:231-337` - `planHubChains()` seeds all `T3_TARGETS`, computes base needs, and blocks on aggregate missing bases.
  - T3/processing order constants: `src/runtime/hubPlanner.ts:134-223` - reuse existing reaction and output order.
  - Runtime caller: `src/runtime/hubPlanner.ts:704-722` - caller already computes configured `targetCompounds` and currently blocks/clears reactions on `result.blocked`.
  - Config normalization: `src/runtime/hubPlanner.ts:35-80` - preserve default target-compound behavior.
  - Target amount writer: `src/runtime/hubPlanner.ts:515-558` - `ChainStep.targetAmount` is a delta; writer adds existing inventory to make synthesis target absolute.
  - Reference search: `lsp_find_references` found callers at `src/runtime/hubPlanner.ts:709` plus direct tests in `src/runtime/hubPlanner.test.ts`; optional fourth parameter avoids breaking test call sites.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `planHubChains({ H: 15000, O: 15000, U: 10000, L: 10000, X: 10000 }, {}, 1000, [XUHO2])` returns `blocked:false` with at least one useful U/O/H-path step and does not require K/Z.
  - [ ] `planHubChains({ H: 1000, O: 1000 }, {}, 1000, [XGHO2])` returns `blocked:false` with `OH` before any impossible G/T3 step.
  - [ ] `planHubChains({}, {}, 1000, [XGHO2])` returns `blocked:true` and `steps:[]`.
  - [ ] When configured targets are already at reserve, result is `blocked:false` and `steps:[]`.
  - [ ] `npx tsc --noEmit` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Feasible intermediate prevents blocked hub
    Tool: Bash
    Steps: Run the direct `planHubChains` Jest case for H+O available but K/Z unavailable.
    Expected: Test exits 0; result includes `RESOURCE_HYDROXIDE`, `blocked` is false.
    Evidence: .sisyphus/evidence/task-2-oh-fallback.txt

  Scenario: No reagent pair remains truly blocked
    Tool: Bash
    Steps: Run the direct `planHubChains` Jest case with empty inventory and no incoming resources.
    Expected: Test exits 0; result has `blocked:true`, `steps:[]`, and non-empty `missingResources`.
    Evidence: .sisyphus/evidence/task-2-true-blocked.txt
  ```

  **Commit**: YES | Message: `fix(hub): schedule feasible intermediate synthesis` | Files: [`src/runtime/hubPlanner.ts`]

- [x] 3. Add direct hub planner regression tests for progressive scheduling

  **What to do**: Extend `src/runtime/hubPlanner.test.ts` around the existing `planHubChains` tests (`src/runtime/hubPlanner.test.ts:160-199`). Add focused tests for progressive scheduling: (a) H+O available while K/Z unavailable produces `RESOURCE_HYDROXIDE` and `blocked:false`; (b) U+O/H path available while K/Z unavailable produces U-chain intermediates such as `RESOURCE_UTRIUM_OXIDE` or `RESOURCE_UTRIUM_HYDRIDE` when targeting XUHO2/XUH2O; (c) empty inventory remains `blocked:true`; (d) all targets already at reserve remains `blocked:false` with `steps:[]`; (e) healthy incoming resources count as available; (f) blocked incoming transfer resources remain excluded by `getIncomingResourceTransferAmount()` and must not make the planner distribute falsely; (g) auto-OH behavior remains available when H/O are present. Update the legacy test at `src/runtime/hubPlanner.test.ts:180-198` so partial minerals no longer expect hub blocked when an intermediate can be produced.
  **Must NOT do**: Do not weaken assertions to only check “some step exists”; assert exact representative products and `blocked` values.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: direct test additions using existing test harness.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No browser work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 6 | Blocked By: 2

  **References** (executor has NO interview context - be exhaustive):
  - Existing direct tests: `src/runtime/hubPlanner.test.ts:160-199` - update changed partial-mineral expectation.
  - Reference call sites: `src/runtime/hubPlanner.test.ts:2412-2419` - all-T3 resolvability smoke test must remain meaningful with optional fourth parameter.
  - Incoming-resource tests: `src/runtime/hubPlanner.test.ts:1940-2072` - blocked incoming should still not count.

  **Acceptance Criteria** (agent-executable only):
  - [ ] At least six direct `planHubChains` tests cover feasible intermediate, U-chain intermediate, no reagents blocked, distributing complete, incoming resource accounting, and auto-OH preservation.
  - [ ] Legacy partial-mineral test no longer expects blocked when a feasible intermediate is available.
  - [ ] `npm run test -- --runInBand src/runtime/hubPlanner.test.ts` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Direct planner suite validates fallback
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "progressive"` after naming the new describe/test block with "progressive".
    Expected: Command exits 0 and includes tests for OH and U-chain fallback.
    Evidence: .sisyphus/evidence/task-3-progressive-tests.txt

  Scenario: Existing planner suite remains green
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts`.
    Expected: Command exits 0 with all hub planner tests passing.
    Evidence: .sisyphus/evidence/task-3-hub-planner-suite.txt
  ```

  **Commit**: YES | Message: `test(hub): cover progressive chain planning` | Files: [`src/runtime/hubPlanner.test.ts`]

- [x] 4. Add hub/synthesis integration coverage for blocked-to-intermediate recovery

  **What to do**: Add or update integration tests so the actual `runHubPlanner()` → `runSynthesisControl()` pipeline proves the E4N58 class of failure is fixed. Use `src/runtime/hubProductionIntegration.test.ts:220-245` as the primary pattern for a room receiving a hub-written synthesis config and then entering a non-blocked synthesis state. Add a scenario where hub target is a T3 whose full chain cannot currently complete because K/Z or another base is missing, but H/O or U/O reagents exist; after `runHubPlanner()`, assert `Memory.runtime.hub.status === "importing"`, `Memory.cfg.synthesisControl.rooms[room].enabled === true`, and first reaction is a useful intermediate such as `RESOURCE_HYDROXIDE` or `RESOURCE_UTRIUM_OXIDE`. Then run `runSynthesisControl()` and assert the synthesis room is not `stage:"blocked"` and does not have `lastError:"room_config_disabled"`. Add a second integration scenario for `enabled:true, reactions:[]` with hub distributing/all-complete: after `runSynthesisControl()`, assert idle/cleanup behavior, not disabled.
  **Must NOT do**: Do not require Screeps console/manual state mutation; do not skip room/terminal/lab mocks needed by existing helpers.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: cross-module behavior and runtime memory interactions.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No browser verification.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 6 | Blocked By: 1, 2

  **References** (executor has NO interview context - be exhaustive):
  - Integration pattern: `src/runtime/hubProductionIntegration.test.ts:220-245` - run hub planner then synthesis control.
  - Preset synthesis config pattern: `src/runtime/hubProductionIntegration.test.ts:247-319` - explicit synthesis config and status assertions.
  - Hub planner blocked branch: `src/runtime/hubPlanner.ts:717-722` - should now only occur when no feasible reaction exists.
  - Synthesis empty-reactions path: `src/runtime/synthesisControl.ts:1141-1214` - activePlan-null branch should idle/cleanup and signal planning, not disabled.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Integration test proves partial resources produce an intermediate reaction config and hub status `importing`.
  - [ ] Integration test proves `runSynthesisControl()` after that config is not blocked by `room_config_disabled`.
  - [ ] Integration test proves empty reactions with `enabled:true` after distributing/all-complete does not create `room_config_disabled`.
  - [ ] `npm run test -- --runInBand src/runtime/hubProductionIntegration.test.ts` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: E4N58-style partial resources recover to intermediate production
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubProductionIntegration.test.ts -t "intermediate"` after naming the new test with "intermediate".
    Expected: Command exits 0; assertions show hub writes an intermediate reaction and synthesis room is not `room_config_disabled`.
    Evidence: .sisyphus/evidence/task-4-intermediate-integration.txt

  Scenario: Distributing/empty reactions do not disable synthesis room
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubProductionIntegration.test.ts -t "empty reactions"`.
    Expected: Command exits 0; assertions show no `room_config_disabled` error.
    Evidence: .sisyphus/evidence/task-4-empty-reactions-integration.txt
  ```

  **Commit**: YES | Message: `test(hub): cover intermediate production recovery` | Files: [`src/runtime/hubProductionIntegration.test.ts`]

- [x] 5. Update affected hub blocked/import/distribution regression tests without weakening guardrails

  **What to do**: Review and update specific hub tests whose old expectations assumed aggregate T3 shortage meant `blocked`. Required tests to inspect: `src/runtime/hubPlanner.test.ts:1194-1203`, `src/runtime/hubPlanner.test.ts:1775-1808`, `src/runtime/hubPlanner.test.ts:1963-2013`, `src/runtime/hubPlanner.test.ts:2015-2072`, and `src/runtime/hubPlanner.test.ts:2412-2419`. New policy: if any useful intermediate is feasible, assert `status:"importing"` and reaction config exists; if no useful reagent pair exists, assert `status:"blocked"`; if distribution should happen while production is importing, keep export-task assertions but update comments/status assertions accordingly. Preserve the existing blocked incoming transfer guarantee: a blocked pending import must not make the hub enter `distributing`, though it may still enter `importing` for a different feasible intermediate. For the all-10-T3 resolvability smoke test at lines 2412-2419, do not keep calling `planHubChains({}, {}, 1000)` expecting T3 steps; change it to either provide sufficient base/intermediate inventory for each target or assert dependency graph coverage separately without availability semantics.
  **Must NOT do**: Do not delete regression cases; do not replace precise resource assertions with broad truthy checks; do not change distribution task creation behavior.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: targeted test expectation update after algorithm change.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No UI/browser work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 6 | Blocked By: 2

  **References** (executor has NO interview context - be exhaustive):
  - No-internal-source test: `src/runtime/hubPlanner.test.ts:1194-1203` - remains blocked only when no reaction can run.
  - Missing base minerals integration: `src/runtime/hubPlanner.test.ts:1775-1808` - should become importing if H/O or U/O can produce intermediates.
  - Distribution while chain constrained: `src/runtime/hubPlanner.test.ts:1963-2013` - keep export assertion; update blocked/importing status based on feasible intermediate availability.
  - Blocked incoming import regression: `src/runtime/hubPlanner.test.ts:2015-2072` - still must not distribute based on blocked incoming resources.
  - All-T3 resolvability smoke test: `src/runtime/hubPlanner.test.ts:2412-2419` - update because empty inventory should now mean true blocked, not full abstract chain output.

  **Acceptance Criteria** (agent-executable only):
  - [ ] All five listed test regions are reviewed and either updated or explicitly left unchanged with a test comment explaining why true blocked remains correct.
  - [ ] Export/distribution assertions remain present for the XGHO2 stock case.
  - [ ] Blocked incoming Z still does not count as available and does not produce a false distributing state.
  - [ ] `npm run test -- --runInBand src/runtime/hubPlanner.test.ts` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Updated blocked/importing regressions are precise
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "blocked|missing base|pending Z|export"`.
    Expected: Command exits 0; constrained scenarios assert either true blocked or importing based on feasible direct reagents.
    Evidence: .sisyphus/evidence/task-5-regression-subset.txt

  Scenario: Full hub planner regressions pass
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts`.
    Expected: Command exits 0 with no skipped or deleted regression coverage.
    Evidence: .sisyphus/evidence/task-5-hub-planner-full.txt
  ```

  **Commit**: YES | Message: `test(hub): update blocked scheduling regressions` | Files: [`src/runtime/hubPlanner.test.ts`]

- [x] 6. Run full verification, capture evidence, and deploy after approval

  **What to do**: Run project-wide verification after Tasks 1-5. Execute `npx tsc --noEmit`, `npm run test`, and inspect changed tests for accidental `.only`/skips. Save command output to evidence files. After the Final Verification Wave (F1-F4) passes and the user explicitly approves, run `npm run push` to deploy to Screeps per project workflow memory. If `npm run push` fails, stop and report the exact failure; do not retry with credential changes or modify `.secret.json`.
  **Must NOT do**: Do not deploy before final wave approval; do not use `--no-verify`; do not change credentials; do not mark final verification items complete before user approval.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: whole-project validation and deployment workflow.
  - Skills: [] - No special skill required.
  - Omitted: [`git-master`] - Only use if user explicitly asks for commits in the execution session.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: Final Verification | Blocked By: 1, 2, 3, 4, 5

  **References** (executor has NO interview context - be exhaustive):
  - Commands: project `AGENTS.md` lists `npm run build`, `npx tsc --noEmit`, `npm run test`, `npm run push`.
  - Deployment workflow memory: deploy via `npm run push` after successful TypeScript/Jest verification and final approval.
  - Secret guardrail: `.secret.json` contains deploy credentials; never commit or edit it.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx tsc --noEmit` exits 0; output saved to `.sisyphus/evidence/task-6-tsc.txt`.
  - [ ] `npm run test` exits 0; output saved to `.sisyphus/evidence/task-6-jest.txt`.
  - [ ] Search confirms no committed `.only(` or accidental skipped focused tests in touched test files.
  - [ ] After user approval of Final Verification Wave, `npm run push` exits 0; output saved to `.sisyphus/evidence/task-6-push.txt`.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Whole-project static and test verification
    Tool: Bash
    Steps: Run `npx tsc --noEmit && npm run test`.
    Expected: Command exits 0; no TypeScript errors and no Jest failures.
    Evidence: .sisyphus/evidence/task-6-full-verification.txt

  Scenario: Post-approval deployment
    Tool: Bash
    Steps: After F1-F4 approval and explicit user okay, run `npm run push`.
    Expected: Command exits 0 and Rollup uploads `dist/main.js` to Screeps.
    Evidence: .sisyphus/evidence/task-6-push.txt
  ```

  **Commit**: NO | Message: `N/A` | Files: []

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit 1: `fix(synthesis): keep empty hub reactions enabled` — `src/runtime/synthesisControl.ts` plus direct normalization/behavior tests.
- Commit 2: `fix(hub): schedule feasible intermediate synthesis` — `src/runtime/hubPlanner.ts` plus planner unit tests.
- Commit 3: `test(hub): cover progressive production integration` — integration and affected regression test updates.

## Success Criteria
- Empty-reactions hub room no longer reports `room_config_disabled` unless explicitly disabled.
- Hub planner can produce useful intermediate products when full T3 chains are not immediately finishable.
- Existing distribution/import guardrails remain intact.
- TypeScript, Jest, final review wave, and `npm run push` all pass.
