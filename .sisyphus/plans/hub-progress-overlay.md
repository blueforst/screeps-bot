# Hub Progress Overlay, Monitor Access, and Terminal Energy Feed Fix

## TL;DR
> **Summary**: Add reliable hub progress visibility in-game and out-of-game, while fixing the terminal energy feed gate that blocks satellite rooms from sending minerals/T3 to the hub.
> **Deliverables**:
> - Terminal energy feed no longer requires `storageEnergy >= energyTarget`; terminals can be fed from any available storage energy.
> - Hub progress snapshot shared by RoomVisual overlay, console command, and external monitor analytics.
> - Top-left RoomVisual hub overlay rendered in every owned room.
> - `npm run monitor:once` exposes hub/terminal/resource-transfer data and can auto-select the populated shard.
> **Effort**: Medium
> **Parallel**: YES - 3 waves
> **Critical Path**: Task 1 + Task 2 → Task 3 + Task 4 + Task 5 → Final verification

## Context

### Original Request
- 用户想在“终端”打印 hub 进展，例如“计划合成什么产物”。
- 用户随后确认：可以直接画在游戏左上角，并选择“所有 owned rooms”显示。
- 用户观察到：插 HUB flag 后，hub terminal 只收到其他房间发来的 `U` 和房间自有的 `X`；其他房间 terminal 好像没有补能。
- 用户要求：检查并扩展游戏外 monitor，让助手能通过它访问游戏内数据。
- 用户最终明确：**取消向 terminal 补能的 storage 能量阈值限制**。

### Interview Summary
- 主显示入口：RoomVisual overlay，所有 owned rooms 左上角每 tick 绘制 hub 总进展。
- 数据内容：合成计划、active product/stage、阻塞信息、hub 库存、pending hub transfer、terminal energy blocker。
- 测试策略：TDD。
- 外部监控：优先扩展 `Memory.analytics`，让 `npm run monitor:once` 不依赖 RawMemory segment 也能看到 hub/terminal/resource-transfer 摘要。
- 修复策略：移除 `createEnergyTerminalTask()` 的 `storageEnergy >= energyTarget` feed gate；保留“只能搬运 storage 实际拥有 energy”的物理限制。

### Metis Review (gaps addressed)
- `statusHubRaw()` is too shallow; new hub progress data must not reuse its config-level status.
- Feed-gate bug is multi-layered: storage threshold gate, fee-budget logic ignoring non-energy tasks, and reserved terminal energy calculation.
- RoomVisual mock has no call recording; use pure draw-command generation for TDD.
- Monitor currently reads only `Memory.analytics`, not `Memory.runtime` or `Memory.data`; curate compact analytics instead of fetching full Memory.
- `roomCount: 0` may be shard mismatch; monitor needs shard candidate fallback when no shard is specified.

## Work Objectives

### Core Objective
Make hub production/resource logistics observable and actionable both in-game and from the external monitor, and remove the terminal energy feed threshold that prevents satellite rooms from sending hub resources.

### Deliverables
- `src/runtime/resourceControl.ts` terminal feed behavior updated and covered by unit tests.
- New shared hub progress module (recommended: `src/runtime/hubProgress.ts`) with pure snapshot builder, analytics writer, overlay draw-command builder, and thin RoomVisual renderer helpers.
- `src/main.ts` hooks for hub progress analytics and overlay rendering.
- `Memory.analytics.hub` schema in `src/global.d.ts`.
- `scripts/monitor-service.mjs` support for hub summary, `/hub` endpoint, selected shard reporting, and shard fallback.
- New/updated tests for resource control, hub progress, overlay draw commands, console command, and monitor parsing.
- `hubProgress()` / `hubProgressRaw()` console commands for quick in-game diagnostics.

### Definition of Done (verifiable conditions with commands)
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- `npm run build` passes.
- After successful verification, `npm run push` deploys the bundle.
- After deploy and at least one analytics sample interval, `npm run monitor:once` prints hub data under the memory snapshot (including hub status, terminal energy, pending hub task counts, and selected shard/candidate info).
- In-game `hubProgressRaw()` returns hub progress data without throwing when hub is disabled, hub room is invisible, or transfer tasks are empty.

### Must Have
- Terminal feed must not be blocked solely because `storageEnergy < energyTarget`.
- Terminal feed amount must still be bounded by storage contents, terminal free capacity, and target terminal energy.
- Non-energy pending transfer tasks must contribute terminal fee budget.
- Overlay must render in all owned rooms when `RoomVisual` exists.
- Overlay must be safe when `RoomVisual` is undefined.
- Monitor must not expose secrets or tokens.
- Analytics data must be compact and optional/backward-compatible.

### Must NOT Have
- Do not change hub planner import/reclaim/distribution thresholds or synthesis chain selection.
- Do not re-run hub planning logic from the overlay/monitor path.
- Do not fetch full `Memory.runtime` or `Memory.data` from the external monitor; export curated data to `Memory.analytics` instead.
- Do not require manual visual inspection for tests.
- Do not add permanent noisy `console.log` output every tick.
- Do not modify `.secret.json` or commit secrets.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with Jest + ts-jest.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

## Execution Strategy

### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (`quick` resourceControl fix), Task 2 (`unspecified-high` hub progress foundation)
Wave 2: Task 3 (`quick` overlay hook), Task 4 (`unspecified-high` monitor extension), Task 5 (`quick` console/docs)
Wave 3: Integration verification and deploy via Final Verification Wave

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1. Terminal feed gate fix | None | Final verification |
| 2. Hub progress snapshot + analytics | None | 3, 4, 5, Final verification |
| 3. RoomVisual overlay | 2 | Final verification |
| 4. External monitor hub access | 2 | Final verification |
| 5. Console command + docs | 2 | Final verification |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Count | Categories |
|---|---:|---|
| 1 | 2 | quick, unspecified-high |
| 2 | 3 | quick, unspecified-high, quick |
| 3 | 4 review agents | oracle, unspecified-high, unspecified-high, deep |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Remove terminal feed storage-energy gate and budget non-energy transfer fees

  **What to do**:
  - In `src/runtime/resourceControl.ts`, update the terminal energy feed path around `getPlannedEnergySendBatch()` (`resourceControl.ts:732`), `getEnergySendFeeBudget()` (`resourceControl.ts:745`), `getReservedTerminalEnergyForPendingSends()` (`resourceControl.ts:809`), and `createEnergyTerminalTask()` (`resourceControl.ts:818`).
  - Remove the feed blocker at `resourceControl.ts:836-838` so `storageEnergy < energyTarget` no longer returns `null` for terminal energy feed.
  - Keep the existing offload path at `resourceControl.ts:827-834`, but verify it respects `reservedTerminalEnergy` through `offloadableTerminalEnergy`.
  - Extend reserved terminal energy calculation so pending outgoing non-energy transfer tasks contribute estimated fee budget with `Game.market.calcTransactionCost(batchAmount, fromRoomName, toRoomName)`.
  - For pending non-energy tasks, use `Math.min(room.transferBatchSize, task.remainingAmount)` as the fee-estimation batch amount.
  - Desired terminal energy must be `terminalEnergyReserve + stagedEnergy + feeBudget`; `createTerminalFeedTask()` (`resourceControl.ts:667`) already caps by storage amount and terminal free capacity, so do not add a storage threshold.
  - Update `src/runtime/resourceControl.test.ts` before implementation (TDD) to cover below-threshold storage feeding.

  **Must NOT do**:
  - Do not preserve the 200k `energyTarget` threshold for terminal energy feed.
  - Do not change hub planner thresholds in `src/runtime/hubPlanner.ts`.
  - Do not change transfer task execution order or `taskMaxPerRun` behavior.

  **Recommended Agent Profile**:
  - Category: `quick` - Focused logic/test change in one runtime module.
  - Skills: [`superpowers:test-driven-development`] - User explicitly selected TDD.
  - Omitted: [`frontend-ui-ux`] - No UI work in this task.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: Final verification | Blocked By: None

  **References**:
  - Pattern: `src/runtime/resourceControl.ts:667-695` - `createTerminalFeedTask()` already caps by storage amount, terminal free capacity, and missing target amount.
  - Pattern: `src/runtime/resourceControl.ts:732-843` - Existing staged energy, fee budget, reserved energy, and storage-threshold gate.
  - Pattern: `src/runtime/resourceControl.ts:846-898` - `syncTerminalFeedTasks()` creates feed/offload carrier tasks per room.
  - Test: `src/runtime/resourceControl.test.ts` - Existing resource control terminal feed/offload coverage.

  **Acceptance Criteria**:
  - [ ] Add failing Jest tests first for below-`energyTarget` storage terminal energy feed.
  - [ ] With storage energy `50_000`, terminal energy `0`, and no outgoing tasks, `syncTerminalFeedTasks()` creates a `terminal_feed` energy task targeting `terminalEnergyReserve`.
  - [ ] With storage energy `50_000`, terminal energy `0`, and pending `hub:import:X` non-energy task, feed target includes `terminalEnergyReserve + estimatedFee`.
  - [ ] With storage energy `0`, terminal energy `0`, and pending hub non-energy task, no feed task with impossible amount is created.
  - [ ] Existing offload tests still pass and do not drain energy below reserved fee budget.
  - [ ] Command passes: `npx jest src/runtime/resourceControl.test.ts --runInBand`.

  **QA Scenarios**:
  ```
  Scenario: Low-storage satellite still feeds terminal energy
    Tool: Bash
    Steps: Run `npx jest src/runtime/resourceControl.test.ts --runInBand` after adding a test with storageEnergy=50_000, terminalEnergy=0.
    Expected: Test asserts a `terminal_feed` carrier task for RESOURCE_ENERGY exists even though storageEnergy < energyTarget.
    Evidence: .sisyphus/evidence/task-1-terminal-feed-low-storage.txt

  Scenario: Empty storage cannot invent terminal energy
    Tool: Bash
    Steps: Run the same Jest file with a test where storage energy is 0 and terminal target is positive.
    Expected: No terminal_feed task with positive amount is created; test passes without throwing.
    Evidence: .sisyphus/evidence/task-1-terminal-feed-empty-storage.txt
  ```

  **Commit**: YES | Message: `fix(resource-control): feed terminal energy below storage target` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 2. Add shared hub progress snapshot and analytics export

  **What to do**:
  - Create `src/runtime/hubProgress.ts`.
  - Implement a pure builder such as `buildHubProgressSnapshot(input)` that accepts explicit inputs: hub config, hub runtime, synthesis room runtime, hub inventory summary, owned-room resource-control snapshots, pending resource-transfer tasks, and current tick.
  - Implement a thin collector such as `collectHubProgressSnapshot()` that reads from:
    - `Memory.cfg.hub`
    - `Memory.runtime.hub`
    - `Memory.runtime.synthesisControl.rooms[hubRoomName]`
    - `Game.rooms[hubRoomName]?.storage?.store` and `.terminal?.store`
    - `Memory.runtime.resourceControl.rooms`
    - `Memory.data.resourceControl.tasks`
  - Snapshot fields must include: `updatedAt`, `enabled`, `hubRoomName`, planner `status`, synthesis `stage`, `activeProduct`, `lastPlanActions` (cap 8 for overlay), `missingResources`, `lastError`, `needsPlan`, hub storage/terminal energy, compact hub inventory, pending hub task counts by reason/resource/from/to, and per-room terminal blockers.
  - Compact inventory rule: include all `cfg.targetCompounds`, `activeProduct`, `missingResources`, resources from first 8 `lastPlanActions`, and top 10 non-energy resources by total amount. Do not export all zero-value resources.
  - Add `runHubProgressAnalytics()` that writes `Memory.analytics.hub` every 5 ticks and on `Memory.runtime.hub.needsPlan === true`.
  - Extend `src/global.d.ts:666-709` with optional `Memory.analytics.hub` schema.
  - Hook `runHubProgressAnalytics()` into `src/main.ts` after `runResourceControl` (`main.ts:60`) and before `runExternalTelemetryExport` (`main.ts:61`) via `cpuProfiler.measure("hubProgressAnalytics", runHubProgressAnalytics)`.
  - Add `src/runtime/hubProgress.test.ts` with pure builder tests first.

  **Must NOT do**:
  - Do not mutate hub planner state from this module.
  - Do not persist raw full `Memory.runtime` or `Memory.data` under analytics.
  - Do not call `planHubChains()` or any hub planner functions from snapshot collection.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Cross-cutting runtime data model, analytics typing, and tests.
  - Skills: [`superpowers:test-driven-development`] - Pure builder should be test-first.
  - Omitted: [`frontend-ui-ux`] - Rendering is separate in Task 3.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 3, 4, 5 | Blocked By: None

  **References**:
  - API/Type: `src/global.d.ts:666-709` - Existing `Memory.analytics` shape.
  - Pattern: `src/runtime/productionMonitor.ts:83-91` - `ensurePersistentStore()` pattern for analytics subkeys.
  - Pattern: `src/runtime/productionMonitor.ts:293-308` - Sample-interval analytics writer pattern.
  - Pattern: `src/runtime/hubPlanner.ts:240-333` - Hub import/reclaim task reason semantics.
  - API/Type: `src/runtime/synthesisControl.ts:54-71` - Synthesis room runtime fields: stage, activeProduct, missing, lastError.
  - Pattern: `src/runtime/logistics/resourceTransferTasks.ts` - Resource transfer task store and task reason strings.

  **Acceptance Criteria**:
  - [ ] `buildHubProgressSnapshot()` is pure and testable without live Screeps globals.
  - [ ] Disabled hub returns a stable snapshot with `enabled=false` and no throw.
  - [ ] Invisible hub room returns inventory visibility status such as `hubRoomVisible=false`, not a crash.
  - [ ] Blocked hub with `missingResources=["U","K"]` exposes both missing resources.
  - [ ] Pending `hub:import:*`, `hub:reclaim:*`, and `hub:export:*` tasks are counted separately.
  - [ ] `Memory.analytics.hub` remains optional and backward-compatible.
  - [ ] Command passes: `npx jest src/runtime/hubProgress.test.ts --runInBand`.

  **QA Scenarios**:
  ```
  Scenario: Hub progress snapshot captures plan and blockers
    Tool: Bash
    Steps: Run `npx jest src/runtime/hubProgress.test.ts --runInBand` with fixture hub runtime status=blocked, lastPlanActions, missingResources, and pending hub tasks.
    Expected: Snapshot includes status=blocked, missing resources, capped plan actions, and hub task counts.
    Evidence: .sisyphus/evidence/task-2-hub-progress-blocked.txt

  Scenario: Analytics export is compact and backward-compatible
    Tool: Bash
    Steps: Run the same Jest file with Memory.analytics initially undefined and many inventory resources.
    Expected: `Memory.analytics.hub` is created with updatedAt and compact inventory; no unrelated analytics keys are required.
    Evidence: .sisyphus/evidence/task-2-hub-progress-analytics.txt
  ```

  **Commit**: YES | Message: `feat(hub): export progress analytics snapshot` | Files: [`src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`, `src/global.d.ts`, `src/main.ts`]

- [x] 3. Render hub progress overlay in every owned room

  **What to do**:
  - In `src/runtime/hubProgress.ts` or a small companion module, implement pure draw-command generation such as `buildHubOverlayDrawCommands(snapshot, roomName, options)`.
  - Draw commands must be semantic data first; RoomVisual adapter applies them second.
  - Implement `renderHubProgressOverlays()` that:
    - returns immediately if `typeof RoomVisual === "undefined"`
    - collects the latest hub progress snapshot
    - loops `getTickContextService().getMyRooms()`
    - uses `new RoomVisual(room.name)` for each owned room
    - draws top-left text every tick because RoomVisual is not persistent
  - Layout decision:
    - default start: `x=1`, `y=1`, align left, font `0.45`, color by status
    - show at most 8 lines in-game: header, status/stage, active product, next plan, missing/error, hub storage/terminal energy, pending hub tasks, terminal blockers
    - if a `VP*` visual-planner flag exists in that room, shift start `y` to `6` to reduce overlap with autoplanner visual labels.
  - Add CPU guard: skip overlay rendering when `Game.cpu.bucket < 100`; otherwise render all owned rooms.
  - Hook `renderHubProgressOverlays()` in `src/main.ts` after creep work (`main.ts:83-87`) and before `cpuProfiler.flush()` (`main.ts:88`) using `cpuProfiler.measure("hubProgressOverlay", renderHubProgressOverlays)`.
  - Add tests to `src/runtime/hubProgress.test.ts` for draw-command generation; do not modify `test/setup.ts` for call recording.

  **Must NOT do**:
  - Do not require manual visual confirmation.
  - Do not render if `RoomVisual` is missing.
  - Do not show unbounded inventory lines in the overlay.

  **Recommended Agent Profile**:
  - Category: `quick` - Small renderer and main-loop hook using Task 2 data.
  - Skills: [`superpowers:test-driven-development`] - Draw commands can be tested first.
  - Omitted: [`frontend-ui-ux`] - Functional compact overlay, not a visual redesign.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: Final verification | Blocked By: 2

  **References**:
  - Pattern: `test/setup.ts:3-23` - RoomVisual exists as a no-op test shim; avoid relying on call recording.
  - Pattern: `src/modules/autoplanner/index.ts` - Guard RoomVisual availability with `typeof RoomVisual === "undefined"`.
  - Pattern: `src/main.ts:83-88` - Insert overlay after creep work and before profiler flush.

  **Acceptance Criteria**:
  - [ ] Draw-command tests assert semantic lines include status, active product, missing resources/error, hub energy, and pending task summary.
  - [ ] `renderHubProgressOverlays()` does not throw when `RoomVisual` is deleted from `global` in a test.
  - [ ] Two owned rooms produce two overlay render attempts through the adapter path or draw-command application helper.
  - [ ] Overlay line count is capped at 8 by test.
  - [ ] Command passes: `npx jest src/runtime/hubProgress.test.ts --runInBand`.

  **QA Scenarios**:
  ```
  Scenario: Overlay content is compact and complete
    Tool: Bash
    Steps: Run `npx jest src/runtime/hubProgress.test.ts --runInBand` with a snapshot containing status=importing, activeProduct=XGH2O, plan actions, and missing U.
    Expected: Draw commands contain human-readable lines for status, active product, plan, missing resource, energy, and pending tasks; line count <= 8.
    Evidence: .sisyphus/evidence/task-3-overlay-content.txt

  Scenario: RoomVisual unavailable is safe
    Tool: Bash
    Steps: Run the test case that temporarily deletes `global.RoomVisual` and calls `renderHubProgressOverlays()`.
    Expected: Function returns without throwing and without mutating hub/runtime state.
    Evidence: .sisyphus/evidence/task-3-overlay-no-roomvisual.txt
  ```

  **Commit**: YES | Message: `feat(hub): render progress overlay in owned rooms` | Files: [`src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`, `src/main.ts`]

- [x] 4. Extend external monitor with hub data, `/hub`, and shard fallback

  **What to do**:
  - Update `scripts/monitor-service.mjs` so `fetchMemorySnapshot()` (`monitor-service.mjs:554-595`) parses `Memory.analytics.hub` in addition to production and moduleCpu.
  - Add `summarizeHub(hub)` near `summarizeProduction()` (`monitor-service.mjs:375`) and return normalized hub fields with null-safe defaults.
  - Include hub summary in the memory snapshot object, `summarizeState()` (`monitor-service.mjs:658-690`), and `logMemorySnapshot()` (`monitor-service.mjs:761-769`).
  - Add HTTP `/hub` endpoint in `createHttpServer()` (`monitor-service.mjs:702-759`) returning latest hub summary and selected shard.
  - Update default endpoint list to include `/hub`.
  - Add shard fallback when `--shard` / `SCREEPS_MONITOR_SHARD` is not specified:
    - fetch candidate analytics for `[undefined, "shard0", "shard1", "shard2", "shard3"]`
    - select the candidate with highest `hub.updatedAt`, else highest production `latestTick`, else first successful response
    - include `selectedShard` and `shardCandidates` in output
    - preserve exact existing behavior when a shard is specified explicitly
  - Add `--shards <csv>` and `SCREEPS_MONITOR_SHARDS=<csv>` candidate override, documented in `printHelp()`, with default `shard0,shard1,shard2,shard3` plus the current no-shard request.
  - Add `--memory-fixture <path>` and `SCREEPS_MONITOR_MEMORY_FIXTURE=<path>` for offline monitor QA. When provided with `--once`, bypass the API, parse that JSON as the memory payload, and still run the same summarization/output path. This avoids adding Jest ESM complexity for `scripts/*.mjs` while keeping monitor parsing agent-testable.

  **Must NOT do**:
  - Do not print or persist Screeps tokens.
  - Do not fetch full `Memory.runtime` or `Memory.data` from the API.
  - Do not require RawMemory segment telemetry for hub monitor access.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Node script parsing, API behavior, and backward compatibility.
  - Skills: [] - No special skill required beyond careful testing.
  - Omitted: [`superpowers:test-driven-development`] - Use tests/fixtures where feasible; live API verification is also required.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: Final verification | Blocked By: 2

  **References**:
  - Pattern: `scripts/monitor-service.mjs:375-448` - Existing production summary normalization.
  - Pattern: `scripts/monitor-service.mjs:554-595` - Existing analytics memory fetch and parse path.
  - Pattern: `scripts/monitor-service.mjs:702-759` - Existing HTTP endpoint routing.
  - Pattern: `scripts/monitor-service.mjs:761-769` - Existing one-line memory snapshot logging.
  - Command: `npm run monitor:once` - Existing monitor one-shot command.

  **Acceptance Criteria**:
  - [ ] Existing monitor output remains backward-compatible when `Memory.analytics.hub` is absent.
  - [ ] When `--memory-fixture` analytics includes `hub`, memory snapshot output includes `hub` summary.
  - [ ] `/hub` returns latest hub summary in server mode.
  - [ ] With no shard specified, output includes `selectedShard` and `shardCandidates`.
  - [ ] With `SCREEPS_MONITOR_SHARD=shard2`, monitor fetches only the explicit shard and does not run fallback candidates.
  - [ ] Help output documents `--shards` and `--memory-fixture` without printing token values.
  - [ ] Command passes after deploy: `npm run monitor:once`.

  **QA Scenarios**:
  ```
  Scenario: One-shot monitor exposes hub analytics
    Tool: Bash
    Steps: Create `.sisyphus/evidence/monitor-hub-fixture.json` with analytics.hub populated, then run `node scripts/monitor-service.mjs --once --memory-fixture .sisyphus/evidence/monitor-hub-fixture.json --output off`.
    Expected: JSON contains `memory.hub.updatedAt`, `hubRoomName`, `status`, terminal energy fields, pending hub task counts, and fixture source info.
    Evidence: .sisyphus/evidence/task-4-monitor-once-hub.json

  Scenario: Missing hub analytics is backward-compatible
    Tool: Bash
    Steps: Run `node scripts/monitor-service.mjs --once --memory-fixture .sisyphus/evidence/monitor-no-hub-fixture.json --output off` with only analytics.production data.
    Expected: Monitor returns ok JSON with `hub.available=false` or `hub=null`; no crash.
    Evidence: .sisyphus/evidence/task-4-monitor-missing-hub.txt
  ```

  **Commit**: YES | Message: `feat(monitor): expose hub analytics snapshot` | Files: [`scripts/monitor-service.mjs`]

- [x] 5. Add `hubProgress` console command and monitor docs

  **What to do**:
  - Add `hubProgressRaw()` and `hubProgressCommand()` to `src/runtime/consoleCommands.ts` following the Raw+Command pattern around `statusHubRaw()` (`consoleCommands.ts:80-99`).
  - Register `global.hubProgress` and `global.hubProgressRaw` in `registerConsoleCommands()` (`consoleCommands.ts:117-124`).
  - Extend `src/global.d.ts` global command declarations near existing `statusHub` declarations with `hubProgress` and `hubProgressRaw`.
  - Command output should be compact JSON (`JSON.stringify(snapshot, null, 2)`) to keep it copyable from Screeps console.
  - Add/extend `src/runtime/consoleCommands.test.ts` for `hubProgressRaw()` and `hubProgressCommand()`.
  - Update `README.md` monitor section with:
    - `npm run monitor:once` now includes hub summary
    - `/hub` endpoint
    - `SCREEPS_MONITOR_SHARD` explicit override
    - fallback behavior when shard is omitted
    - Screeps console `hubProgressRaw()` diagnostic command

  **Must NOT do**:
  - Do not remove or change existing `statusHub()` behavior.
  - Do not require users to enable segment telemetry for hub monitor access.

  **Recommended Agent Profile**:
  - Category: `quick` - Console wrapper, type declarations, tests, and docs.
  - Skills: [] - Straightforward integration.
  - Omitted: [`frontend-ui-ux`] - No UI design work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: Final verification | Blocked By: 2

  **References**:
  - Pattern: `src/runtime/consoleCommands.ts:59-99` - Existing raw/command JSON wrappers.
  - Pattern: `src/runtime/consoleCommands.ts:117-124` - Global command registration.
  - Test: `src/runtime/consoleCommands.test.ts` - Existing tests for console commands including hub status.
  - Docs: `README.md` - Existing External Monitor section documents `npm run monitor:once` and shard env vars.

  **Acceptance Criteria**:
  - [ ] `hubProgressRaw()` returns the same snapshot shape used by analytics/overlay.
  - [ ] `hubProgressCommand()` returns valid pretty JSON.
  - [ ] Existing `statusHub()` tests still pass unchanged.
  - [ ] README includes `/hub` and shard fallback/override guidance.
  - [ ] Command passes: `npx jest src/runtime/consoleCommands.test.ts src/runtime/hubProgress.test.ts --runInBand`.

  **QA Scenarios**:
  ```
  Scenario: Console raw command exposes hub progress
    Tool: Bash
    Steps: Run `npx jest src/runtime/consoleCommands.test.ts --runInBand` with Memory configured for an enabled hub.
    Expected: `hubProgressRaw()` includes runtime hub status and pending hub task summary without changing `statusHubRaw()` expectations.
    Evidence: .sisyphus/evidence/task-5-console-hub-progress.txt

  Scenario: Documentation matches monitor behavior
    Tool: Bash
    Steps: Run `npm run monitor:once -- --help` if supported by npm argument forwarding, or `node scripts/monitor-service.mjs --help`.
    Expected: Help/README document shard override and hub endpoint consistently; no token values are printed.
    Evidence: .sisyphus/evidence/task-5-monitor-docs.txt
  ```

  **Commit**: YES | Message: `docs(monitor): document hub progress access` | Files: [`src/runtime/consoleCommands.ts`, `src/runtime/consoleCommands.test.ts`, `src/global.d.ts`, `README.md`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high (+ monitor command execution; Playwright not needed)
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit 1: `fix(resource-control): feed terminal energy below storage target` — Task 1 only.
- Commit 2: `feat(hub): export progress analytics snapshot` — Task 2 and Task 3 if implemented by same executor; otherwise keep overlay as a separate commit.
- Commit 3: `feat(monitor): expose hub analytics snapshot` — Task 4.
- Commit 4: `docs(monitor): document hub progress access` — Task 5.
- Do not push commits unless explicitly requested after verification.

## Success Criteria
- Satellite rooms with storage below 200k can still get terminal energy fed from storage.
- Pending hub non-energy transfers have terminal fee energy included in reserved/desired terminal energy.
- In-game overlay appears in every owned room when RoomVisual exists and remains safe when RoomVisual is absent.
- `hubProgressRaw()` exposes runtime hub planner status, synthesis stage, plan actions, blockers, inventory, pending hub tasks, and terminal energy blockers.
- `Memory.analytics.hub` is compact, optional, and readable by `npm run monitor:once`.
- Monitor one-shot output includes selected shard/candidates and hub summary, enabling assistant-side diagnosis without Screeps console access.
