# Hub Logistics Runtime Fixes — Learnings

## 2026-05-12 Session Start
- Hub room is E4N58 on shard1 (NOT shard2).
- Hub config: enabled=true, hubRoomName=E4N58, reservePerRoom=1000, targetCompounds=[XGHO2,XGH2O,XUH2O,XUHO2,XLHO2].
- Live hub inventory: XUHO2=894 (below reserve), others far above.
- 844 resource-transfer tasks in terminal state (204 done, 640 failed with remaining_below_transfer_min).
- Carrier test failures are pre-existing and owned by another agent — do not block on them.
- Hub status "distributing" with no synthesis room config — consistent with planHubChains double-subtraction bug.
