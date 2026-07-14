# Terminal Logistics Energy Semantics Design

## Goal

Separate worker energy protection from cross-room logistics so storage relief and other terminal transfers are not suppressed by worker reserve thresholds.

The intended policy is:

- `energyFloor` is not a logistics threshold; it controls automatic worker reserve mode.
- `energyTarget` is the worker reserve recovery threshold and the desired storage energy level.
- `energyExportStart` controls when a room may export energy.
- `terminalEnergyReserve` is a terminal refill target, not an untouchable balance or reserved capacity.
- A non-energy terminal transfer is allowed whenever the terminal has the resource, the receiver has real capacity, and the sender can pay the actual transaction fee.

## Current Failure

The storage-pressure implementation is deployed and can identify overloaded rooms, but several resource-control calculations protect both `energyFloor` and `terminalEnergyReserve`. This can reduce a capacity-relief amount to zero before a task is created, or prevent an existing task from sending even though the terminal already contains usable fee energy.

At the same time, worker reserve mode does not use `energyFloor`. It currently enters below a hard-coded 50,000 storage energy and clears at 80,000. The result is the inverse of the intended ownership: worker behavior ignores the configured worker threshold while terminal logistics is constrained by it.

## Confirmed Semantics

### Worker reserve mode

Worker reserve mode is based on storage energy, excluding terminal energy. Terminal energy remains the room's cross-room logistics fuel and must not make a depleted worker economy appear recovered.

- If storage energy is below `energyFloor`, create the room's automatic reserve flag.
- If the automatic reserve flag exists, retain it until storage energy is at least `energyTarget`.
- Between `energyFloor` and `energyTarget`, preserve the current state. This hysteresis prevents repeated reserve transitions.
- Normalize the thresholds so `energyTarget >= energyFloor`.
- Reserve mode keeps its existing workforce effect: it suppresses worker configurations and prespawn replacements. Already living workers continue their normal lifecycle.
- Existing manually managed reserve flags keep their current behavior; this change only replaces the automatic flag's hard-coded thresholds.

### Energy logistics

`energyFloor` does not participate in energy-transfer planning or execution.

- A room becomes an energy donor only according to `energyExportStart` and its exportable energy.
- A room's refill need is measured against `energyTarget`.
- Donor eligibility uses storage energy: `storageEnergy >= energyExportStart`. Once eligible, the transferable room-energy budget is the room's total energy above `energyTarget`, after production commitments, existing outgoing reservations, and the real send fee. Neither `energyFloor` nor `terminalEnergyReserve` is deducted.
- Sending energy must satisfy the terminal API's real inventory requirement: the terminal must contain both the sent energy and the transaction fee.
- Energy transfers retain receiver-capacity checks, same-tick reservations, task limits, and existing priorities.

The legacy `survival` status may remain available for telemetry and market-policy compatibility, but terminal logistics must not use that status as an eligibility or priority shortcut. It uses `energyTarget` and `energyExportStart` directly.

### Non-energy logistics

`energyFloor` and `terminalEnergyReserve` do not reduce the amount eligible for a mineral, commodity, power, or other non-energy logistics task.

Task planning is based on:

- source resource availability after existing resource-specific protections and reservations;
- receiver need and actual free storage/terminal capacity;
- pending-task and same-tick ledgers that prevent double allocation.

The planner must not silently omit an otherwise valid task merely because the sender currently lacks enough fee energy. Fee affordability is an execution concern and remains observable on the pending task.

At execution time, calculate the exact fee with `Game.market.calcTransactionCost` for the current route and batch. Clamp the batch to the largest positive amount the terminal can currently afford. For a non-energy resource, affordability is `terminal energy >= fee`; there is no additional protected floor. If no positive batch is affordable, retain the task and report `insufficient_terminal_resource_or_fee`.

## Configuration Ownership

Introduce a small pure room-energy-policy resolver shared by resource control and automatic reserve-flag control. It returns normalized values for `energyFloor`, `energyTarget`, `energyExportStart`, and `terminalEnergyReserve` using the existing defaults and per-room overrides.

This avoids duplicating defaults and ensures the worker reserve thresholds are exactly the same configured values shown by resource-control status. Resource control may continue exposing `energyFloor` in status data for compatibility, but it must not use that field to allow, reject, size, or prioritize logistics tasks.

## Terminal Reserve Behavior

`terminalEnergyReserve` remains useful as an operational target:

- terminal-feed work should replenish toward the configured reserve;
- known pending sends may add their expected batch fee to the desired terminal energy;
- the target can influence carrier staging priority.

It is not a hard spend floor. Logistics execution may consume terminal energy below the target, and capacity planning must not reserve hypothetical terminal space for energy that is not present. Real terminal free capacity and same-tick inbound reservations remain authoritative.

Market-order safeguards and factory-specific energy settings are separate policies and are outside this change. In particular, this patch does not change market eligibility or spending merely because the legacy `survival` status remains observable.

## Task Lifecycle and Observability

Capacity relief and normal resource transfers use the same lifecycle:

1. Create or update a task when source supply, receiver demand/capacity, and resource protections allow it.
2. Stage the resource and replenish terminal fee energy through existing hub work.
3. On execution, derive an affordable batch from current terminal contents and the exact route fee.
4. Send a positive affordable batch, update task progress and same-tick ledgers, and clear any stale blocker.
5. If the terminal cannot afford even the minimum batch, keep the task pending with `insufficient_terminal_resource_or_fee` rather than making the demand disappear.

Receiver-full, cooldown, missing-terminal, protected-resource, production-reservation, and task-expiry behavior remain unchanged.

## Implementation Boundaries

The implementation will be limited to:

- replacing hard-coded automatic worker-reserve thresholds with the shared room energy policy;
- removing `energyFloor` and `terminalEnergyReserve` as gates or deductions in terminal logistics planning and sending;
- making non-energy fee affordability use actual terminal energy and the exact transaction cost;
- preserving pending tasks when fee energy is temporarily insufficient;
- updating focused tests and status assertions affected by the corrected semantics.

The change will not reorder the main loop, alter creep role state machines, weaken resource-specific protections, relax receiver-capacity safety, change market trading rules, change factory policy, or redesign task priorities.

## Verification

Add regression coverage for:

- automatic reserve entry below each room's configured `energyFloor`;
- reserve persistence through the hysteresis band and clearing at `energyTarget`;
- a non-energy relief task being created without regard to `energyFloor` or a missing terminal reserve balance;
- a non-energy send consuming terminal energy below `terminalEnergyReserve` when the exact fee is affordable;
- an affordable smaller batch being sent when the full candidate batch is not affordable;
- an unaffordable task remaining pending with `insufficient_terminal_resource_or_fee`;
- energy export still requiring `energyExportStart`, retaining total room energy through `energyTarget`, and having enough terminal energy for cargo plus fee;
- actual receiver capacity and same-tick reservations continuing to prevent overfill.

Run focused Jest suites first, then `npx tsc --noEmit`, `npm run build`, and the full test suite. Deployment and live shard verification are a separate, explicit step after implementation approval.
