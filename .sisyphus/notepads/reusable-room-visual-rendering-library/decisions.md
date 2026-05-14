# Decisions

## [2026-05-12] Panel class vs fluent builder
- Chose ordinary Panel class with internal cursor state.
- Reason: eliminates "forgot to capture return value" bug class entirely.

## [2026-05-12] First version scope
- Hub panel only; do not migrate autoplanner visuals.
- Reason: autoplanner is JS/prototype-heavy; too risky for first pass.

## [2026-05-12] VisualSurface interface
- Expose only `rect()` and `text()` initially.
- Reason: YAGNI; expand when a second consumer needs more primitives.
