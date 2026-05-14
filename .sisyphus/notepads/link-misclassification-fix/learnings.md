# Learnings

## 2026-05-09 Session Start

- Existing test mock factory `createLink()` in `src/runtime/linkControl.test.ts` only supports `controllerRange`, `storageRange`, `storageControllerRange` - no source range support. Must be extended.
- Jest setup uses `ts-jest` with `@/` path aliases and Screeps global mocks from `test/mock/index.ts`.
- `Game.time` defaults to 1 in mocks; `Memory` is reset per-test.
- Bug confirmed: `classifyRoomLinks()` line 41 checks receiver proximity BEFORE source proximity at line 46, so a link near both source and storage gets classified as receiver-only.
- `isReceiverByPosition()` (line 71) and `isStorageReceiverByPosition()` (line 80) also lack source awareness.
- `isReceiverLink()` (line 185) uses cached OR positional - stale cache can override current topology.
- `isStorageReceiverLink()` (line 194) uses cached AND positional - still vulnerable if positional returns true for source-overlap.
- `sourceLink.ts` is independent and correct - uses separate `SOURCE_LINK_RANGE = 2` cache.
