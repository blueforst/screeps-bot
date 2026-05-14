# Synthesis Product Lab Unload Thresholds

## TL;DR
> **Summary**: Change synthesis-control product-lab unload task generation so carriers unload product labs during active synthesis only when a product lab holds more than 700 units, and unload every positive remaining amount after synthesis/cleanup completion paths.
> **Deliverables**:
> - `src/runtime/synthesisControl.ts` threshold-parametrized product unload task generation.
> - Focused regression tests in `src/runtime/synthesisControlStateMachine.test.ts` for active synthesis, completion cleanup, product switching, and stage suppression.
> - Evidence from focused Jest, full Jest, and TypeScript verification.
> **Effort**: Short
> **Parallel**: YES - 2 implementation waves + final verification wave
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Final Verification

## Context
### Original Request
User said: “在合成过程中, 只需要产品lab中的资源数量大于700, 就让carrier卸货. 而合成完成后, 无论多少, 都需要卸货”

### Interview Summary
- In-progress synthesis rule: product lab amount must be strictly greater than 700 before a carrier unload task is generated.
- Post-completion rule: any positive amount in product labs should be unloaded.
- Test strategy: tests-after with existing Jest regression infrastructure.
- Scope: synthesis-control task generation and tests only; carrier execution is already generic for `lab_product_unload` board tasks.

### Metis Review (gaps addressed)
- Metis identified the `prevProductUnloadTask` product-switch path as an easy-to-miss cleanup call site; include it with post-completion threshold `1`.
- Metis identified the boundary ambiguity between `>700` and `>=700`; default applied: use strict `>700`, implemented as `minLabAmount = 701` for integer Screeps resource amounts.
- Metis identified all product-unload generator call sites: null-plan direct, null-plan stranded, active-plan current product, and active-plan previous product.
- Metis guardrail: do not change `carrier.ts`, reagent cleanup, contamination cleanup, acquiring/loading suppression, or the target-amount guard.

## Work Objectives
### Core Objective
Make product-lab unload task generation match the user’s threshold rules without changing carrier task execution semantics.

### Deliverables
- `generateProductUnloadTask()` accepts a per-call minimum lab amount and uses it instead of a hardcoded `700`.
- `generateStrandedProductUnloadTask()` accepts a per-call minimum lab amount and uses it instead of a hardcoded `700`.
- Active `synthesizing` stage generates `lab_product_unload` tasks for product labs with amount `>= 701`.
- Post-completion/cleanup paths generate `lab_product_unload` tasks for product labs with amount `>= 1`.
- Regression tests cover strict boundary and unchanged `acquiring`/`loading` suppression.

### Definition of Done (verifiable conditions with commands)
- `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts -t "batch-complete unload gate"` exits 0.
- `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts` exits 0.
- `npx tsc --noEmit` exits 0.
- `npm run test` exits 0.

### Must Have
- During `synthesizing`, amount `700` exactly does **not** create `lab_product_unload`; amount `701` or more does.
- After completion/null-plan cleanup, amount `1` or more creates `lab_product_unload`.
- Previous-product cleanup on product switch unloads amount `1` or more.
- Existing `acquiring` and `loading` suppression remains unchanged.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do not edit `src/roles/carrier.ts`; carrier pickup/delivery already handles task-board steps.
- Do not edit `src/runtime/carrierTaskBoard.ts`; board storage is generic and sufficient.
- Do not change `generateCleanupTask()` or `generateReagentCleanupTask()`.
- Do not remove or weaken `generateProductUnloadTask()`’s `transferableCurrent >= targetAmount` guard.
- Do not broaden unload behavior to `acquiring` or `loading`.
- Do not introduce magic booleans like `force`; use a named numeric threshold parameter such as `minLabAmount`.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after + Jest/ts-jest.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (implementation + focused regressions)
Wave 2: Task 2 (full verification and evidence)

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1. Implement threshold behavior with focused regressions | none | 2 |
| 2. Run verification and capture evidence | 1 | Final Verification |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|---|---:|---|
| 1 | 1 | quick |
| 2 | 1 | unspecified-high |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Implement product-lab unload threshold behavior with focused regressions

  **What to do**:
  - In `src/runtime/synthesisControl.ts`, update `generateProductUnloadTask(room, productLabs, product, targetAmount)` to accept a final optional parameter named `minLabAmount` with default `700`.
  - Replace the hardcoded per-lab filter `amount < 700` with `amount < minLabAmount`.
  - In the same file, update `generateStrandedProductUnloadTask(room, productLabs, roomCfg, autoPlan?)` to accept a final optional `minLabAmount = 700` parameter.
  - Replace that function’s hardcoded stranded-product filter `amount < 700` with `amount < minLabAmount`.
  - Keep both function defaults at `700` to avoid accidental behavior changes if any call site is missed.
  - In the null-plan branch of `src/runtime/synthesisControl.ts` where `!activePlan` is handled, pass `minLabAmount = 1` to `generateProductUnloadTask(...)` for the `unloadProduct && unloadTarget` path.
  - In the same null-plan branch, pass `minLabAmount = 1` to `generateStrandedProductUnloadTask(...)`.
  - In the active-plan branch, change the product-unload stage gate from “not synthesizing/acquiring/loading” to “not acquiring/loading”.
  - For the active current-product unload call, pass `minLabAmount = stage === "synthesizing" ? 701 : 1`.
  - For `prevProductUnloadTask`, pass `minLabAmount = 1` because product-switch cleanup is a completion/cleanup path.
  - Preserve `hasContamination` suppression exactly as before.
  - Edit `src/runtime/synthesisControlStateMachine.test.ts` in the existing `batch-complete unload gate (Bug A regression)` area.
  - Keep or rename the old synthesizing-mid-batch test so it asserts product amount below threshold still creates no unload task.
  - Add a boundary test: `stage = "synthesizing"`, product lab amount `700`, expected no `lab_product_unload`.
  - Add a positive threshold test: `stage = "synthesizing"`, product lab amount `705` (or exact `701` if helper setup is convenient), expected `lab_product_unload` exists and first step amount equals that product amount.
  - Add a null-plan/post-completion small-residue test: `chooseActivePlan()` returns null because target is met, product lab holds e.g. `50`, expected `lab_product_unload` exists with step amount `50`.
  - Add a previous-product-switch cleanup test: room state active product differs from selected active plan, old product lab holds e.g. `45`, expected previous-product `lab_product_unload` exists with step amount `45`.
  - Add or preserve a loading-stage suppression assertion: `stage = "loading"`, product lab amount `50`, expected no current-product unload.
  - Keep the existing acquiring-stage suppression test passing.

  **Must NOT do**:
  - Do not change task priorities (`lab_product_unload` remains priority 180).
  - Do not change destination resolution or target-amount logic.
  - Do not rename task types or carrier task step fields.
  - Do not allow product unload during `acquiring` or `loading`.
  - Do not change reaction selection, batch sizing, reagent supply, or stage-transition logic.
  - Do not convert strict `>700` to `>=700`; use threshold `701` for in-progress synthesis.
  - Do not add shared test helper modules unless unavoidable; use the existing inline helper style in this test file.
  - Do not update carrier tests unless focused synthesis-control tests prove carrier behavior is insufficient.
  - Do not weaken existing contamination/reagent cleanup expectations.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused behavior change in one runtime file plus one test file with existing helper patterns.
  - Skills: [] - no extra skill needed.
  - Omitted: [`screeps-game-data`] - live game data is not needed.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/synthesisControl.ts:757` - `generateProductUnloadTask()` creates `lab_product_unload` tasks and currently owns the main threshold.
  - Pattern: `src/runtime/synthesisControl.ts:810` - `generateStrandedProductUnloadTask()` handles idle/no-activeProduct stranded recovery and currently owns a second threshold.
  - API/Type: `src/runtime/carrierTaskBoard.ts` - `CarrierTaskDraft`/task-board structure should remain unchanged.
  - Pattern: `src/runtime/synthesisControl.ts:1139` - null-plan branch for post-completion/target-met cleanup.
  - Pattern: `src/runtime/synthesisControl.ts:1142` - direct post-completion product unload call; use threshold `1`.
  - Pattern: `src/runtime/synthesisControl.ts:1148` - stranded recovery call; use threshold `1`.
  - Pattern: `src/runtime/synthesisControl.ts:1261` - active-plan product-unload stage gate; allow `synthesizing`, keep `acquiring`/`loading` blocked.
  - Pattern: `src/runtime/synthesisControl.ts:1264` - previous-product unload on product switch; use threshold `1`.
  - Test: `src/runtime/synthesisControlStateMachine.test.ts:1557` - `batch-complete unload gate (Bug A regression)` is the correct block for new active-synthesis threshold tests.
  - Test: `src/runtime/synthesisControlStateMachine.test.ts:1568` - old “does not generate product unload during synthesizing” test must be updated to clarify it applies below threshold.
  - Test: `src/runtime/synthesisControlStateMachine.test.ts:1618` - existing target-met/post-completion test is a pattern for null-plan cleanup assertions.
  - Test: `src/runtime/synthesisControlStateMachine.test.ts:1671` - acquiring suppression should remain.
  - Pattern: `src/runtime/synthesisControlStateMachine.test.ts` helper functions `setConfig`, `setRoomStage`, `createSynthesisRoom`, and `getCarrierTasksByRoom` are the established style.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `generateProductUnloadTask` and `generateStrandedProductUnloadTask` compile with optional `minLabAmount` parameters.
  - [ ] Both functions still default to threshold `700` if called without the new argument.
  - [ ] Active `synthesizing` call uses `701` as the minimum lab amount.
  - [ ] Null-plan direct, null-plan stranded, and previous-product cleanup calls use `1` as the minimum lab amount.
  - [ ] `acquiring` and `loading` still do not generate current-product unload tasks.
  - [ ] Focused tests prove `synthesizing` amount `700` does not unload.
  - [ ] Focused tests prove `synthesizing` amount above `700` unloads.
  - [ ] Focused tests prove post-completion amount below `700` unloads.
  - [ ] Focused tests prove previous-product amount below `700` unloads.
  - [ ] Focused tests prove `acquiring` and `loading` suppression remains.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Focused batch-complete unload gate regressions
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts -t "batch-complete unload gate"`.
    Expected: Command exits 0; output shows the updated/new tests pass.
    Evidence: .sisyphus/evidence/task-1-batch-complete-unload-gate.txt

  Scenario: Full synthesis-control state machine regressions
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts`.
    Expected: Command exits 0; no failed tests in the full state-machine file.
    Evidence: .sisyphus/evidence/task-1-state-machine-jest.txt
  ```

  **Commit**: NO | Message: `fix(synthesis): adjust product lab unload thresholds` | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/synthesisControlStateMachine.test.ts`]

- [x] 2. Run final implementation verification and preserve evidence

  **What to do**:
  - Run focused Jest for the updated block.
  - Run the full synthesis-control state-machine test file.
  - Run TypeScript type checking.
  - Run the full Jest suite.
  - Save command outputs or summaries to the evidence paths listed below.
  - If any verification fails, fix the implementation/tests and rerun the failed command plus any downstream commands.

  **Must NOT do**:
  - Do not claim completion without command evidence.
  - Do not skip full `npm run test` unless dependency/environment failure is unrelated and documented with exact stderr.
  - Do not run `npm run push` or deploy.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: verification requires interpreting failures across tests/types and preserving evidence.
  - Skills: [] - no extra skill needed.
  - Omitted: [`screeps-game-data`] - no live runtime read required for deterministic tests.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: Final Verification | Blocked By: 1

  **References** (executor has NO interview context - be exhaustive):
  - Command: `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts -t "batch-complete unload gate"` - focused regression.
  - Command: `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts` - full state-machine coverage.
  - Command: `npx tsc --noEmit` - type checking after parameter additions.
  - Command: `npm run test` - full regression suite.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Focused Jest command exits 0.
  - [ ] Full state-machine Jest command exits 0.
  - [ ] TypeScript command exits 0.
  - [ ] Full Jest suite exits 0.
  - [ ] Evidence files exist under `.sisyphus/evidence/` for each command.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: All required verification passes
    Tool: Bash
    Steps: Run all four commands listed in References from repository root.
    Expected: Every command exits 0.
    Evidence: .sisyphus/evidence/task-2-verification-summary.txt

  Scenario: No accidental deploy or generated output included
    Tool: Bash
    Steps: Run `git status --short` after verification.
    Expected: Only intended source/test files and `.sisyphus/evidence/*` are modified/untracked; no `dist/` deploy artifact or secret file appears.
    Evidence: .sisyphus/evidence/task-2-git-status.txt
  ```

  **Commit**: NO | Message: `fix(synthesis): adjust product lab unload thresholds` | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/synthesisControlStateMachine.test.ts`, `.sisyphus/evidence/*`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Do not commit unless the user explicitly requests commits.
- If the user requests commits after implementation, prefer one atomic commit after all verification passes:
  - `fix(synthesis): adjust product lab unload thresholds`
- Commit should include only `src/runtime/synthesisControl.ts`, `src/runtime/synthesisControlStateMachine.test.ts`, and any explicitly requested evidence artifacts.

## Success Criteria
- Product lab unload tasks appear during `synthesizing` only for product-lab amounts strictly greater than 700.
- Product lab unload tasks appear after completion/cleanup for any positive product-lab amount.
- Previous-product cleanup does not strand amounts below 700.
- `acquiring` and `loading` stages remain protected from current-product unload generation.
- Carrier execution code remains unchanged.
- Focused Jest, full state-machine Jest, TypeScript, and full Jest suite all pass.
