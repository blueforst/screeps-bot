# Test Suite Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the Jest suite from 2,275 to exactly 500 representative cases while retaining direct coverage in every current test file.

**Architecture:** This is a test-only reduction. Every test file receives a baseline budget of its current count capped at six cases; the 74 remaining cases are assigned to the 28 largest files, yielding 10, 8, or 7 cases according to the approved design. Production source, Jest configuration, and build scripts remain untouched.

**Tech Stack:** TypeScript, Jest, Node.js, TypeScript compiler.

## Global Constraints

- Edit only `*.test.*` files; do not alter production source, Jest configuration, build scripts, or runtime behavior.
- Keep every existing test file and retain at least one direct regression case in it.
- Retain normal behavior, a public boundary, failure/recovery, integration, and highest-risk regression coverage before retaining low-value variations.
- Delete only duplicate parameter variations, repeated formatting checks, and minor variants that exercise the same branch and outcome.
- The final declaration count, using `\b(?:it|test)\s*\(`, must be exactly 500.

## File Budget Map

| Rank | Files | Retained cases per file |
| --- | ---: | ---: |
| 1–10 | 10 | 10 |
| 11–26 | 16 | 8 |
| 27–28 | 2 | 7 |
| 29–53 | 25 | 6 |
| 54–78 | 25 | `min(current count, 6)` |

### Task 1: Establish the count guard

**Files:** All `*.test.*` files in Tasks 2–6.

- [ ] Run this command before and after each group:

```bash
node - <<'NODE'
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const files = execFileSync('rg', ['--files', '-g', '*.test.{ts,tsx,js,jsx}', '-g', '!node_modules/**'], { encoding: 'utf8' }).trim().split('\\n').filter(Boolean);
const cases = files.reduce((total, file) => total + (fs.readFileSync(file, 'utf8').match(/\b(?:it|test)\s*\(/g) || []).length, 0);
console.log({ files: files.length, cases });
NODE
```

Expected initially: `{ files: 78, cases: 2275 }`; expected finally: `{ files: 78, cases: 500 }`.

### Task 2: Reduce the ten largest suites to ten cases each

**Files:**
- `src/runtime/remoteMining.test.ts`, `src/runtime/hubPlanner.test.ts`, `src/runtime/resourceControl.test.ts`, `src/runtime/powerBankHarvest.test.ts`, `src/runtime/cpuMonitor.test.ts`
- `src/runtime/factoryControl.test.ts`, `src/runtime/hubProgress.test.ts`, `src/roles/carrier.test.ts`, `src/roles/remoteMiningCarrier.test.ts`, `src/runtime/synthesisControlStateMachine.test.ts`

**Produces:** Exactly 10 independent `it`/`test` declarations in each file.

- [ ] In every file, retain nominal behavior, a public boundary, failure/fallback, cleanup or state transition, integration behavior, and five non-overlapping high-risk paths.
- [ ] Delete equivalent fixture permutations and repeated formatting assertions. Remove unused test-only imports, mocks, and helpers.
- [ ] Count each file. Expected: all ten files report `10` declarations.
- [ ] Run `npm run test -- --runInBand` after the group. Expected: exit code 0.

### Task 3: Reduce ranks 11–26 to eight cases each

**Files:**
- `src/runtime/logistics/resourceTransferTasks.test.ts`, `src/roles/powerBankHealer.test.ts`, `src/runtime/powerBankViability.test.ts`, `src/runtime/spawnPlanner.test.ts`
- `src/roles/powerBankAttacker.test.ts`, `src/movement/common.test.ts`, `src/roles/powerBankHauler.test.ts`, `src/runtime/powerBankBoost.test.ts`
- `src/config/spawnProfiles.test.ts`, `src/roles/remoteDefender.test.ts`, `src/movement/pathing.test.ts`, `src/runtime/configNormalize.test.ts`
- `src/runtime/consoleCommands.test.ts`, `src/roles/shared.test.ts`, `src/runtime/powerBankConstants.test.ts`, `test/defenseMode.test.ts`

**Produces:** Exactly 8 independent `it`/`test` declarations in each file.

- [ ] Preserve normal, boundary, failure/recovery, and integration behavior plus four distinct module risks. In `pathing` and `remoteDefender`, retain cross-room and exit-tile safety. In planner/control suites, retain runtime mutation and stop/fallback behavior.
- [ ] Delete branch-equivalent variants; clean up unused test scaffolding.
- [ ] Count each file. Expected: all sixteen files report `8` declarations.
- [ ] Run `npm run test -- --runInBand`. Expected: exit code 0.

### Task 4: Reduce ranks 27–28 to seven cases each

**Files:** `src/runtime/memoryCleanup.test.ts`, `src/roles/powerBankScout.test.ts`.

**Produces:** Exactly 7 independent declarations in each file.

- [ ] For memory cleanup, retain expiration, live-state preservation, malformed-data safety, and cleanup boundary behavior. For the scout, retain discovery, travel/return, target validity, recovery, and lifecycle boundary behavior.
- [ ] Delete duplicate branches and unused scaffolding.
- [ ] Count the two files. Expected: `7` and `7`.
- [ ] Run `npm run test -- --runInBand`. Expected: exit code 0.

### Task 5: Reduce ranks 29–53 to six cases each

**Files:**
- `src/roles/remoteWorker.test.ts`, `src/runtime/synthesisControl.test.ts`, `src/runtime/productionStateMachine.test.ts`, `src/roles/meleeAttacker.test.ts`, `src/runtime/carrierTaskBoard.test.ts`
- `src/runtime/resourceReservation.test.ts`, `src/runtime/roomPlannerConstruction.test.ts`, `src/runtime/colonization.test.ts`, `src/movement/traffic.test.ts`, `src/movement/routing.test.ts`
- `src/runtime/externalTelemetry.test.ts`, `src/runtime/hubProductionIntegration.test.ts`, `src/runtime/reactionMap.test.ts`, `src/roles/healer.test.ts`, `src/runtime/powerBankDiscovery.test.ts`
- `src/roles/remoteMiningReserver.test.ts`, `src/runtime/workerTaskPool.test.ts`, `src/roles/energyTargets.test.ts`, `src/runtime/bootstrap.test.ts`, `src/runtime/flagHauling.test.ts`
- `src/runtime/hubFlag.test.ts`, `src/runtime/towerControl.test.ts`, `test/miner.test.ts`, `src/main.test.ts`, `src/runtime/homeDefense.test.ts`

**Produces:** Exactly 6 independent declarations in each file.

- [ ] Retain nominal, boundary, failure/fallback, integration/state transition, and two module-specific high-risk behaviors. For roles retain source-to-target behavior; for task/planner suites retain creation, selection, and cleanup; for movement retain routing safety and recovery.
- [ ] Remove only duplicate outcomes and their now-unused test scaffolding.
- [ ] Count each file. Expected: all twenty-five files report `6` declarations.
- [ ] Run `npm run test -- --runInBand`. Expected: exit code 0.

### Task 6: Apply the six-case baseline to ranks 54–78

**Files to reduce to 6:** `src/roles/remoteCarrier.test.ts`, `src/roles/scout.test.ts`, `src/runtime/memoryAudit.test.ts`, `src/runtime/warControl.test.ts`, `src/visual/panel.test.ts`.

**Files to retain unchanged:** `src/runtime/hostilePriorities.test.ts`, `src/visual/palette.test.ts`, `test/tickContext.test.ts`, `src/roles/homeDefender.test.ts`, `src/runtime/autoReserveFlag.test.ts`, `src/runtime/crossShardColonization.test.ts`, `src/runtime/linkControl.test.ts`, `src/runtime/roomWorkforce.test.ts`, `src/runtime/safeZoneHelpers.test.ts`, `test/harvester.test.ts`, `src/runtime/mineralExtraction.test.ts`, `src/roles/claimer.test.ts`, `src/roles/mineralHarvester.test.ts`, `src/runtime/powerBankObserver.test.ts`, `src/runtime/roomTypes.test.ts`, `src/mount/mountCreep.test.ts`, `src/runtime/actionLog.test.ts`, `src/runtime/console/resourceTransferCommands.test.ts`, `src/runtime/resourceControl.capacityRegression.test.ts`, `src/runtime/memorySizeRegression.test.ts`.

**Produces:** Five files at 6 declarations; the other twenty files remain at their current count of six or fewer.

- [ ] Remove the least-distinct case from each of the five seven-case files only after retaining normal, boundary, failure/recovery, and module-specific coverage.
- [ ] Do not edit the listed unchanged files.
- [ ] Count the group. Expected: five files at `6`; every unchanged file retains its original count.
- [ ] Run `npm run test -- --runInBand`. Expected: exit code 0.

### Task 7: Complete verification and commit

**Files:** All test files modified in Tasks 2–6; `docs/superpowers/specs/2026-07-14-test-suite-reduction-design.md`; `docs/superpowers/plans/2026-07-14-test-suite-reduction.md`.

- [ ] Run the Task 1 command. Expected: `{ files: 78, cases: 500 }`.
- [ ] Run `npm run test -- --runInBand`. Expected: Jest exits 0.
- [ ] Run `npx tsc --noEmit`. Expected: exit code 0.
- [ ] Run `git diff --check`, `git status --short`, and `git diff --name-only`. Expected: no whitespace errors; only test files and plan/spec documents changed; the pre-existing untracked `.codex/` directory is untouched.
- [ ] Commit with `git add src test docs/superpowers/specs/2026-07-14-test-suite-reduction-design.md docs/superpowers/plans/2026-07-14-test-suite-reduction.md` then `git commit -m "test: reduce suite to 500 representative cases"`.
