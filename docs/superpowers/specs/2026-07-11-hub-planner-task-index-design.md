# Hub Planner Task Index Design

## Problem

The live Hub planner reached 386 CPU in a single planning tick. The transfer-task store contains 1,545 entries, of which 1,471 are terminal (`cancelled` or `done`). Hub planning repeatedly calls incoming/outgoing amount helpers; each helper currently enumerates every task. Cancelled tasks are excluded from transfer totals but still incur enumeration cost.

## Goal

Keep transfer amounts and internal terminal-routing decisions unchanged while making Hub planning scan the task store a bounded number of times. Terminal tasks must not accumulate for thousands of ticks.

## Design

Add a `ResourceTransferTaskAmountIndex` built from the current pending tasks. It exposes incoming and outgoing amounts keyed by room and resource. While it is built, incoming entries retain the existing blocking-error and visible-source checks. The existing direct helper APIs remain unchanged for callers outside Hub planning.

Hub planning creates a fresh index at each read-only planning boundary and passes it through distributed-synthesis scoring, satellite-deficit calculation, resupply checks, and market-surplus accounting. No index crosses a task mutation boundary, so newly created or cancelled tasks are never hidden from a later planning stage.

Terminal task retention is split from pending blocking-task retention. Completed, cancelled, and failed tasks are pruned after 200 ticks; pending tasks with a blocking error retain the existing 5,000-tick timeout. This preserves retry behavior while promptly removing records that cannot affect future transfer decisions.

## Verification

Tests will prove that indexed incoming/outgoing totals match current semantics, terminal tasks are pruned on the shorter retention period without shortening pending blocking-task retention, and Hub planner functions accept the index without changing their existing task-planning assertions. Type checking, the focused suites, the full test suite, and the production build must pass. After deployment, live memory must show the terminal-task backlog removed and CPU monitor samples must no longer show the Hub planner spike caused by repeated task scans.
