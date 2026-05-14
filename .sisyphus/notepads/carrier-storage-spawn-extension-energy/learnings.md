# Learnings

## 2026-05-12 Plan Created
- Change is in `src/roles/carrier.ts` line 634: `includeStorage: emergencyResponseMode` → `includeStorage: isSpawnOrExtensionTarget(energyDemandTarget)`
- `isSpawnOrExtensionTarget` helper at lines 271-273
- `emergencyResponseMode` at line 608, `isEmergencyResponseCarrier` at lines 29-36 — both become dead code after change
- `includeProtoStorage` at line 623 already uses `isSpawnOrExtensionTarget(energyDemandTarget)` — natural dedup to shared boolean
- Fallback path at line 672 with `includeStorage: false` — unchanged
- Existing test precedent: proto-storage spawn/extension guard at line 511, emergency storage guard at line 1219
