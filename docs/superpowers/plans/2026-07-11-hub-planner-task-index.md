# Hub Planner Task Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Hub planner CPU spikes caused by repeatedly scanning terminal transfer history.

**Architecture:** Build a short-lived incoming/outgoing amount index from pending tasks, and inject it into Hub planner read phases. Retain pending-task expiry behavior while pruning terminal task records after 200 ticks.

**Tech Stack:** TypeScript, Jest, Screeps Memory.

## Global Constraints

- Do not change pending-transfer totals or internal terminal-routing decisions.
- Do not enable market buying or selling.
- Do not reuse an index after a transfer-task mutation boundary.
- Terminal task TTL is 200 ticks; pending blocking-task TTL remains 5,000 ticks.

---

### Task 1: Add indexed transfer totals and retention split

**Files:**
- Modify: `src/runtime/logistics/resourceTransferTasks.ts`
- Test: `src/runtime/logistics/resourceTransferTasks.test.ts`

- [ ] Write failing tests for indexed incoming/outgoing totals with a cancelled task and a blocking pending task.
- [ ] Run `npm run test -- src/runtime/logistics/resourceTransferTasks.test.ts --runInBand` and confirm the missing index API fails.
- [ ] Implement `createResourceTransferTaskAmountIndex()` by scanning pending tasks once and preserving `isPendingTransferStillSupplyable` behavior.
- [ ] Split terminal and blocking-pending cleanup TTL parameters; retain backward-compatible default behavior for direct callers.
- [ ] Re-run the focused suite and confirm all assertions pass.

### Task 2: Use scoped indexes in Hub planning

**Files:**
- Modify: `src/runtime/hubPlanner.ts`
- Test: `src/runtime/hubPlanner.test.ts`

- [ ] Write a failing regression test proving a supplied transfer-total index is used by distributed synthesis without changing the resulting assignment.
- [ ] Run `npm run test -- src/runtime/hubPlanner.test.ts --runInBand` and confirm it fails because the public planner API has no index parameter.
- [ ] Thread fresh indexes through satellite-deficit, distributed-synthesis scoring, resupply, and market-surplus read phases.
- [ ] Use 200 ticks for terminal cleanup and retain 5,000 ticks for blocking pending tasks.
- [ ] Re-run the focused Hub planner and transfer-task suites.

### Task 3: Verify and deploy

**Files:**
- Verify: `src/runtime/logistics/resourceTransferTasks.ts`, `src/runtime/hubPlanner.ts`

- [ ] Run `npx tsc --noEmit`, `npm run test -- --runInBand`, `npm run build`, and `git diff --check`.
- [ ] Commit the implementation.
- [ ] Deploy with `npm run push`.
- [ ] Read live transfer-task counts, deployment tag, and CPU monitor samples to verify backlog cleanup and absence of task-scan spikes.
