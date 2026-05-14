# Link Misclassification Fix Plan

## TL;DR
> **Summary**: Fix Screeps link role classification so source-adjacent links always behave as sender links, even when they are also close to storage or controller. Preserve current miner/sourceLink behavior, cache cadence, carrier range behavior, and tick order while adding TDD regression coverage for every discovered misclassification path.
> **Deliverables**:
> - Pure link-role classifier with source-first precedence
> - Updated `classifyRoomLinks()`, `isReceiverLink()`, and `isStorageReceiverLink()` source-overlap behavior
> - Regression tests for source+storage, source+controller, triple-overlap, stale cache, normal receiver/sender, and linkControl transfer direction
> - Verification evidence from TypeScript and Jest
> **Effort**: Short
> **Parallel**: YES - 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5

## Context
### Original Request
用户原话：如果 source link 距离 storage 很近，会出现把这个 link 判定为 storage link 的问题（但是对于 miner，它还是 source link）。需要发现并提出所有 link 误判定问题的修复计划。

### Interview Summary
- The user requested a repair plan, not direct implementation in this session.
- Test strategy selected: **TDD first**.
- Default technical decision: source-adjacent links win over storage/controller receiver proximity because this matches existing miner behavior and prevents source output from becoming receiver-only.

### Metis Review (gaps addressed)
- Source precedence must apply both to cached room classification and positional fallback helpers; fixing only `classifyRoomLinks()` is insufficient.
- `sourceLink.ts` is independent and currently correct for miner/bootstrap/container-cleanup use; do not couple or refactor it.
- Carrier controller range mismatch is treated as intentionally out of scope unless tests reveal a direct source-overlap regression; do not change `carrier.ts`.
- Cache TTL and structure are not the root cause; do not change `CLASSIFY_INTERVAL` or `Memory.runtime.linkNetwork` shape.
- TDD must cover overlap, stale cache, helper fallback, and transfer direction.

## Work Objectives
### Core Objective
Make all link network classification decisions source-aware so a link near a source is never exposed as a storage/controller receiver or pickup target, even if it is also within receiver range.

### Deliverables
- `src/runtime/linkControl.ts` source-first classification helper and integration.
- Extended `src/runtime/linkControl.test.ts` coverage using existing inline mock style.
- Evidence files under `.sisyphus/evidence/` for test/typecheck results.

### Definition of Done (verifiable conditions with commands)
- `npm run test -- src/runtime/linkControl.test.ts` passes.
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- `git diff -- src/runtime/sourceLink.ts src/roles/miner.ts src/runtime/bootstrap.ts src/main.ts src/roles/carrier.ts` shows no behavior edits.

### Must Have
- Source+storage overlap at source range ≤2 and storage range ≤2 classifies as sender only.
- Source+controller overlap at source range ≤2 and controller range ≤3 classifies as sender only.
- Source+storage+controller triple-overlap classifies as sender only.
- Pure storage receiver and pure controller receiver behavior remains unchanged.
- `isReceiverLink()` returns false for source-overlap links with no cache and with stale receiver cache.
- `isStorageReceiverLink()` returns false for source-overlap links with no cache and with stale receiver cache.
- `runLinkControl()` transfers energy from overlap source links to real receivers.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Must not modify `src/runtime/sourceLink.ts`; miner/source adjacency detection remains independent.
- Must not modify `src/roles/miner.ts`, `src/runtime/bootstrap.ts`, `src/main.ts`, or tick order.
- Must not modify `src/roles/carrier.ts` or change controller adjacency range from 2 to 3.
- Must not change `CLASSIFY_INTERVAL = 11` or `Memory.runtime.linkNetwork` storage shape.
- Must not add console logging, new global exports, broad diagnostics, or room-planner changes.
- Must not rewrite the link system; keep the fix localized to `linkControl.ts` and tests.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD + Jest/ts-jest (`npm run test`) with focused RED/GREEN cycles.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 only, because all later tasks depend on the source-first classifier contract.
Wave 2: Tasks 2-5 can run sequentially by one implementer; do not parallelize file edits in the same test/source file.

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1 | None | 2, 3, 4, 5 |
| 2 | 1 | 3, 4, 5 |
| 3 | 1, 2 | 4, 5 |
| 4 | 1, 2, 3 | 5 |
| 5 | 1, 2, 3, 4 | Final verification |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|---|---:|---|
| 1 | 1 | quick |
| 2 | 4 | quick, unspecified-low |
| Final | 4 review agents | oracle, unspecified-high, unspecified-high, deep |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add source-first pure link classifier with RED/GREEN unit tests

  **What to do**: In `src/runtime/linkControl.test.ts`, first add failing tests for a pure classifier API in `src/runtime/linkControl.ts`. Then implement in `linkControl.ts`:
  - Export `type LinkRole = "sender" | "receiver" | "unclassified"`.
  - Export `function classifyLinkRole(link: StructureLink, sources: Source[], storagePos?: RoomPosition, controllerPos?: RoomPosition): LinkRole`.
  - Source precedence is absolute: if any source is within `SOURCE_SENDER_RANGE` (2), return `"sender"` before checking storage/controller.
  - If not source-adjacent and storage range ≤2 or controller range ≤3, return `"receiver"`.
  - Otherwise return `"unclassified"`.
  - Update `classifyRoomLinks(room)` to use `classifyLinkRole()` and populate `senderIds`/`receiverIds` from that role.
  **Must NOT do**: Do not change constants, cache TTL, memory shape, `sourceLink.ts`, or any role file.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: localized TypeScript + Jest change in one runtime file and one test file.
  - Skills: [`superpowers:test-driven-development`] - Required because user selected TDD first.
  - Omitted: [`frontend-ui-ux`, `playwright`] - No UI/browser surface.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: tasks 2, 3, 4, 5 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/linkControl.ts:26-57` - existing `classifyRoomLinks()` receiver-first loop to replace with role helper.
  - Constants: `src/runtime/linkControl.ts:5-10` - keep `SOURCE_SENDER_RANGE=2`, `STORAGE_RECEIVER_RANGE=2`, `CONTROLLER_RECEIVER_RANGE=3` unchanged.
  - Test: `src/runtime/linkControl.test.ts:3-35` - inline `createPosition()` / `createLink()` factory style to extend.
  - Source pipeline: `src/runtime/sourceLink.ts:17-45` - independent source-adjacent detection; do not modify.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/runtime/linkControl.test.ts` has tests asserting exact roles for: source+storage overlap → sender, source+controller overlap → sender, source+storage+controller overlap → sender, pure source → sender, pure storage → receiver, pure controller → receiver, distant link → unclassified.
  - [ ] `classifyRoomLinks()` uses `classifyLinkRole()` and never adds a link ID to both arrays.
  - [ ] `npm run test -- src/runtime/linkControl.test.ts` passes after GREEN implementation.
  - [ ] Evidence written to `.sisyphus/evidence/task-1-link-classifier.txt` with focused Jest output.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Source overlap wins classification
    Tool: Bash
    Steps: Run `npm run test -- src/runtime/linkControl.test.ts` after adding cases with sourceRange=2 and storageRange=2/controllerRange=3.
    Expected: Tests assert `classifyLinkRole(...) === "sender"` for all overlap cases and no receiver role leaks.
    Evidence: .sisyphus/evidence/task-1-link-classifier.txt

  Scenario: Existing receiver behavior preserved
    Tool: Bash
    Steps: Run the same focused test file containing existing controller/storage receiver tests plus new pure receiver cases.
    Expected: Existing receiver tests still pass; pure storage/controller links classify as receiver.
    Evidence: .sisyphus/evidence/task-1-link-classifier-regression.txt
  ```

  **Commit**: NO | Message: `fix(runtime): prioritize source links in classification` | Files: `src/runtime/linkControl.ts`, `src/runtime/linkControl.test.ts`

- [x] 2. Make receiver helper fallbacks source-aware and stale-cache safe

  **What to do**: Extend `src/runtime/linkControl.test.ts` first with failing helper tests, then update `src/runtime/linkControl.ts` helper logic:
  - Add internal `getRoomSourcesForLinkClassification(room: Room): Source[]` that prefers `getTickContextService().getRoomContext(room)?.getSources()` and falls back to `room.find(FIND_SOURCES)` only when `typeof room.find === "function"`; otherwise returns `[]` for simple mocks.
  - Update `isReceiverByPosition(link)` to call `classifyLinkRole(link, sources, storagePos, controllerPos) === "receiver"`.
  - Update `isStorageReceiverByPosition(link)` to return `false` immediately when `classifyLinkRole(...) === "sender"`, then keep existing storage/shared-cluster checks.
  - Update `isReceiverLink(link)` so source-adjacent current topology overrides stale cache: if source-aware positional role is `"sender"`, return `false` before checking `roomData.receiverIds`; otherwise preserve the existing cached OR positional behavior for non-source links.
  - Update `isStorageReceiverLink(link)` with the same source-overlap stale-cache guard: source-aware role `"sender"` returns `false`; non-source links keep the existing cached AND storage-position behavior.
  **Must NOT do**: Do not convert helper behavior to cache-only; non-source receiver positional fallback should still work for rooms without `Memory.runtime.linkNetwork`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: helper logic and tests in existing files.
  - Skills: [`superpowers:test-driven-development`] - Required for RED helper tests before implementation.
  - Omitted: [`git-master`] - Commit handled after all tasks.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: tasks 3, 4, 5 | Blocked By: task 1

  **References**:
  - Helper: `src/runtime/linkControl.ts:71-78` - `isReceiverByPosition()` currently ignores source proximity.
  - Helper: `src/runtime/linkControl.ts:80-96` - `isStorageReceiverByPosition()` currently ignores source proximity.
  - Cache helper: `src/runtime/linkControl.ts:185-200` - `isReceiverLink()` uses cached OR positional; `isStorageReceiverLink()` uses cached AND positional.
  - Runtime services pattern: `src/runtime/sourceLink.ts:25-32` - safe room-context/find fallback style.

  **Acceptance Criteria**:
  - [ ] With no `Memory.runtime.linkNetwork`, `isReceiverLink(source+storage overlap link)` returns `false`.
  - [ ] With no `Memory.runtime.linkNetwork`, `isStorageReceiverLink(source+storage overlap link)` returns `false`.
  - [ ] With stale `Memory.runtime.linkNetwork.W1N1.receiverIds` containing the overlap link ID, both helper functions still return `false` for current source-overlap topology.
  - [ ] Pure receiver links with no source adjacency still return the same values as existing tests.
  - [ ] Evidence written to `.sisyphus/evidence/task-2-helper-fallbacks.txt`.

  **QA Scenarios**:
  ```
  Scenario: No-cache fallback excludes source links
    Tool: Bash
    Steps: Set `Memory.runtime = undefined` in Jest setup for overlap-link helper tests, then run `npm run test -- src/runtime/linkControl.test.ts`.
    Expected: `isReceiverLink` and `isStorageReceiverLink` return false for source+storage overlap, true/false unchanged for existing pure receiver cases.
    Evidence: .sisyphus/evidence/task-2-helper-fallbacks.txt

  Scenario: Stale cache cannot resurrect source receiver
    Tool: Bash
    Steps: In Jest, set `Memory.runtime.linkNetwork.W1N1.receiverIds = [overlapLink.id]` and provide a current source within range 2.
    Expected: Both receiver helper assertions are false despite stale cached receiver ID.
    Evidence: .sisyphus/evidence/task-2-stale-cache.txt
  ```

  **Commit**: NO | Message: `fix(runtime): prioritize source links in classification` | Files: `src/runtime/linkControl.ts`, `src/runtime/linkControl.test.ts`

- [x] 3. Add room-runtime classification tests for sender/receiver arrays

  **What to do**: Add tests that exercise the room-level classification path through `runLinkControl()` or an exported testable wrapper without adding production-only APIs beyond `classifyLinkRole()` unless unavoidable. Preferred path: mock `@/runtime/runtimeServices` in `src/runtime/linkControl.test.ts` so `getTickContextService().getRoomContext(room)` returns deterministic links and sources, and `getMemoryService().ensureRuntime()` returns `Memory.runtime`.
  **Must NOT do**: Do not create a shared mock framework; keep inline test factories consistent with current project style.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Jest mocks and assertions in existing test file.
  - Skills: [`superpowers:test-driven-development`] - Tests specify expected runtime arrays before any further implementation changes.
  - Omitted: [`librarian`] - No external library/API research needed.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: tasks 4, 5 | Blocked By: tasks 1, 2

  **References**:
  - Runtime path: `src/runtime/linkControl.ts:59-69` - `getRoomLinkRuntime()` refreshes cached classification every 11 ticks.
  - Transfer path setup: `src/runtime/linkControl.ts:203-219` - `runLinkControl()` calls `getRoomLinkRuntime()` and resolves IDs with `Game.getObjectById`.
  - Test style: `src/runtime/linkControl.test.ts:38-76` - existing `describe()` blocks and `beforeEach()` memory reset.

  **Acceptance Criteria**:
  - [ ] A room with one overlap source+storage link and one pure storage receiver results in overlap ID in `senderIds` and pure receiver ID in `receiverIds` after runtime refresh.
  - [ ] A room with overlap source+controller link results in overlap ID in `senderIds`, not `receiverIds`.
  - [ ] A distant link appears in neither array.
  - [ ] Tests confirm sender and receiver arrays have no duplicate ID intersection.
  - [ ] Evidence written to `.sisyphus/evidence/task-3-runtime-arrays.txt`.

  **QA Scenarios**:
  ```
  Scenario: Runtime array classification follows source precedence
    Tool: Bash
    Steps: Run focused Jest tests that mock runtime services and inspect `Memory.runtime.linkNetwork.W1N1` after `runLinkControl()` with mixed overlap/receiver links.
    Expected: Overlap links only in `senderIds`; receiver links only in `receiverIds`; no ID appears in both arrays.
    Evidence: .sisyphus/evidence/task-3-runtime-arrays.txt

  Scenario: Unclassified links remain excluded
    Tool: Bash
    Steps: Include a link with source/storage/controller ranges beyond thresholds and run the same focused test.
    Expected: Distant link ID is absent from both arrays and no transfer attempt is made for it.
    Evidence: .sisyphus/evidence/task-3-unclassified.txt
  ```

  **Commit**: NO | Message: `fix(runtime): prioritize source links in classification` | Files: `src/runtime/linkControl.test.ts`, `src/runtime/linkControl.ts` if wrapper changes are necessary

- [x] 4. Add transfer-direction regression test for `runLinkControl()`

  **What to do**: Add an integration-style Jest test in `src/runtime/linkControl.test.ts` proving that an overlap source link sends energy to a real receiver. Use inline `StructureLink` mocks with `store.getUsedCapacity`, `store.getCapacity`, `cooldown`, `pos.getRangeTo`, and `transferEnergy` jest mock. Mock `Game.getObjectById` to return links by ID and mock `recordFixedCpuAction` if needed to avoid unrelated assertions.
  **Must NOT do**: Do not change `runLinkControl()` transfer target sorting or receiver fill threshold unless a test failure proves it is necessary for source precedence.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: single integration-style unit test around existing runtime function.
  - Skills: [`superpowers:test-driven-development`] - Add the failing transfer-direction assertion before adjusting code if needed.
  - Omitted: [`playwright`] - No browser/manual UI verification.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: task 5 | Blocked By: tasks 1, 2, 3

  **References**:
  - Transfer loop: `src/runtime/linkControl.ts:203-240` - sender IDs are mapped to structures and `sender.transferEnergy(target)` is called.
  - Receiver sort: `src/runtime/linkControl.ts:127-149` - `chooseReceiverTarget()` excludes sender itself and picks underfilled receivers.
  - Miner source behavior reference: `src/roles/miner.ts:59-80` - miners deposit into `getSourceAdjacentLink(source)`; test must ensure linkControl later sends from that same physical link.

  **Acceptance Criteria**:
  - [ ] Test setup has an overlap link with energy >0, cooldown 0, source range ≤2, storage range ≤2.
  - [ ] Test setup has a separate underfilled receiver link not source-adjacent.
  - [ ] After `runLinkControl()`, `overlapLink.transferEnergy` is called exactly once with the receiver link.
  - [ ] Receiver link `transferEnergy` is not called.
  - [ ] Evidence written to `.sisyphus/evidence/task-4-transfer-direction.txt`.

  **QA Scenarios**:
  ```
  Scenario: Overlap source link sends outward
    Tool: Bash
    Steps: Run `npm run test -- src/runtime/linkControl.test.ts` with a mocked room containing source+storage overlap sender and separate underfilled receiver.
    Expected: `overlapLink.transferEnergy(receiverLink)` called once; no receiver-to-sender transfer occurs.
    Evidence: .sisyphus/evidence/task-4-transfer-direction.txt

  Scenario: No transfer when no real receiver exists
    Tool: Bash
    Steps: Run focused test with only the overlap source link and no non-source receiver.
    Expected: `transferEnergy` is not called because `receiverIds.length === 0` or no target exists.
    Evidence: .sisyphus/evidence/task-4-no-receiver.txt
  ```

  **Commit**: NO | Message: `fix(runtime): prioritize source links in classification` | Files: `src/runtime/linkControl.test.ts`

- [x] 5. Run full verification and guardrail diff checks

  **What to do**: Run final project checks and save command outputs. Verify source scope is exactly the intended localized change.
  **Must NOT do**: Do not run `npm run push`, `npm run local`, formatters, codegen, or any command that deploys or rewrites generated files.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` - Reason: verification-only task with command execution and diff inspection.
  - Skills: [] - No special skill needed.
  - Omitted: [`git-master`] - Commit only after user/plan flow requests it.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: final verification | Blocked By: tasks 1, 2, 3, 4

  **References**:
  - Commands: `package.json:6-14` - `npm run test` and `npm run build`; TypeScript command is project convention `npx tsc --noEmit`.
  - Guardrail files: `src/runtime/sourceLink.ts:17-49`, `src/roles/miner.ts:59-80`, `src/runtime/bootstrap.ts:118-129`, `src/main.ts` tick order, `src/roles/carrier.ts:59-66`.

  **Acceptance Criteria**:
  - [ ] `npm run test -- src/runtime/linkControl.test.ts` passes.
  - [ ] `npm run test` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `git diff -- src/runtime/sourceLink.ts src/roles/miner.ts src/runtime/bootstrap.ts src/main.ts src/roles/carrier.ts` confirms no behavior edits to guarded files.
  - [ ] `git diff -- src/runtime/linkControl.ts src/runtime/linkControl.test.ts` shows only source-first classification/helper/test changes.
  - [ ] Evidence written to `.sisyphus/evidence/task-5-final-verification.txt`.

  **QA Scenarios**:
  ```
  Scenario: Full automated verification passes
    Tool: Bash
    Steps: Run `npm run test` and `npx tsc --noEmit` from repo root.
    Expected: Both commands exit 0 with no failing tests or type errors.
    Evidence: .sisyphus/evidence/task-5-final-verification.txt

  Scenario: Guarded files remain untouched
    Tool: Bash
    Steps: Run `git diff -- src/runtime/sourceLink.ts src/roles/miner.ts src/runtime/bootstrap.ts src/main.ts src/roles/carrier.ts`.
    Expected: Empty diff for guarded files; any non-empty diff must be reverted before final review.
    Evidence: .sisyphus/evidence/task-5-guardrail-diff.txt
  ```

  **Commit**: YES | Message: `fix(runtime): prioritize source links in classification` | Files: `src/runtime/linkControl.ts`, `src/runtime/linkControl.test.ts`

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- One atomic commit after all tests pass: `fix(runtime): prioritize source links in classification`
- Commit files: `src/runtime/linkControl.ts`, `src/runtime/linkControl.test.ts`, and `.sisyphus/evidence/*` only if project convention allows evidence tracking; otherwise do not commit evidence.
- Do not commit `dist/`, `.secret.json`, or generated deploy output.

## Success Criteria
- Link classification no longer conflicts with miner source-link detection for overlap links.
- Worker/carrier pickup eligibility helpers no longer expose source-overlap links as receivers.
- Existing storage/controller receiver behavior remains covered and unchanged.
- Full Jest and TypeScript checks pass with evidence.
