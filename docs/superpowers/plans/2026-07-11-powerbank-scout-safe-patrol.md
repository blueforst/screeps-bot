# PowerBank Scout Safe Patrol Implementation Plan

> **For agentic workers:** Execute this plan as one complete TDD task; never commit the intentionally failing RED state.

**Goal:** Keep the PowerBank scout on a bouncing highway patrol and permanently avoid confirmed hostile-owned or hostile-reserved transit rooms.

**Architecture:** The scout stores both patrol index and direction, reversing at E0/E9. Runtime memory keeps controller danger in a permanent boolean map while existing temporary danger retains its 500-tick expiry; the scout passes the union to shared travel.

**Tech Stack:** TypeScript, Jest, Screeps `Memory`, Rollup deployment.

## Global Constraints

- Preserve `E0N60` through `E9N60` as the only power-bank patrol targets.
- Never mark a patrol target as dangerous.
- Temporary combat/damage danger expires after 500 ticks.
- Run typecheck, full tests, and build before `npm run push`.

### Task 1: Implement and verify the scout safety fix with TDD

**Files:**
- Modify: `src/roles/powerBankScout.test.ts`
- Modify: `src/roles/powerBankScout.ts`
- Modify: `src/global.d.ts`

**Interfaces:**
- Add `_patrol.patrolDirection?: 1 | -1`.
- Add `Memory.runtime.powerBankPermanentDangerRooms?: Record<string, true>`.

- [ ] Write failing tests that require an E9 scout with direction `1` to target E8 and set direction `-1`, and an E0 scout with direction `-1` to target E1 and set direction `1`.
- [ ] Add failing tests that a hostile owner or non-self reservation in E3N57 stores `powerBankPermanentDangerRooms.E3N57 === true`, and that `getActiveTransitDangerRooms()` passes both permanent E3N57 and temporary E2N54 through `avoidRooms`.
- [ ] Run `npm run test -- src/roles/powerBankScout.test.ts --runInBand` and confirm the new expectations fail because the existing code loops E9→E0 and has no permanent map.
- [ ] Extend `PatrolMemory`; make `advancePatrol` reverse at both endpoint indices; keep default direction forward for existing creeps without the new memory field.
- [ ] Split controller danger from combat danger. Store enemy owner/non-self reservation permanently; store only damage or hostile combat/power creeps in `transitDangerRooms` with `TRANSIT_DANGER_TTL`.
- [ ] Make `getActiveTransitDangerRooms()` return the de-duplicated permanent-plus-temporary union, delete expired temporary entries, and delete patrol rooms from either map.
- [ ] Add the new runtime Memory declaration and re-run the focused test until green.

### Task 2: Verify, commit, deploy, and inspect the live artifact

**Files:**
- Modify: `src/roles/powerBankScout.ts`
- Modify: `src/roles/powerBankScout.test.ts`
- Modify: `src/global.d.ts`
- Create: `docs/superpowers/plans/2026-07-11-powerbank-scout-safe-patrol.md`

- [ ] Run `npx tsc --noEmit`, `npm run test -- --runInBand`, and `npm run build`.
- [ ] Run `git diff --check`; stage only the scoped source, test, type, and plan files; commit with `fix(powerbank): keep scouts out of hostile transit rooms`.
- [ ] Run `npm run push`, seed the already confirmed hostile room with `Memory.runtime.powerBankPermanentDangerRooms.E3N57 = true`, and read shard1 `Memory.runtime.lastDeployTag` plus the seeded record to verify both deployment and immediate avoidance.
