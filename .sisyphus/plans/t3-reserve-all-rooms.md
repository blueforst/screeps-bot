# T3 Reserve All Logistics Rooms

## TL;DR
> **Summary**: Expand hub T3 policy from the current 5 war-core compounds to all 10 tier-3 boost compounds, give each non-hub logistics-capable owned room 1k of every T3, and keep a protected 20k hub reserve of every T3 for replenishment.
> **Deliverables**:
> - Canonical all-10 T3 resource list and complete reaction-chain metadata in `src/runtime/hubPlanner.ts`.
> - Hub config migration from old 5-compound defaults to all 10 without overwriting custom user lists.
> - Separate hub reserve setting/default (`20000`) from satellite room reserve (`1000`).
> - TDD coverage for chain expansion, migration, hub reserve floor, distribution, reclaim/import, and market protection.
> **Effort**: Medium
> **Parallel**: YES - 3 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 6 → Final Verification

## Context
### Original Request
User: “将房间的t3储备改为每个房间所有类型t3 1k”

Confirmed refinements:
- “每个房间” means logistics-capable owned rooms: owned rooms with storage + terminal.
- Non-hub logistics rooms get every T3 compound at `1000` each.
- Hub room is special: it must keep `20000` of every T3 compound to replenish other rooms.
- Existing deployed `Memory.cfg.hub.targetCompounds` must auto-migrate/normalize from the old 5-compound default to all 10 T3 compounds.
- Development strategy: TDD.

### Interview Summary
- Existing hub architecture remains: one hub produces and distributes; eligible satellite rooms are owned non-hub rooms with storage + terminal.
- Do not manually require Screeps console updates for existing Memory; migration must happen in runtime code.
- All verification must be agent-executed; no human Screeps console verification as an acceptance criterion.

### Metis Review (gaps addressed)
- This is not a simple list expansion. New T3s require complete T1/T2/T3 reaction-chain entries, process ordering, output ordering, and intermediate-resource lists.
- Distribution currently has no hub safety floor; exports must not drain hub below 20k per T3.
- `T3_TARGETS` and `cfg.targetCompounds` can diverge; implementation must make one canonical all-T3 source.
- Migration must only update the old default-5 list, not user-customized target lists.

## Work Objectives
### Core Objective
Update hub production/distribution policy so all 10 Screeps T3 boost compounds are planned, protected, and distributed: hub keeps 20k each; every non-hub logistics-capable owned room gets 1k each.

### Deliverables
- Canonical all-T3 list in `src/runtime/hubPlanner.ts`:
  - `RESOURCE_CATALYZED_UTRIUM_ACID` (`XUH2O`)
  - `RESOURCE_CATALYZED_UTRIUM_ALKALIDE` (`XUHO2`)
  - `RESOURCE_CATALYZED_KEANIUM_ACID` (`XKH2O`)
  - `RESOURCE_CATALYZED_KEANIUM_ALKALIDE` (`XKHO2`)
  - `RESOURCE_CATALYZED_LEMERGIUM_ACID` (`XLH2O`)
  - `RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE` (`XLHO2`)
  - `RESOURCE_CATALYZED_ZYNTHIUM_ACID` (`XZH2O`)
  - `RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE` (`XZHO2`)
  - `RESOURCE_CATALYZED_GHODIUM_ACID` (`XGH2O`)
  - `RESOURCE_CATALYZED_GHODIUM_ALKALIDE` (`XGHO2`)
- Complete reaction-chain additions for newly targeted compounds:
  - `K + H -> KH`; `KH + OH -> KH2O`; `KH2O + X -> XKH2O`
  - `K + O -> KO`; `KO + OH -> KHO2`; `KHO2 + X -> XKHO2`
  - `L + H -> LH`; `LH + OH -> LH2O`; `LH2O + X -> XLH2O`
  - `Z + H -> ZH`; `ZH + OH -> ZH2O`; `ZH2O + X -> XZH2O`
  - `Z + O -> ZO`; `ZO + OH -> ZHO2`; `ZHO2 + X -> XZHO2`
- Separate hub reserve config field in `src/global.d.ts`, defaulting to `20000` per T3.
- Auto-normalization for old default hub target config.
- Updated tests and documentation comments where existing estimates mention only 5 compounds.

### Definition of Done (verifiable conditions with commands)
- `npx jest src/runtime/hubPlanner.test.ts src/runtime/resourceControl.test.ts --runInBand` passes.
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- `npm run build` passes.
- No code path can export a target T3 from hub to satellites when hub stock minus pending outgoing is `<= hubReservePerCompound`.
- Old default-5 target configs migrate to all 10; custom target lists are preserved.

### Must Have
- TDD: add failing tests before implementation for each behavior changed.
- All T3s use Screeps constants, not raw strings, unless a pre-existing pattern requires string literals in test assertions.
- Hub reserve and satellite reserve are separate fields/semantics; do not overload `reservePerRoom`.
- Existing custom `Memory.cfg.hub.targetCompounds` lists must not be overwritten unless they exactly match the old default-5 set.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Must NOT change `src/roles/remoteCarrier.ts` T3 pickup priorities; it already contains all 10 T3s and is not reserve policy.
- Must NOT change `src/runtime/boostControl.ts`; its single defense boost is unrelated.
- Must NOT add market-buying or external trading behavior.
- Must NOT change HAUL flag logic, carrier body logic, or synthesis carrier state machine except where tests reveal direct type/config compile issues.
- Must NOT require human manual Screeps console verification.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with existing Jest/ts-jest framework.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (TDD specs), Task 2 (canonical T3/reaction metadata) — sequential inside wave because Task 2 makes Task 1 green.
Wave 2: Task 3 (config migration/types), Task 4 (hub reserve floor), Task 5 (market/import/distribution protection tests) — can proceed after canonical list exists.
Wave 3: Task 6 (integration/regression cleanup), Task 7 (docs/comments/build verification).

### Dependency Matrix (full, all tasks)
| Task | Blocks | Blocked By |
|---|---|---|
| 1. Write failing TDD tests | 2,3,4,5 | None |
| 2. Canonical all-T3 chain metadata | 3,4,5,6 | 1 |
| 3. Config migration and types | 6 | 1,2 |
| 4. Hub reserve production/distribution floor | 6 | 1,2 |
| 5. Import/reclaim/market protection coverage | 6 | 1,2 |
| 6. Integration cleanup and full test pass | 7 | 3,4,5 |
| 7. Build/type/deploy readiness checks | Final Verification | 6 |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|---|---:|---|
| 1 | 2 | quick, unspecified-high |
| 2 | 3 | quick, unspecified-high |
| 3 | 2 | unspecified-high, quick |
| Final | 4 | oracle, unspecified-high, deep |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add TDD coverage for all-T3 reserve policy

  **What to do**: In `src/runtime/hubPlanner.test.ts` and `src/runtime/resourceControl.test.ts`, add failing tests before implementation for the exact expected policy. Tests must cover: all 10 target compounds, chain resolvability for all 10, old-default config migration, custom-config preservation, hub 20k reserve floor, satellite 1k distribution, all-10 reclaim/import iteration, and market protection for all target T3s.
  **Must NOT do**: Do not change implementation in this task except imports needed by tests. Do not skip failing-test observation.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused test additions in existing test files.
  - Skills: [] - no special skill required.
  - Omitted: [`playwright`] - no UI/browser behavior.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2,3,4,5] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/hubPlanner.test.ts` - existing hub chain/import/distribution test factories and assertions.
  - Pattern: `src/runtime/resourceControl.test.ts` - market protection/resource-control test patterns.
  - Source: `src/runtime/hubPlanner.ts` - current `DEFAULT_TARGET_COMPOUNDS`, `T3_TARGETS`, `REACTION_MAP`, `PROCESS_ORDER`, `OUTPUT_ORDER`, `INTERMEDIATE_COMPOUNDS`, `planHubChains`, `planHubImports`, `planHubDistribution`, `runHubPlanner`.
  - Source: `src/global.d.ts` - hub config type.
  - External: `https://docs.screeps.com/resources.html` - official Screeps resource/reaction reference.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Running `npx jest src/runtime/hubPlanner.test.ts src/runtime/resourceControl.test.ts --runInBand` fails for newly added tests before implementation.
  - [ ] Tests assert all 10 exact T3 constants: `XUH2O`, `XUHO2`, `XKH2O`, `XKHO2`, `XLH2O`, `XLHO2`, `XZH2O`, `XZHO2`, `XGH2O`, `XGHO2`.
  - [ ] Tests assert hub reserve floor: hub with exactly `20000` of a T3 sends `0`; hub with `21000` and one empty satellite sends `1000`.
  - [ ] Tests assert migration: old 5 list becomes all 10; a custom 3-item list remains unchanged.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Red tests prove policy gap
    Tool: Bash
    Steps: Run `npx jest src/runtime/hubPlanner.test.ts src/runtime/resourceControl.test.ts --runInBand` after adding tests and before implementation.
    Expected: Command exits non-zero with failures tied to missing all-T3 targets, missing migration, or missing hub reserve floor.
    Evidence: .sisyphus/evidence/task-1-t3-policy-red.txt

  Scenario: Existing tests remain syntactically valid
    Tool: Bash
    Steps: Run `npx tsc --noEmit` after adding tests.
    Expected: Either passes or only fails due to intentionally missing implementation exports/types named in the new tests; no syntax/import typos.
    Evidence: .sisyphus/evidence/task-1-test-typecheck.txt
  ```

  **Commit**: NO | Message: `test(hub): cover all t3 reserve policy` | Files: [`src/runtime/hubPlanner.test.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 2. Centralize all-T3 compounds and complete reaction metadata

  **What to do**: In `src/runtime/hubPlanner.ts`, introduce a canonical all-T3 list and make both defaults and chain planning use it. Replace the old duplicated 5-compound `DEFAULT_TARGET_COMPOUNDS`/`T3_TARGETS` divergence with one canonical source or aliases to the same source. Expand `REACTION_MAP`, `PROCESS_ORDER`, `OUTPUT_ORDER`, and `INTERMEDIATE_COMPOUNDS` to cover the new K/L/Z chains. Keep existing U/G/L alkalide chains intact.
  **Must NOT do**: Do not use raw strings in production code when Screeps constants exist. Do not modify `remoteCarrier.ts`.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: reaction-chain metadata must be exact and ordered.
  - Skills: [] - no special skill required.
  - Omitted: [`playwright`] - no UI/browser behavior.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [3,4,5,6] | Blocked By: [1]

  **References**:
  - Pattern: `src/runtime/hubPlanner.ts` current constants near top of file.
  - External: Screeps resources docs and typed-screeps constants for `REACTIONS`.
  - Known new chains: `KH/KH2O/XKH2O`, `KO/KHO2/XKHO2`, `LH/LH2O/XLH2O`, `ZH/ZH2O/XZH2O`, `ZO/ZHO2/XZHO2`.

  **Acceptance Criteria**:
  - [ ] `DEFAULT_TARGET_COMPOUNDS` resolves to all 10 T3 constants in this exact deterministic order: `XUH2O`, `XUHO2`, `XKH2O`, `XKHO2`, `XLH2O`, `XLHO2`, `XZH2O`, `XZHO2`, `XGH2O`, `XGHO2`.
  - [ ] `planHubChains` can resolve reaction chains for all 10 T3s from raw/intermediate inputs.
  - [ ] All new T1/T2 intermediates appear in `INTERMEDIATE_COMPOUNDS` so import scanning can see them.
  - [ ] `npx jest src/runtime/hubPlanner.test.ts --runInBand` no longer fails for all-T3 metadata/chain tests.

  **QA Scenarios**:
  ```
  Scenario: All T3 chains are resolvable
    Tool: Bash
    Steps: Run `npx jest src/runtime/hubPlanner.test.ts --runInBand`.
    Expected: Tests for all 10 T3 constants and reaction-chain metadata pass.
    Evidence: .sisyphus/evidence/task-2-all-t3-chains.txt

  Scenario: No accidental remoteCarrier policy change
    Tool: Bash
    Steps: Run `git diff -- src/roles/remoteCarrier.ts`.
    Expected: Empty diff; remote carrier pickup priority was not modified.
    Evidence: .sisyphus/evidence/task-2-remote-carrier-unchanged.txt
  ```

  **Commit**: YES | Message: `feat(hub): expand t3 reaction targets` | Files: [`src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`]

- [x] 3. Add hub reserve config and auto-migration

  **What to do**: Add a separate hub config field, named `hubReservePerCompound`, defaulting to `20000`, in `src/global.d.ts` and `getDefaultHubConfig()` in `src/runtime/hubPlanner.ts`. Add normalization logic that runs before hub planning uses config: if `Memory.cfg.hub.targetCompounds`, compared as a set ignoring order, exactly equals the old default-5 set (`XGHO2`, `XGH2O`, `XUH2O`, `XUHO2`, `XLHO2`), replace it with all 10. Preserve custom lists that do not exactly match that old default set. Ensure `hubFlag.ts` default merging can carry the new field without erasing existing config.
  **Must NOT do**: Do not migrate arbitrary subsets. Do not change `reservePerRoom` semantics; it remains satellite per-room reserve and defaults to `1000`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: type/config/default changes with targeted tests.
  - Skills: [] - no special skill required.
  - Omitted: [`playwright`] - no UI/browser behavior.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [6] | Blocked By: [1,2]

  **References**:
  - Type: `src/global.d.ts` `Memory.cfg.hub` type.
  - Pattern: `src/runtime/hubPlanner.ts` `getDefaultHubConfig()`.
  - Pattern: `src/runtime/hubFlag.ts` config merge preserving existing values.
  - Tests: `src/runtime/hubPlanner.test.ts`, `src/runtime/hubFlag.test.ts` if defaults/flag behavior is affected.

  **Acceptance Criteria**:
  - [ ] `getDefaultHubConfig()` includes `hubReservePerCompound: 20000` and all 10 `targetCompounds`.
  - [ ] Runtime normalization converts old default-5 target lists to all 10.
  - [ ] Runtime normalization preserves custom target lists, including subsets intentionally set by user.
  - [ ] TypeScript accepts the new config field without `any` casts.

  **QA Scenarios**:
  ```
  Scenario: Old deployed config auto-migrates
    Tool: Bash
    Steps: Run `npx jest src/runtime/hubPlanner.test.ts --runInBand`.
    Expected: Test with `Memory.cfg.hub.targetCompounds` equal to old 5 observes all 10 after hub config normalization/planning.
    Evidence: .sisyphus/evidence/task-3-old-config-migration.txt

  Scenario: Custom config is preserved
    Tool: Bash
    Steps: Run `npx jest src/runtime/hubPlanner.test.ts --runInBand`.
    Expected: Test with custom 3-compound target list remains exactly that list after normalization/planning.
    Evidence: .sisyphus/evidence/task-3-custom-config-preserved.txt
  ```

  **Commit**: YES | Message: `feat(hub): migrate t3 reserve config` | Files: [`src/runtime/hubPlanner.ts`, `src/global.d.ts`, `src/runtime/hubFlag.ts`, relevant tests]

- [x] 4. Enforce hub 20k reserve floor in production and distribution

  **What to do**: Update hub planning so chain production target for each T3 is dynamic and exact: `hubReservePerCompound + totalSatelliteDeficitForThatT3`, where `totalSatelliteDeficitForThatT3 = sum(max(0, reservePerRoom - satelliteStorageTerminalAmount - pendingIncomingToThatSatellite))` across eligible non-hub logistics rooms. Pending incoming must be counted per destination room and resource, excluding blocked/cancelled tasks; use an existing `resourceTransferTasks` helper if available, otherwise add a small hubPlanner-local scanner following the task filtering patterns in `src/runtime/logistics/resourceTransferTasks.test.ts`. Satellite distribution only allocates stock above the hub reserve after pending outgoing transfers. In `planHubDistribution()`, compute available-for-export per T3 as `max(0, hubStock - pendingOutgoing - hubReservePerCompound)` and use that for allocations. Satellite room target remains `reservePerRoom` (`1000`).
  **Must NOT do**: Do not let distribution drain hub below 20k. Do not set `reservePerRoom` to 20000.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: behavior affects cross-room logistics and production planning.
  - Skills: [] - no special skill required.
  - Omitted: [`playwright`] - no UI/browser behavior.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [6] | Blocked By: [1,2]

  **References**:
  - Source: `src/runtime/hubPlanner.ts` `planHubChains()` target reserve parameter and `runHubPlanner()` call site.
  - Source: `src/runtime/hubPlanner.ts` `planHubDistribution()` current `hubRemaining` computation.
  - Tests: `src/runtime/hubPlanner.test.ts` distribution and chain-planning sections.

  **Acceptance Criteria**:
  - [ ] Hub with exactly `20000` of a target T3 and empty satellite creates no export task for that T3.
  - [ ] Hub with `21000` of a target T3 and one empty satellite creates an export task of `1000` for that T3.
  - [ ] Hub with pending outgoing `500`, stock `21500`, reserve `20000`, and satellite deficit `1000` exports only `1000` if capacity remains; if pending outgoing equals available surplus, exports `0`.
  - [ ] Chain planning target is `20000` for hub reserve, not `1000`, when no satellites exist.
  - [ ] Chain planning target is `20000 + (1000 * N empty eligible satellites)` for a T3 when N eligible satellites have 0 of that T3 and no pending incoming.
  - [ ] Chain planning target subtracts pending incoming per destination satellite/resource; one empty satellite with `400` pending incoming has deficit `600`, not `1000`.

  **QA Scenarios**:
  ```
  Scenario: Hub reserve floor blocks export
    Tool: Bash
    Steps: Run `npx jest src/runtime/hubPlanner.test.ts --runInBand`.
    Expected: Distribution test with hub at 20k creates zero T3 export tasks.
    Evidence: .sisyphus/evidence/task-4-hub-floor-blocks-export.txt

  Scenario: Hub surplus replenishes satellite
    Tool: Bash
    Steps: Run `npx jest src/runtime/hubPlanner.test.ts --runInBand`.
    Expected: Distribution test with hub at 21k and empty satellite creates 1k export and leaves 20k protected in calculations.
    Evidence: .sisyphus/evidence/task-4-hub-surplus-exports.txt
  ```

  **Commit**: YES | Message: `feat(hub): protect hub t3 reserve floor` | Files: [`src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`]

- [x] 5. Update import/reclaim and market protection behavior for all 10 T3s

  **What to do**: Ensure `planHubImports()` iterates over the normalized all-10 `targetCompounds` for satellite surplus reclaim and that new T1/T2 intermediates are included in intermediate import scanning. Ensure `resourceControl.ts` market protection tests cover all 10 T3s via `cfg.targetCompounds`. Implementation changes in `resourceControl.ts` should be unnecessary unless tests reveal hardcoded old lists.
  **Must NOT do**: Do not change market sell thresholds or add market-buying logic.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: targeted guard/test task after canonical list exists.
  - Skills: [] - no special skill required.
  - Omitted: [`playwright`] - no UI/browser behavior.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [6] | Blocked By: [1,2]

  **References**:
  - Source: `src/runtime/hubPlanner.ts` `planHubImports()` and `INTERMEDIATE_COMPOUNDS`.
  - Source: `src/runtime/resourceControl.ts` `isHubProtectedResource()`.
  - Tests: `src/runtime/resourceControl.test.ts`, `src/runtime/hubPlanner.test.ts`.

  **Acceptance Criteria**:
  - [ ] Satellite surplus reclaim tests include at least one newly added T3 (`XKH2O`, `XKHO2`, `XLH2O`, `XZH2O`, or `XZHO2`).
  - [ ] Intermediate import tests include at least one newly added T1/T2 intermediate (`KH`, `KHO2`, `LH2O`, `ZH2O`, or `ZHO2`).
  - [ ] `isHubProtectedResource()` returns true for all 10 target T3s when present in `Memory.cfg.hub.targetCompounds`.
  - [ ] Existing non-target/custom-list behavior remains unchanged: resources not in custom `targetCompounds` are not protected solely because they are T3.

  **QA Scenarios**:
  ```
  Scenario: New T3 surplus is reclaimed
    Tool: Bash
    Steps: Run `npx jest src/runtime/hubPlanner.test.ts --runInBand`.
    Expected: Satellite with surplus newly added T3 above `surplusThreshold` creates a hub import/reclaim task.
    Evidence: .sisyphus/evidence/task-5-new-t3-reclaim.txt

  Scenario: All target T3s are market-protected
    Tool: Bash
    Steps: Run `npx jest src/runtime/resourceControl.test.ts --runInBand`.
    Expected: Market protection test passes for all 10 target T3 constants and preserves custom-list behavior.
    Evidence: .sisyphus/evidence/task-5-market-protection.txt
  ```

  **Commit**: YES | Message: `test(hub): cover all t3 logistics protections` | Files: [`src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 6. Integration cleanup across hub planner, progress, and production tests

  **What to do**: Update existing hardcoded test expectations and comments that assume 5 T3 targets or old chain counts. Check `hubProgress`, `hubProductionIntegration`, `consoleCommands`, and hub flag tests for assumptions about `targetCompounds.length`, progress denominator, or exact serialized config snapshots. Preserve hub progress UI behavior; only update expectations to the new default list/reserve where needed.
  **Must NOT do**: Do not redesign hub progress visual panel, console command API, or production scheduler.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: cross-test regression cleanup requires careful scope control.
  - Skills: [] - no special skill required.
  - Omitted: [`frontend-ui-ux`, `playwright`] - no UI browser work; RoomVisual tests are Jest-based.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [7] | Blocked By: [3,4,5]

  **References**:
  - Tests: `src/runtime/hubProgress.test.ts`, `src/runtime/hubProductionIntegration.test.ts`, `src/runtime/consoleCommands.test.ts`, `src/runtime/hubFlag.test.ts`, `src/runtime/memoryCleanup.test.ts`.
  - Project memory: hub progress panel must preserve existing overlay/helpers/snapshot/analytics; do not change visual design.

  **Acceptance Criteria**:
  - [ ] `npm run test` passes.
  - [ ] Any updated snapshot/length assertions now derive from the canonical all-T3 list where practical, not magic number `5`.
  - [ ] Hub progress tests still assert the same sections/behavior unless default reserve numbers directly affect expected values.
  - [ ] No generated `dist/` changes are committed unless repository convention requires build artifacts.

  **QA Scenarios**:
  ```
  Scenario: Full Jest regression passes
    Tool: Bash
    Steps: Run `npm run test`.
    Expected: All Jest suites pass.
    Evidence: .sisyphus/evidence/task-6-full-jest.txt

  Scenario: Hub visual/progress behavior remains scoped
    Tool: Bash
    Steps: Run `npx jest src/runtime/hubProgress.test.ts src/runtime/hubProductionIntegration.test.ts --runInBand`.
    Expected: Tests pass without introducing new visual redesign expectations.
    Evidence: .sisyphus/evidence/task-6-hub-progress-integration.txt
  ```

  **Commit**: YES | Message: `test(hub): update t3 integration expectations` | Files: [affected hub test files]

- [x] 7. Typecheck, build, and deployment readiness verification

  **What to do**: Run final local verification commands, fix any type/build failures caused by the new config field or tests, and prepare the change for deployment. Per project workflow, after final wave approval the executor should deploy with `npm run push`; this task only establishes pre-deploy readiness unless the user explicitly continues through final approval.
  **Must NOT do**: Do not deploy before Final Verification Wave approval and user explicit okay.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: command-driven verification and small fixes only.
  - Skills: [] - no special skill required.
  - Omitted: [`git-master`] - use only if committing; final execution agent may invoke git skill per git-operation rules.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [Final Verification] | Blocked By: [6]

  **References**:
  - Commands from `AGENTS.md`: `npx tsc --noEmit`, `npm run test`, `npm run build`, `npm run push` after approval.
  - Workflow rule: deploy to Screeps with `npm run push` after successful TypeScript and Jest verification.

  **Acceptance Criteria**:
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `npm run test` passes.
  - [ ] `npm run build` passes.
  - [ ] Working tree contains only intended source/test/type changes and no secrets.

  **QA Scenarios**:
  ```
  Scenario: TypeScript and Jest pass
    Tool: Bash
    Steps: Run `npx tsc --noEmit && npm run test`.
    Expected: Exit code 0.
    Evidence: .sisyphus/evidence/task-7-typecheck-test.txt

  Scenario: Rollup build passes
    Tool: Bash
    Steps: Run `npm run build`.
    Expected: Exit code 0 and no TypeScript/Rollup errors.
    Evidence: .sisyphus/evidence/task-7-build.txt
  ```

  **Commit**: YES | Message: `feat(hub): reserve all t3 compounds` | Files: [remaining changed source/test/type files]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high (command-based QA; no Playwright needed)
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit after logical green states, not after red-only tests unless the executor intentionally wants a test-only commit and user/project rules permit.
- Suggested atomic commits:
  1. `feat(hub): expand t3 reaction targets`
  2. `feat(hub): migrate t3 reserve config`
  3. `feat(hub): protect hub t3 reserve floor`
  4. `test(hub): update t3 integration expectations`
- Do not commit `.secret.json`, `dist/`, or `.sisyphus/evidence/` unless user explicitly requests evidence archival.

## Success Criteria
- All 10 T3 compounds are canonical defaults for hub target compounds.
- Existing old-default 5-compound hub configs auto-migrate to all 10 T3s.
- User-customized target lists are preserved.
- Hub stock of each target T3 is protected up to 20k from satellite distribution and market sell paths.
- Non-hub logistics-capable owned rooms receive/export target behavior based on 1k per T3.
- All new reactions and intermediates required for K/L/Z added T3 chains are represented in hub planning metadata.
- `npx tsc --noEmit`, `npm run test`, and `npm run build` all pass before final review.
