## Why

RCL7 hub upgraders currently wait indefinitely for XGH2O boost preparation, even when their own room has no XGH2O to supply it. This prevents normal controller upgrading during a local T3 shortage.

## What Changes

- Make hub-upgrader XGH2O boosting conditional on sufficient XGH2O already available in the upgrader's room.
- When local XGH2O is insufficient, release any hub-upgrader boost preparation and run the upgrader without waiting for a boost.
- Preserve the existing full XGH2O boost flow when the room has enough local compound for all remaining unboosted WORK parts.

## Capabilities

### New Capabilities

- `hub-upgrader-optional-t3-boost`: Allows hub upgraders to make upgrade progress without a local XGH2O supply while retaining local T3 boost acceleration.

### Modified Capabilities

- None.

## Impact

- `src/runtime/hubUpgradeControl.ts` decides whether the active upgrader receives a boost task.
- `src/runtime/hubUpgradeControl.test.ts` covers local stock and downgrade behavior.
- No external API, dependency, or spawn-body changes.
