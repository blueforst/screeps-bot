# PowerBank Scout Safe Patrol Design

## Goal

Prevent the PowerBank scout from entering hostile transit rooms such as E3N57 while preserving discovery coverage for the E0N60 through E9N60 highway patrol.

## Patrol traversal

The scout patrol is a bounce, not a ring. It travels from E0N60 to E9N60, then reverses toward E0N60. This removes the long E9N60-to-E0N60 return traversal that previously allowed unconstrained multi-room pathing to leave the highway corridor.

`patrolIndex` remains the current destination index. A new `patrolDirection` memory field is either `1` or `-1`; it reverses at index `0` and `POWER_BANK_PATROL_ROOMS.length - 1`.

## Danger memory

Transit danger is split by cause:

- A room with an enemy owner or non-self reservation is persistently blacklisted in `Memory.runtime.powerBankPermanentDangerRooms`.
- A room where the scout is damaged or sees hostile combat units/power creeps is temporarily blacklisted in `Memory.runtime.transitDangerRooms` for 500 ticks.

The active avoid list is the union of both stores. Permanent entries are intentionally retained until explicitly cleared by a future console operation or code change; no automatic re-entry is allowed solely because a TTL elapsed.

## Routing and behavior

The scout continues to pass its active avoid list to `moveToTargetRoom`. Its destination is always one patrol room away after the bounce change, so multi-room routing no longer has a long wraparound journey in which to choose E3N57 as a shortcut.

## Tests

Add regressions that verify the E9 endpoint reverses to E8, the E0 endpoint reverses to E1, an owned/reserved room creates a permanent record, temporary combat/damage danger still expires, and the active avoid list includes both record classes.
