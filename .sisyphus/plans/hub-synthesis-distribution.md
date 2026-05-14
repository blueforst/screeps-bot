# Hub Synthesis Distribution

## TL;DR
> **Summary**: Convert the current single-room hub synthesis planner into a hub-coordinated, multi-room synthesis dispatcher so all T3 supply chains can progress concurrently while minimizing terminal logistics cost. Keep `synthesisControl` as the per-room executor, add global resource accounting and routing decisions in `hubPlanner`, and expand hub progress visuals to show each production room's upstream/downstream chain status.
> **Deliverables**:
> - TDD coverage for multi-room synthesis dispatch, resource accounting, direct routing, auxiliary-room surplus policy, and progress visualization.
> - Multi-room synthesis room eligibility, dispatch, allocation ledger, and per-room config writing.
> - Direct-routing-aware transfer planning, direct-supply-vs-hub-storage conflict protection, and auxiliary self-reserve-before-hub behavior.
> - Hub panel/progress analytics showing participating rooms, progress, upstream suppliers, and downstream consumers.
> **Effort**: Large
> **Parallel**: YES - 4 waves
> **Critical Path**: Task 1 → Task 3 → Task 4 → Task 5 → Task 11

## Context
### Original Request
- “将hub的合成任务分发到不同房间以增加效率”
- “所有t3供应链的并发运转, 以及尽可能降低物流成本”
- “辅助房间生产的t3如果满足自己房间库存, 剩下的应该发往hub”
- “energy不影响lab合成, 只是物流费需要一些”
- “所以不需要排除survival房间”
- “对于一级化合物, 尽量选择产原料的房间可以节省物流成本”
- “hub面板也需要优化, 每个参与生产的房间都显示自己的生产进度, 供应链上游和下游”
- “上游供应链供应的原料数量根据生产需求来定, 房间内的原料满足生产需求后, 多余的上游资源可以发往hub存储”
- “满足普通房间的生产和储备需求后, 其余资源可以发往hub存储”
- “需要注意上下游的原料直供链路与资源发往hub存储产生冲突”

### Interview Summary
- Objective: run all T3 supply chains concurrently where mineral/lab capacity allows, instead of producing one hub reaction at a time.
- Coordinator model: hub remains the single planner; participating rooms execute assigned reactions via existing `Memory.cfg.synthesisControl.rooms`.
- Eligibility: visible owned rooms with storage, terminal, at least 3 labs, and labs not exclusively reserved for boost usage. Survival rooms are eligible because lab synthesis itself does not consume energy.
- Logistics: direct terminal routing is preferred over hub relay when it lowers terminal fee/hops; energy is considered only as transfer fee budget/reserve, not as a synthesis eligibility gate.
- T1 placement: first-level compounds should prefer rooms that naturally produce or already hold the base reagents.
- Auxiliary output: participating non-hub rooms keep produced T3 until their own configured reserve is satisfied; only surplus is sent to hub.
- Upstream supply: direct upstream→downstream quantities are demand-driven; normal rooms keep enough resources for active production plus reserve before any surplus goes to hub storage.
- Conflict rule: direct supply-chain commitments for a resource have priority over hub-storage/reclaim tasks for that same resource, so hub-bound transfers cannot steal downstream production input.
- Test strategy: TDD using existing Jest/ts-jest Screeps mocks.

### Metis Review (gaps addressed)
- Add a global mineral allocation ledger so parallel room assignments cannot double-spend base minerals or intermediates.
- Prevent planner thrash by using cadence/versioned replanning rather than immediate per-room rewrite on every non-hub completion.
- Respect synthesis room runtime state; do not reassign rooms that are loading, synthesizing, unloading, or cleaning up.
- Avoid scope creep into a full logistics optimizer; compare direct route vs hub relay using `Game.market.calcTransactionCost()` and existing pending transfer accounting only.
- Add explicit tests for survival-room eligibility, T1 source-room preference, auxiliary self-reserve, terminal bandwidth awareness, and hub panel per-room chain display.

## Work Objectives
### Core Objective
Implement hub-driven multi-room T3 synthesis dispatch that assigns chain steps to eligible rooms, runs all target T3 supply chains concurrently where feasible, minimizes terminal logistics cost, preserves existing single-room behavior, and exposes distributed progress in the hub panel.

### Deliverables
- Multi-room synthesis eligibility scanner and room capability model.
- Concurrent chain planning/allocation ledger for all configured T3 target compounds.
- Logistics-cost-aware dispatch algorithm with T1 source-room preference, direct routing, stage guard, and terminal bandwidth penalty.
- Extended synthesis config writer that can safely write one active reaction per eligible room.
- Non-hub completion/planning signal handling without high-frequency thrash.
- Auxiliary-room T3 policy: fill local reserve first, transfer surplus to hub.
- Upstream-room surplus policy: satisfy downstream production demand plus local reserve first, then transfer remaining surplus to hub.
- Direct-supply conflict protection: direct route commitments reduce reclaimable/exportable-to-hub amounts for the same resource in the same planning cycle.
- Hub progress analytics/visual model and RoomVisual panel rows for production rooms with upstream/downstream links.
- Jest coverage for all new planner behavior and panel model output.

### Definition of Done (verifiable conditions with commands)
- `npm run test -- --runInBand src/runtime/hubPlanner.test.ts src/runtime/hubProductionIntegration.test.ts src/runtime/hubProgress.test.ts` passes.
- `npm run test -- --runInBand src/runtime/synthesisControlStateMachine.test.ts src/runtime/logistics/resourceTransferTasks.test.ts src/runtime/carrierTaskBoard.test.ts` passes.
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- `npm run build` passes.
- New tests prove: single-room compatibility, multi-room dispatch, all-T3 concurrent chain progress, global allocation ledger, direct routing, T1 source-room preference, survival-room eligibility, stage guard, auxiliary self-reserve surplus return, terminal bandwidth penalty, and hub panel per-room upstream/downstream rendering model.

### Must Have
- Preserve tick order in `src/main.ts`: hubPlanner → synthesisControl → mineralExtraction → resourceControl → hubProgressAnalytics → bootstrap/spawn/creep work.
- Keep `synthesisControl` as executor; do not replace the state machine.
- Write at most one active reaction per synthesis room, matching the existing per-room `reactions[]` contract.
- Use absolute `targetAmount` semantics, matching existing `writeSynthesisConfig()` and project memory.
- Count pending incoming/outgoing transfer tasks and allocated-but-not-yet-created dispatch commitments to prevent double-spending.
- Treat survival rooms as eligible if they satisfy lab/storage/terminal/visibility criteria.
- Do not gate synthesis by room energy except for terminal transfer fee feasibility/reserve.
- Prefer T1 reactions in rooms that produce/hold base reagents.
- Prefer direct route A→B over A→hub→B when direct terminal fee/hops are lower and the consumer is known.
- Keep auxiliary T3 locally up to `reservePerRoom`; send only surplus to hub.
- For upstream intermediates/base resources, calculate supply amount from downstream reaction demand and local reserve before marking any surplus as hub-bound.
- Subtract direct upstream→downstream commitments from hub import/reclaim availability so direct production links and hub-storage transfers cannot conflict.
- Hub panel must show each active production room's product/progress, upstream suppliers, and downstream consumers.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Must not implement a generic multi-hop logistics network optimizer.
- Must not modify `src/runtime/logistics/resourceTransferTasks.ts` semantics unless a failing test proves an existing helper cannot represent the required task.
- Must not rewrite `synthesisControl` carrier task generation or core state transitions.
- Must not exclude survival rooms solely due to survival energy state.
- Must not create a hub-bound transfer for any resource amount already committed to direct upstream→downstream supply or local reserve.
- Must not run real Screeps server operations for verification.
- Must not weaken hub import/export/reclaim invariants, market protection, or existing task-board cleanup behavior.
- Must not reorder main loop phases.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD + Jest/ts-jest using existing Screeps mocks.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (test fixtures/types), Task 2 (eligibility/capability), Task 8 (progress data contract)
Wave 2: Task 3 (chain/allocation ledger), Task 4 (dispatch scoring), Task 6 (routing/transfer accounting), Task 7 (auxiliary output policy)
Wave 3: Task 5 (config writer/replan signaling), Task 9 (hub panel rendering), Task 10 (integration/console/status)
Wave 4: Task 11 (full regression hardening)

### Dependency Matrix (full, all tasks)
- Task 1 blocks Tasks 2-11.
- Task 2 blocks Tasks 3, 4, 5, 8.
- Task 3 blocks Tasks 4, 5, 6, 7, 11.
- Task 4 blocks Tasks 5, 6, 8, 11.
- Task 5 blocks Tasks 10, 11.
- Task 6 blocks Tasks 7, 10, 11.
- Task 7 blocks Tasks 8, 10, 11.
- Task 8 blocks Tasks 9, 10, 11.
- Task 9 blocks Task 11.
- Task 10 blocks Task 11.

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 3 tasks → quick, deep, quick
- Wave 2 → 4 tasks → deep, deep, deep, deep
- Wave 3 → 3 tasks → deep, quick, unspecified-high
- Wave 4 → 1 task → unspecified-high

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Establish distributed synthesis test fixtures and type contract

  **What to do**: Add reusable test helpers for multi-room stores/labs/terminals only if extraction is lower risk than copying existing patterns. Introduce/extend TypeScript interfaces needed for distributed dispatch/progress in `src/global.d.ts` and/or local `hubPlanner.ts` types: room capability, dispatch assignment, allocation ledger entry, direct-route decision, upstream/downstream progress edge. Start with failing tests that assert the new contract can model hub + two auxiliary synthesis rooms without changing runtime behavior.
  **Must NOT do**: Do not change production dispatch behavior in this task; do not create a new top-level Memory subsystem when existing `Memory.cfg.hub`, `Memory.runtime.hub`, and `Memory.cfg.synthesisControl.rooms` can be extended.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: constrained fixtures/types with clear references.
  - Skills: [] - No special skill needed.
  - Omitted: [`screeps-game-data`] - No live game data needed.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: Tasks 2-11 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `test/mock/index.ts` - global `Game`/`Memory` mock reset patterns.
  - Pattern: `test/setup.ts` - `beforeEach` reset and RoomVisual shim.
  - Pattern: `src/runtime/hubPlanner.test.ts` - existing hub/satellite room mock helpers and hub chain assertions.
  - Pattern: `src/runtime/synthesisControlStateMachine.test.ts` - `createStore`, `createLab`, `createSynthesisRoom` patterns.
  - API/Type: `src/global.d.ts` - `Memory.cfg.hub`, `Memory.cfg.synthesisControl.rooms`, `Memory.runtime.hub`, `Memory.runtime.synthesisControl.rooms` declarations.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- --runInBand src/runtime/hubPlanner.test.ts` includes a failing-then-passing contract test for hub + two auxiliary production rooms.
  - [ ] `npx tsc --noEmit` passes with the new/extended types.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Multi-room fixture contract
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "distributed synthesis fixture"`.
    Expected: Test passes and constructs three owned rooms with storage, terminal, labs, and distinct mineral stores.
    Evidence: .sisyphus/evidence/task-1-fixtures.txt

  Scenario: Type contract rejects missing fields
    Tool: Bash
    Steps: Run `npx tsc --noEmit`.
    Expected: Exit code 0; no implicit-any or missing Memory-field errors from distributed synthesis types.
    Evidence: .sisyphus/evidence/task-1-types.txt
  ```

  **Commit**: YES | Message: `test(hub): add distributed synthesis planning fixtures` | Files: `src/global.d.ts`, `src/runtime/hubPlanner.test.ts`, optional `test/mock/helpers.ts`

- [x] 2. Implement eligible synthesis room discovery and capacity scoring

  **What to do**: Add a helper in `src/runtime/hubPlanner.ts` that returns eligible synthesis rooms: visible owned rooms with storage, terminal, at least 3 labs, and not boost-exclusive. Survival-state rooms are allowed. Compute capacity score from lab count/product labs, terminal availability, pending transfer load, existing local reagents, and current synthesis runtime stage. Add tests for eligible survival rooms, missing terminal/storage, insufficient labs, invisible rooms, and boost lab handling.
  **Must NOT do**: Do not exclude rooms because of low energy except when terminal transfer fees cannot be paid for a planned transfer; do not consume boost-only labs.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: eligibility touches hub planning, tick context, boost config, and tests.
  - Skills: [] - No special skill needed.
  - Omitted: [`screeps-game-data`] - Static tests are sufficient.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: Tasks 3, 4, 5, 8 | Blocked By: Task 1

  **References**:
  - Pattern: `src/runtime/tickContext.ts` - `getMyRooms()`, room context, lab discovery.
  - Pattern: `src/runtime/hubPlanner.ts:639` - `runHubPlanner()` room scanning entry point.
  - API/Type: `src/global.d.ts` - hub and synthesis room config/runtime schemas.
  - Pattern: `src/runtime/boostControl.ts` - boost lab usage expectations; avoid assigning labs exclusively reserved for boost.

  **Acceptance Criteria**:
  - [ ] Tests prove survival rooms are eligible when visible with storage+terminal+3 labs.
  - [ ] Tests prove rooms without storage, terminal, visibility, or 3 labs are not eligible.
  - [ ] Tests prove boost-exclusive lab layouts are not selected for synthesis.
  - [ ] `npm run test -- --runInBand src/runtime/hubPlanner.test.ts` passes.

  **QA Scenarios**:
  ```
  Scenario: Survival room remains eligible
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "survival room is eligible for distributed synthesis"`.
    Expected: Planner includes the survival room when storage, terminal, and 3 labs exist.
    Evidence: .sisyphus/evidence/task-2-survival-eligible.txt

  Scenario: Missing logistics structures blocks eligibility
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "requires storage terminal and labs"`.
    Expected: Rooms lacking storage or terminal or 3 labs receive no synthesis assignment.
    Evidence: .sisyphus/evidence/task-2-ineligible.txt
  ```

  **Commit**: YES | Message: `feat(hub): select eligible synthesis rooms` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`

- [x] 3. Add concurrent T3 chain demand planning and global allocation ledger

  **What to do**: Extend the existing chain planning path so all configured T3 targets can be considered concurrently. Keep `planHubChains()` demand-propagation semantics, but add a planning-cycle ledger that accounts for hub inventory, satellite inventory, pending incoming/outgoing resource transfer tasks, direct upstream→downstream commitments, local reserve requirements, and newly allocated reactions. Subtract allocations as assignments are proposed so two rooms cannot consume the same mineral stock and hub-bound surplus cannot consume resource already committed to production. Tests must cover scarce shared base minerals, all-T3 concurrent feasibility, and demand-driven upstream supply amounts.
  **Must NOT do**: Do not change `targetAmount` from absolute goal semantics; do not sell or reserve market resources here.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: central resource-accounting correctness.
  - Skills: [] - No special skill needed.
  - Omitted: [`screeps-game-data`] - In-memory tests cover accounting.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: Tasks 4, 5, 6, 7, 11 | Blocked By: Tasks 1, 2

  **References**:
  - Pattern: `src/runtime/hubPlanner.ts:232` - existing `planHubChains()` demand propagation.
  - Pattern: `src/runtime/hubPlanner.ts:639` - `runHubPlanner()` includes hub inventory and incoming transfer accounting.
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts` - `getIncomingResourceTransferAmount`, `getOutgoingResourceTransferAmount`.
  - Project memory: `writeSynthesisConfig targetAmount represents absolute goal`, not delta.

  **Acceptance Criteria**:
  - [ ] Given 6000 H total and multiple candidate reactions, assigned reactions require no more than 6000 H after pending outgoing transfers.
  - [ ] Given sufficient base minerals and ≥3 eligible rooms, planner produces assignments that advance multiple T3 chains in one planning cycle.
  - [ ] Given an upstream room with 3000 intermediate, downstream demand 1800, and local reserve 500, only 700 is eligible for hub storage/reclaim.
  - [ ] Existing single-product hub chain tests still pass.

  **QA Scenarios**:
  ```
  Scenario: Global mineral budget prevents double spending
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "does not double allocate shared reagents"`.
    Expected: Total planned H consumption across all rooms is <= mocked global available H after pending outgoing tasks.
    Evidence: .sisyphus/evidence/task-3-allocation-ledger.txt

  Scenario: All T3 chains get concurrent progress
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "assigns concurrent progress for all T3 chains"`.
    Expected: Assignments include steps feeding every configured T3 target when labs and minerals are sufficient.
    Evidence: .sisyphus/evidence/task-3-all-t3-concurrent.txt

  Scenario: Upstream surplus excludes production demand
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "calculates upstream surplus after downstream demand and reserve"`.
    Expected: Hub-bound surplus equals store minus direct downstream commitment minus local reserve.
    Evidence: .sisyphus/evidence/task-3-upstream-surplus-ledger.txt
  ```

  **Commit**: YES | Message: `feat(hub): account distributed synthesis allocations` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`

- [x] 4. Implement logistics-cost-aware dispatch scoring

  **What to do**: Add `planSynthesisDispatch()` between chain planning and synthesis config writing. Score eligible rooms for each chain step using: reaction tier, room lab throughput, current stage/idleness, pending terminal load, local reagent inventory, terminal fee for direct routes, hub-relay cost, and T1 source-room preference. For T1 compounds, prefer rooms that produce or already hold the base reagents. For higher tiers, prefer rooms closest/cheapest to upstream producers and downstream consumers. Reject assignments that would create cyclic dependencies.
  **Must NOT do**: Do not implement multi-hop routing beyond direct vs hub relay comparison; do not reassign non-idle rooms.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: core scheduler algorithm and edge-case tests.
  - Skills: [] - No special skill needed.
  - Omitted: [`screeps-game-data`] - Deterministic mock tests required.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: Tasks 5, 6, 8, 11 | Blocked By: Tasks 2, 3

  **References**:
  - Pattern: `src/runtime/hubPlanner.ts:540` - current `writeSynthesisConfig()` consumes first chain step; dispatch should replace the single-step selection before writing.
  - Pattern: `src/runtime/synthesisControl.ts:356` - `selectDonor()` transfer-cost/queue/sticky scoring style.
  - Pattern: `src/runtime/resourceControl.ts:557` - transfer execution priority and terminal busy constraints.
  - API: `Game.market.calcTransactionCost()` - use for direct vs hub-relay fee comparison.

  **Acceptance Criteria**:
  - [ ] T1 test proves base-mineral producer/holder room wins over a farther hub room when both are eligible.
  - [ ] Stage-guard test proves rooms in loading/synthesizing/unloading/cleanup are not reassigned.
  - [ ] Terminal-load test proves a room with many pending incoming/outgoing transfers is deprioritized.
  - [ ] Cycle test proves dispatch assignments form a DAG.

  **QA Scenarios**:
  ```
  Scenario: T1 source-room preference
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "prefers source room for tier one compounds"`.
    Expected: The room holding/producing H+O is assigned OH instead of routing both reagents to hub.
    Evidence: .sisyphus/evidence/task-4-t1-source-room.txt

  Scenario: Busy terminal is penalized
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "deprioritizes terminal-bandwidth constrained rooms"`.
    Expected: A room with mocked pending transfer load loses assignment to an otherwise comparable room.
    Evidence: .sisyphus/evidence/task-4-terminal-penalty.txt
  ```

  **Commit**: YES | Message: `feat(hub): score distributed synthesis dispatch` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`

- [x] 5. Extend synthesis config writing and non-hub replanning signals

  **What to do**: Replace the single-room/single-step writer with a multi-room writer that writes one active reaction per assigned room under `Memory.cfg.synthesisControl.rooms[roomName]`. Preserve the existing hub-only behavior when no auxiliary rooms are eligible. Extend non-hub synthesis completion signaling so completed distributed assignments request replanning without rewriting active rooms every tick; use existing plan cadence or a debounced `needsPlan` flag. Only write new reaction configs to rooms whose runtime stage is idle/blocked/empty enough to accept reassignment.
  **Must NOT do**: Do not modify core synthesisControl stage transitions; do not clear active reactions for rooms still loading/synthesizing/unloading unless the assignment is unchanged.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: memory contract and state-machine interaction.
  - Skills: [] - No special skill needed.
  - Omitted: [`screeps-game-data`] - Unit/integration tests sufficient.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: Tasks 10, 11 | Blocked By: Tasks 3, 4

  **References**:
  - Pattern: `src/runtime/hubPlanner.ts:540` - `writeSynthesisConfig()` existing config writer.
  - Pattern: `src/runtime/synthesisControl.ts:993` - `handleRoom()` per-room execution.
  - Pattern: `src/runtime/synthesisControl.ts:1101` and `src/runtime/synthesisControl.ts:1249` - existing hub-only `needsPlan` signaling sites.
  - Type: `src/global.d.ts` - `SynthesisRoomConfig` and runtime stage types.

  **Acceptance Criteria**:
  - [ ] Single-room test produces identical `Memory.cfg.synthesisControl.rooms[hubRoomName]` shape as before.
  - [ ] Multi-room test writes distinct reactions for hub and auxiliary rooms.
  - [ ] Active non-idle room test preserves its current reaction.
  - [ ] Non-hub completion test sets debounced planner signal without immediate thrash.

  **QA Scenarios**:
  ```
  Scenario: Backward-compatible single-room config
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "single hub room config remains compatible"`.
    Expected: Only hub room receives one reaction and existing assertions pass.
    Evidence: .sisyphus/evidence/task-5-single-room-compat.txt

  Scenario: Non-idle room is not overwritten
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "does not reassign active synthesis room"`.
    Expected: Mock room in synthesizing stage keeps its previous reaction after planner run.
    Evidence: .sisyphus/evidence/task-5-stage-guard.txt
  ```

  **Commit**: YES | Message: `feat(hub): write distributed synthesis assignments` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/synthesisControl.ts`, `src/global.d.ts`, tests

- [x] 6. Integrate direct routing and transfer-task accounting

  **What to do**: Ensure dispatch-created reagent/intermediate needs are represented through existing `createResourceTransferTask()` routes. When a known downstream consumer exists, choose direct producer→consumer if `calcTransactionCost(direct)` is lower than producer→hub + hub→consumer and both terminals can afford fees. Otherwise use hub fallback. Count pending direct transfers in the allocation ledger and progress model. Direct upstream→downstream commitments must reserve the exact quantity needed by downstream production before any same-resource surplus can be routed to hub storage. Preserve transfer task merge semantics.
  **Must NOT do**: Do not call `terminal.send()` from planner; do not add multi-hop paths beyond direct-vs-hub comparison.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: accounting and logistics integration.
  - Skills: [] - No special skill needed.
  - Omitted: [`screeps-game-data`] - Mock terminal tasks suffice.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: Tasks 7, 10, 11 | Blocked By: Tasks 3, 4

  **References**:
  - API: `src/runtime/logistics/resourceTransferTasks.ts` - `createResourceTransferTask`, merge behavior, incoming/outgoing queries.
  - Pattern: `src/runtime/synthesisControl.ts:356` - donor cost scoring.
  - Pattern: `src/runtime/resourceControl.ts:557` - transfer task execution uses terminal sends.

  **Acceptance Criteria**:
  - [ ] Direct-route test creates A→B transfer, not A→hub→B, when B is known consumer and direct fee is lower.
  - [ ] Hub-fallback test creates A→hub transfer when no downstream consumer is known.
  - [ ] Pending direct transfers reduce available resource in subsequent planner cycle.
  - [ ] Direct supply commitment suppresses same-resource hub-bound surplus transfer until production demand and local reserve are satisfied.
  - [ ] `src/runtime/logistics/resourceTransferTasks.test.ts` still passes unchanged or with only additive tests.

  **QA Scenarios**:
  ```
  Scenario: Direct intermediate route
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "routes intermediate directly to downstream room"`.
    Expected: Resource task store contains fromRoom=A, toRoom=B for the intermediate; no equivalent A→hub task exists.
    Evidence: .sisyphus/evidence/task-6-direct-routing.txt

  Scenario: Hub fallback when consumer unknown
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "falls back to hub for unclaimed intermediate"`.
    Expected: Resource task store contains producer→hub route.
    Evidence: .sisyphus/evidence/task-6-hub-fallback.txt

  Scenario: Direct supply beats hub storage
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "prioritizes direct supply over hub storage"`.
    Expected: Resource task store first reserves downstream demand A→B; hub-bound task amount excludes the reserved demand and local reserve.
    Evidence: .sisyphus/evidence/task-6-direct-vs-hub-conflict.txt
  ```

  **Commit**: YES | Message: `feat(hub): route distributed synthesis transfers` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`, optional `src/runtime/logistics/resourceTransferTasks.test.ts`

- [x] 7. Enforce local production/reserve first, then hub surplus policy

  **What to do**: Update hub import/reclaim/distribution planning so normal production rooms retain resources needed for active downstream production and their own reserve before surplus is transferred to hub. For produced T3, retain up to `reservePerRoom`; for upstream/base/intermediate resources, retain the exact direct-supply demand plus local reserve, then send only the remainder to hub. Ensure hub reserve floor still protects hub stock. Extend market/resource protection so satellite-held hub target compounds/intermediates committed to distributed synthesis are not sold or offloaded incorrectly.
  **Must NOT do**: Do not prevent hub distribution to rooms below target; do not reclaim T3 or upstream resources that a room still needs for local reserve or direct downstream production.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: resource policy and protection interactions.
  - Skills: [] - No special skill needed.
  - Omitted: [`screeps-game-data`] - Jest state tests enough.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: Tasks 8, 10, 11 | Blocked By: Tasks 3, 6

  **References**:
  - Pattern: `src/runtime/hubPlanner.ts:370` - `planHubImports()` imports/reclaims from satellites.
  - Pattern: `src/runtime/hubPlanner.ts:460` - `planHubDistribution()` sends T3 to satellites.
  - Pattern: `src/runtime/resourceControl.ts` - `isHubProtectedResource()` market protection for hub resources.
  - Project memory: war-core T3 target = 1000 per eligible non-hub room storage; satellites reclaim surplus T3/intermediates to hub.

  **Acceptance Criteria**:
  - [ ] Satellite with 800 target T3 receives/keeps product and creates no reclaim task.
  - [ ] Satellite with 1500 target T3 and `reservePerRoom=1000` creates reclaim/surplus task for 500 to hub.
  - [ ] Upstream room with direct downstream demand keeps committed amount and only transfers remaining surplus to hub.
  - [ ] When direct-supply and hub-storage plans target the same resource, direct-supply amount is allocated first and hub-storage amount is reduced or skipped.
  - [ ] Hub distribution still fills other rooms below target.
  - [ ] Market protection test proves committed satellite intermediates/T3 are not sold.

  **QA Scenarios**:
  ```
  Scenario: Auxiliary room keeps local T3 reserve
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "auxiliary producer keeps local T3 reserve"`.
    Expected: No hub reclaim task is created while room remains below reservePerRoom.
    Evidence: .sisyphus/evidence/task-7-self-reserve.txt

  Scenario: Auxiliary surplus returns to hub
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "auxiliary producer returns T3 surplus to hub"`.
    Expected: Resource task store contains satellite→hub task for surplus amount only.
    Evidence: .sisyphus/evidence/task-7-surplus-hub.txt

  Scenario: Upstream direct demand blocks reclaim
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubPlanner.test.ts -t "direct upstream demand blocks hub reclaim"`.
    Expected: Hub reclaim/storage task excludes resource already committed to direct downstream production and local reserve.
    Evidence: .sisyphus/evidence/task-7-direct-demand-blocks-reclaim.txt
  ```

  **Commit**: YES | Message: `feat(hub): reclaim distributed synthesis surplus` | Files: `src/runtime/hubPlanner.ts`, `src/runtime/resourceControl.ts`, tests

- [x] 8. Extend hub progress analytics with distributed chain model

  **What to do**: Extend `src/runtime/hubProgress.ts` snapshot/model so it includes active production rooms, assigned product, current amount/target, progress percent, stage, upstream suppliers, downstream consumers, committed direct-supply amounts, hub-bound surplus amounts, and blocked logistics reason. Include pending direct transfers and committed assignments. Tests should assert model shape, not pixel output.
  **Must NOT do**: Do not add a separate UI; optimize the existing hub progress analytics/panel surface.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: model extension with existing visual tests.
  - Skills: [] - No special skill needed.
  - Omitted: [`frontend-ui-ux`] - This is Screeps RoomVisual data, not web UI.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: Tasks 9, 10, 11 | Blocked By: Tasks 1, 2

  **References**:
  - Pattern: `src/runtime/hubProgress.ts` - progress snapshot collection and visual model building.
  - Pattern: `src/visual/panel.ts` - Panel cursor layout.
  - Pattern: `src/runtime/hubProgress.test.ts` - visual model and analytics assertions.
  - Project memory: Hub progress panel currently has Production, Progress, Logistics sections with blockers.

  **Acceptance Criteria**:
  - [ ] Snapshot includes a `productionRooms`-style collection for every assigned synthesis room.
  - [ ] Each row includes product, stage, progress percent, upstream, downstream, direct-supply amount, hub-surplus amount, and blocker fields.
  - [ ] Existing hub progress tests still pass.

  **QA Scenarios**:
  ```
  Scenario: Progress model lists production rooms
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubProgress.test.ts -t "distributed production rooms"`.
    Expected: Model includes hub and auxiliary rooms with products and progress percentages.
    Evidence: .sisyphus/evidence/task-8-progress-model.txt

  Scenario: Chain links are exposed
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubProgress.test.ts -t "upstream and downstream chain links"`.
    Expected: Model shows producer→consumer links for direct-routed intermediates and distinguishes direct-supply amount from hub-bound surplus.
    Evidence: .sisyphus/evidence/task-8-chain-links.txt
  ```

  **Commit**: YES | Message: `feat(hub): model distributed production progress` | Files: `src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`, optional `src/global.d.ts`

- [x] 9. Render distributed production in the hub panel

  **What to do**: Update hub RoomVisual rendering to show each participating production room under the existing hub panel. For each room show: room name, product, progress percent/bar, stage, upstream suppliers, downstream consumers, direct-supply amount, hub-bound surplus amount, and at most two logistics blockers. Use compact rows and existing `Panel` layout helpers.
  **Must NOT do**: Do not overfill visual output with all chain internals; cap rows/links to keep CPU and RoomVisual text reasonable.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: visual rendering extension after model exists.
  - Skills: [] - No special skill needed.
  - Omitted: [`frontend-ui-ux`] - RoomVisual panel follows existing project style.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: Task 11 | Blocked By: Task 8

  **References**:
  - Pattern: `src/runtime/hubProgress.ts` - existing render/build visual code.
  - Pattern: `src/visual/panel.ts` and `src/visual/palette.ts` - panel layout/palette style.
  - Pattern: `src/runtime/hubProgress.test.ts` - RoomVisual call assertions through global visual calls.

  **Acceptance Criteria**:
  - [ ] Visual test asserts room rows render for at least two production rooms.
  - [ ] Visual test asserts upstream/downstream labels render for a direct-routed chain and distinguish supply vs surplus.
  - [ ] Visual test asserts row caps/blocker caps prevent unbounded calls.

  **QA Scenarios**:
  ```
  Scenario: Hub panel renders production room rows
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubProgress.test.ts -t "renders distributed production rows"`.
    Expected: RoomVisual text calls include room names, product names, and progress values.
    Evidence: .sisyphus/evidence/task-9-panel-rows.txt

  Scenario: Hub panel renders upstream downstream context
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubProgress.test.ts -t "renders upstream downstream links"`.
    Expected: RoomVisual text calls include bounded upstream/downstream labels plus direct-supply and hub-surplus quantities for each active production row.
    Evidence: .sisyphus/evidence/task-9-panel-links.txt
  ```

  **Commit**: YES | Message: `feat(visual): show distributed hub production` | Files: `src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`

- [x] 10. Add integration/status coverage for planner → synthesis → resource → progress pipeline

  **What to do**: Extend integration tests so `runHubPlanner()` writes distributed synthesis configs, `runSynthesisControl()` respects them, `resourceControl` sees transfer tasks, and `hubProgress` reports per-room production. Update console/status helpers only if they currently hide active non-hub synthesis rooms; keep commands read-only/status-only.
  **Must NOT do**: Do not change deployment scripts; do not require real console commands for acceptance.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: cross-module integration and regression risk.
  - Skills: [] - No special skill needed.
  - Omitted: [`screeps-game-data`] - Live data optional only after user deploys.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: Task 11 | Blocked By: Tasks 5, 6, 7, 8

  **References**:
  - Pattern: `src/runtime/hubProductionIntegration.test.ts` - hubPlanner → synthesisControl → statusHub pipeline wiring.
  - Pattern: `src/runtime/consoleCommands.ts` - `statusHub`, `stopHub`, `hubProgress` command behavior.
  - Pattern: `src/main.ts` - tick order invariant.
  - Pattern: `src/runtime/carrierTaskBoard.ts` - per-room producer-scoped carrier task board.

  **Acceptance Criteria**:
  - [ ] Integration test covers hub + two production rooms across planner, synthesis config, transfer tasks, and progress snapshot.
  - [ ] Console/status test or direct function test shows active non-hub synthesis rooms are visible in status output/model.
  - [ ] `npm run test -- --runInBand src/runtime/hubProductionIntegration.test.ts` passes.

  **QA Scenarios**:
  ```
  Scenario: Full distributed production pipeline
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubProductionIntegration.test.ts -t "distributed synthesis pipeline"`.
    Expected: Planner writes multiple room configs, transfer task store has required routes, progress snapshot lists all active rooms.
    Evidence: .sisyphus/evidence/task-10-pipeline.txt

  Scenario: Status includes non-hub production rooms
    Tool: Bash
    Steps: Run `npm run test -- --runInBand src/runtime/hubProductionIntegration.test.ts -t "status includes distributed production rooms"`.
    Expected: Status/model includes hub and auxiliary room production state.
    Evidence: .sisyphus/evidence/task-10-status.txt
  ```

  **Commit**: YES | Message: `test(hub): cover distributed production pipeline` | Files: `src/runtime/hubProductionIntegration.test.ts`, optional `src/runtime/consoleCommands.ts`

- [x] 11. Run full regression and harden edge cases

  **What to do**: Run all targeted and full verification commands. Fix regressions without expanding scope. Pay special attention to existing project invariants: terminal_offload assignment staleness, generic energy demand hijacking logistics carriers, hub import/export duplicate tasks, stale hub synthesis reactions when blocked, and carrier cargo inventory gaps. Add regression tests only for failures observed during verification.
  **Must NOT do**: Do not deploy; do not run `npm run push`; do not add unrelated refactors.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: broad regression sweep and edge-case hardening.
  - Skills: [] - No special skill needed.
  - Omitted: [`screeps-game-data`] - Use only local tests/build for this plan.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: final verification | Blocked By: Tasks 1-10

  **References**:
  - Command: `npm run test`
  - Command: `npx tsc --noEmit`
  - Command: `npm run build`
  - Project memory: hub planner/task-board/resource-transfer constraints listed in session history.

  **Acceptance Criteria**:
  - [ ] `npm run test` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `npm run build` passes.
  - [ ] Evidence files contain command outputs for all verification commands.

  **QA Scenarios**:
  ```
  Scenario: Full unit regression
    Tool: Bash
    Steps: Run `npm run test`.
    Expected: Exit code 0; no failing Jest suites.
    Evidence: .sisyphus/evidence/task-11-full-test.txt

  Scenario: Typecheck and build regression
    Tool: Bash
    Steps: Run `npx tsc --noEmit` then `npm run build`.
    Expected: Both commands exit 0.
    Evidence: .sisyphus/evidence/task-11-typecheck-build.txt
  ```

  **Commit**: YES | Message: `test(hub): harden distributed synthesis regressions` | Files: any touched regression tests/fixes from Tasks 1-10

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Real Manual QA — unspecified-high (+ screeps-game-data read-only checks only if deployed later by user)
- [ ] F4. Scope Fidelity Check — deep

## Commit Strategy
- Prefer atomic commits after review checkpoints, with English semantic messages and scope in parentheses.
- Suggested grouping:
  1. `test(hub): add distributed synthesis planning fixtures`
  2. `feat(hub): select eligible distributed synthesis rooms`
  3. `feat(hub): dispatch concurrent synthesis chains`
  4. `feat(hub): route distributed synthesis logistics`
  5. `feat(visual): show distributed hub production progress`
  6. `test(hub): harden distributed synthesis regressions`

## Success Criteria
- All target T3 chains receive concurrent progress assignments when eligible rooms and minerals exist.
- The hub remains authoritative for planning while each synthesis room executes independently through existing `synthesisControl` behavior.
- The planner does not over-allocate minerals across rooms.
- Direct routing and T1 source-room preference reduce unnecessary hub round-trips without introducing multi-hop complexity.
- Auxiliary rooms retain local T3 target stock before exporting surplus to hub.
- Upstream rooms satisfy downstream direct-supply demand and local reserve before exporting surplus to hub, with no conflicting same-resource transfer tasks.
- Hub panel shows distributed production state per participating room with upstream/downstream supply-chain context.
- Existing single-room hub behavior remains covered and unchanged when no auxiliary synthesis rooms are eligible.
