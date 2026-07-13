## ADDED Requirements

### Requirement: Capacity pressure is independent and hysteretic
The system SHALL classify every owned room with both storage and terminal as `normal`, `pressure`, or `emergency` independently from its energy state. It SHALL enter pressure at the configured low-free-capacity thresholds and SHALL not return to normal until both configured recovery watermarks are satisfied.

#### Scenario: Full structure is an emergency
- **WHEN** either an owned room's storage or terminal has zero free capacity
- **THEN** the room's capacity state is `emergency` regardless of its storage energy

#### Scenario: Pressure persists inside the hysteresis band
- **WHEN** a previously pressured room is no longer full but storage free is below 200,000 or terminal free is below 80,000 using defaults
- **THEN** the room remains `pressure`

#### Scenario: Both structures recover
- **WHEN** a pressured room has at least 200,000 storage free and 80,000 terminal free using defaults
- **THEN** the room returns to `normal`

### Requirement: Relief receivers preserve safety capacity
The system SHALL create a new relief route only to a normal owned room with storage and terminal that meets the configured receiver admission watermarks. Every send SHALL retain the configured storage and terminal safety buffers, and a pressure or emergency room SHALL NOT receive capacity-relief inventory.

#### Scenario: Receiver is admitted
- **WHEN** a normal room has at least 300,000 storage free and 50,000 terminal free using defaults
- **THEN** it is eligible for a new capacity-relief route

#### Scenario: Send is capped at receiver buffers
- **WHEN** a pending relief task exceeds the receiver's capacity above 100,000 storage free or 40,000 terminal free using defaults
- **THEN** the send amount is capped to the smaller safe capacity and neither buffer is crossed

#### Scenario: No safe receiver exists
- **WHEN** every other owned room is pressured or below a receiver admission watermark
- **THEN** no unsafe relief transfer is created and the source remains observably pressured

### Requirement: Relief planning is bounded and deterministic
The system SHALL route relief through resource-transfer tasks with reason `capacity:relief:<resource>`. It SHALL keep at most one healthy pending relief task per source, create or replace at most one such task per source and five globally per planning run, and cap a task at 50,000 units by default.

#### Scenario: One route per pressured source
- **WHEN** a pressured source already has a healthy pending capacity-relief task
- **THEN** the planner does not create a duplicate relief task for that source

#### Scenario: Receiver ranking is stable
- **WHEN** multiple receivers are eligible for the same resource
- **THEN** the planner ranks greater safe capacity first, lower receiver stock second, lower transaction cost third, and room name last

#### Scenario: Unsafe existing receiver is replaced
- **WHEN** an existing automatic relief task is receiver-capacity-blocked and another eligible receiver exists
- **THEN** the old task is cancelled and one replacement task is created without double-reserving the amount

### Requirement: Relief moves the most useful safe surplus
The system SHALL prioritize movable non-energy stock already in a pressured terminal, then movable surplus from storage after terminal recovery. It SHALL calculate movable stock after all configured floors, T3 reserve, active production reservations, valid outgoing commitments, and energy send cost.

#### Scenario: Terminal stock creates an immediate lane
- **WHEN** a terminal is below its recovery watermark and contains movable non-energy resources
- **THEN** the largest movable terminal resource is selected before a storage-only resource

#### Scenario: Storage surplus is staged
- **WHEN** terminal recovery is satisfied, storage remains pressured, and a movable storage surplus exists
- **THEN** a relief task is created and the existing carrier-task mechanism stages the selected resource into the terminal

#### Scenario: Reserved production input is protected
- **WHEN** part of a resource is covered by an active synthesis, boost, factory, or production reservation
- **THEN** only stock above that reservation and other safety floors is eligible for relief

#### Scenario: T3 reserve is protected
- **WHEN** a room contains a T3 boost compound
- **THEN** at least 5,000 units per compound remain in that room using defaults

### Requirement: Survival energy uses total protected stock
The system SHALL calculate energy donor availability from storage plus terminal energy while preserving the donor's energy floor, terminal energy reserve, valid reservations, outgoing commitments, and transaction cost. Survival energy support SHALL run before automatic capacity relief.

#### Scenario: Terminal-heavy donor can help
- **WHEN** a donor's total energy exceeds all protected energy even though storage energy alone is below the export threshold
- **THEN** the excess may be sent to a survival room without crossing donor protection

#### Scenario: Donor protection wins
- **WHEN** a proposed energy send or its fee would cross the donor's energy floor or terminal reserve
- **THEN** the send is reduced or skipped

### Requirement: Capacity relief never liquidates to market
Capacity pressure SHALL only generate owned-room transfer tasks. It SHALL NOT create a market order, execute a market deal, widen configured sell resources, or relax configured sell prices.

#### Scenario: No receiver for a full room
- **WHEN** a room is full and no owned receiver is eligible
- **THEN** the capacity-relief subsystem waits and reports the blocker without selling the resource
