## ADDED Requirements

### Requirement: Hub upgrader can operate without local T3
The system SHALL configure an active RCL7 hub upgrader without an XGH2O boost task when its room holds less XGH2O than required to boost all of its remaining unboosted WORK parts.

#### Scenario: No local XGH2O is available
- **WHEN** an active RCL7 hub upgrader has remaining unboosted WORK parts and its room has no XGH2O in storage, terminal, or owned labs
- **THEN** the system SHALL release its boost preparation and configure the upgrader without a boost task so it can work unboosted

#### Scenario: Partial local XGH2O is available
- **WHEN** the room holds some XGH2O but less than the amount required for all remaining unboosted WORK parts
- **THEN** the system SHALL configure the upgrader without a boost task and SHALL NOT wait for a partial boost

### Requirement: Sufficient local T3 keeps boost acceleration
The system SHALL preserve XGH2O boost preparation when the room holds at least the amount required for all remaining unboosted WORK parts.

#### Scenario: Local compound covers all remaining work parts
- **WHEN** the room's storage, terminal, and owned labs together hold enough XGH2O for all remaining unboosted WORK parts
- **THEN** the system SHALL assign the hub-upgrader boost task and prepare the existing XGH2O boost flow
