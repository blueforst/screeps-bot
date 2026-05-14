# Hub Flag Full-Chain Production - Decisions

## War-core T3 compounds (fixed)
XGHO2, XGH2O, XUH2O, XUHO2, XLHO2

## Target reserve
1000 units per selected T3 per eligible non-hub room storage

## Eligible rooms
Owned rooms with both storage and terminal; exclude hub room from distribution

## Market strategy
Internal resources only; no auto-buy in first version

## Hub designation
HUB flag in owned room -> Memory.cfg.hub.hubRoomName -> flag.remove()

## Hub planner timing
- Runs on cadence (planInterval default 50) OR needsPlan=true (set by flag, cleared by planner)
- Must run BEFORE synthesisControl in main.ts
- Flag setup happens in flagControl (runs after synthesis), so first plan happens next tick

## Transfer priority
1. Survival energy transfers
2. Non-hub synthesis/reagent acquisition
3. hub:import:*
4. hub:reclaim:*
5. hub:export:*
6. Other resourceControl tasks

## Production chain (19 steps for 5 T3 @ 1000 each)
Base: OH(5000), ZK(2000), UL(2000), G(2000)
T1: UH, UO, LO, GH, GO (1000 each)
T2: UH2O, UHO2, LHO2, GHO2, GH2O (1000 each)
T3: XUH2O, XUHO2, XLHO2, XGHO2, XGH2O (1000 each)
