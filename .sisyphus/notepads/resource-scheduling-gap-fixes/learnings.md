## Market Sell + Outgoing Transfer Reservation (T2)

- `executeTransferTasks` runs BEFORE `applyMarketOps` in `runResourceControl()`. Tests with transfer tasks must include BOTH source and destination rooms in `Game.rooms`, otherwise `executeTransferTasks` will fail the task (status="failed") and `getOutgoingResourceTransferAmount` won't count it (only counts "pending").
- Default `mineralExportStart[H]` is 15000. When testing the outgoing-reservation guard, set total stock close to this threshold so the reservation tips the surplus below `minDealAmount` (1000).
- `getOutgoingResourceTransferAmount` was already imported in resourceControl.ts (line 9) — no new import needed.
- `getStock()` returns storage + terminal amounts; NOT changed per requirements.
- `applyMarketOps` does NOT check `terminalBusy` set — only `terminal.cooldown`. So even if a transfer was just sent, market ops may still attempt a deal on the same tick.
