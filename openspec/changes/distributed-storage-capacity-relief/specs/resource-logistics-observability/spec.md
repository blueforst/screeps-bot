## ADDED Requirements

### Requirement: Runtime analytics expose room capacity health
The system SHALL persist each controlled room's capacity state, storage used/free capacity, terminal used/free capacity, energy state, energy floor, and actual terminal energy reserve.

#### Scenario: Full room is visible
- **WHEN** a controlled room has a full storage or terminal
- **THEN** runtime analytics report zero free capacity and `capacityState` equal to `emergency`

#### Scenario: Terminal reserve is accurate
- **WHEN** a room has different `energyFloor` and `terminalEnergyReserve` values
- **THEN** analytics and terminal-blocker output report the terminal reserve from `terminalEnergyReserve`

### Requirement: Monitor exposes every pending transfer task
The monitor SHALL derive pending transfer counts and task details from the complete resource-transfer task store rather than a Hub-only subset. Each pending task SHALL expose origin, reason, remaining amount, task age, blocker, blocker age, and last-progress age.

#### Scenario: Non-Hub backlog exists
- **WHEN** pending synthesis, power-bank boost, manual, or capacity tasks exist without a pending Hub task
- **THEN** the monitor's pending count includes all of them and is nonzero

#### Scenario: Blocked task is diagnosable
- **WHEN** a pending task has a blocker
- **THEN** the monitor reports the blocker name and elapsed blocked ticks

### Requirement: Relief actions and blocker aggregates are bounded
The system SHALL report recent capacity-relief routes and per-room incoming, outgoing, and blocker counts while bounding persisted action history and computing task aggregates in a bounded number of store scans.

#### Scenario: Relief route progresses
- **WHEN** a capacity-relief send succeeds
- **THEN** the source, receiver, resource, amount, and transaction cost appear in recent bounded actions

#### Scenario: Large historical task store exists
- **WHEN** many terminal task records coexist with pending tasks
- **THEN** analytics use one indexed aggregation pass and do not rescan the full store once per room/resource metric
