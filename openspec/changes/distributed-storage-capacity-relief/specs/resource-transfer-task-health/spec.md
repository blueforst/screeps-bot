## ADDED Requirements

### Requirement: Transfer tasks record origin and progress
Every new transfer task SHALL record whether it is `manual` or `automatic` and SHALL initialize `lastProgressAt`. Existing console task APIs SHALL create manual tasks by default, while system planners SHALL explicitly create automatic tasks.

#### Scenario: Console task is manual
- **WHEN** a user creates a transfer through the existing console API
- **THEN** the task origin is `manual`

#### Scenario: Planner task is automatic
- **WHEN** Hub, synthesis, power-bank boost, energy-support, or capacity planning creates a transfer
- **THEN** the task origin is `automatic`

### Requirement: Retry blockers have explicit lifecycle state
A pending task SHALL represent normal retry conditions with `blockedReason`, `blockedSince`, and `lastProgressAt`. Supported blockers SHALL include `receiver_capacity`, `source_depleted`, and `insufficient_terminal_resource_or_fee`.

#### Scenario: Receiver capacity blocks execution
- **WHEN** a pending task has no receiver capacity above the safety buffers
- **THEN** it remains pending with `blockedReason` equal to `receiver_capacity` and a stable first-blocked tick

#### Scenario: Source depletion takes precedence
- **WHEN** the visible source room has zero storage-plus-terminal stock for the task resource
- **THEN** the task is marked `source_depleted` before receiver capacity is evaluated

#### Scenario: Task makes progress
- **WHEN** a terminal send succeeds
- **THEN** blocker fields are cleared and both `lastProgressAt` and `updatedAt` are set to the current tick

#### Scenario: Blocker clears without recreation
- **WHEN** the condition represented by a task's blocker is restored
- **THEN** the existing pending task becomes executable without a duplicate task

#### Scenario: Health refresh after the send budget is exhausted
- **WHEN** earlier transfers consume the shared send budget before a later pending task is reached
- **THEN** the later task's blocker condition is still reevaluated without attempting another terminal send

#### Scenario: Failed send retains an unresolved blocker
- **WHEN** a task with an unresolved supply blocker reaches a viable send attempt but the terminal returns an error
- **THEN** the blocker and its original `blockedSince` remain until a later independent health check observes recovery or a send succeeds

### Requirement: Reservation health distinguishes blocked from phantom supply
Pending tasks blocked by receiver capacity or temporary terminal supply/fee SHALL remain valid incoming and outgoing reservations. A source-depleted task SHALL be excluded from healthy incoming supply after the configured grace period while remaining visible in the raw task list.

#### Scenario: Capacity blocker prevents duplicate demand
- **WHEN** an incoming task is receiver-capacity-blocked
- **THEN** Hub and synthesis reservation reads still count its remaining amount

#### Scenario: Depleted source is not incoming inventory
- **WHEN** an automatic incoming task has been source-depleted for 100 ticks using defaults
- **THEN** effective incoming calculations exclude its remaining amount

### Requirement: Automatic stalled tasks expire but manual tasks persist
The system SHALL cancel an automatic pending task after 5,000 ticks without a successful send or after 100 ticks of source depletion using defaults. It SHALL NOT apply either automatic liveness cancellation rule to a manual task.

#### Scenario: Automatic no-progress timeout
- **WHEN** an automatic pending task has not made progress for more than 5,000 ticks
- **THEN** it is cancelled with a machine-readable liveness reason

#### Scenario: Automatic source-depleted timeout
- **WHEN** an automatic pending task remains source-depleted for more than 100 ticks
- **THEN** it is cancelled before it can reserve phantom incoming supply indefinitely

#### Scenario: Old manual task is retained
- **WHEN** a manual pending task is older than both automatic timeouts
- **THEN** it remains pending unless a user cancels it or an existing hard validation rule fails it

### Requirement: Legacy task migration is conservative and idempotent
The system SHALL migrate legacy task records once per task schema version. It SHALL infer automatic origin only from known generated reason prefixes and SHALL treat every unknown or absent reason as manual.

#### Scenario: Known generated task migrates
- **WHEN** a legacy task reason begins with `hub:`, `synthesis:`, `auto:synthesis:`, `powerBankBoost`, `energy-support`, or `capacity:`
- **THEN** the task becomes automatic and receives initialized progress fields

#### Scenario: Unknown legacy task is preserved
- **WHEN** a legacy task has an unknown or absent reason
- **THEN** it becomes manual and is not removed by automatic liveness cleanup

#### Scenario: Migration runs again
- **WHEN** reconciliation executes after the current task schema version is already recorded
- **THEN** it makes no duplicate transition or destructive change
