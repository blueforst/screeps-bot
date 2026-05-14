# Decisions

## 2026-05-13T09:00 - Initial
- Strategy: count in-flight carrier resources toward lab supply deficit
- Test strategy: TDD regression tests first
- Carrier assignment state extended with pending-delivery snapshot (fromId, toId, resource)
- countInFlightSynthesisCargo() helper in synthesisControl.ts, matching by labId + resource
