# Read Envelope Cost Reduction XV

## Scope and provenance

The accepted XIV default-OFF tree is `0391f4b73522f02829f5151b455a5e5b45d0ab9c`.
The next source commit is based on `eba6a0df574c9cb6101bd3d7e5ebae729d3dd976`.
This is a read-only diagnostic bridge; it does not authorize Treasury actions.
The diagnostic wire version remains XIV. Source/deployment identities still bind
this XV implementation; schema labels are not deployment identities.

## Changes

1. ASCII output strings use a stateless non-ASCII regular expression and their
   exact UTF-16 length (identical to UTF-8 for ASCII). Non-ASCII strings use the
   unchanged surrogate-aware counter. The byte cap, JSON serializer, complete
   report fields, output-limit fallback and retained snapshot shape are unchanged.
2. The bounded legacy table scan uses its own-property descriptor as the own-key
   membership check. Enumerable inherited entries are ignored. Any own accessor
   rejects the whole table without invoking it. Enumeration and the 256 bound
   remain. This intentionally reduces descriptor traps on synthetic proxies;
   it does not promise equivalence of adversarial state-changing proxy traps.
3. CPU accounting uses private static sets for enum membership, scalar finite
   start validation, an exact has-work flag and a shared tail-key definition.
   Sets contain only fixed diagnostic names, are not exported, and hold no live
   inputs or business results. All snapshots remain frozen copies. All probes,
   work keys, failure semantics and measured overhead remain included.
4. Observation room-resource query results were already memoized on demand. Only
   their empty Map container is now allocated at first query. Every observation
   location, amount and total is still built eagerly. All view methods exist at
   return; the commitment index, reservation processing and projection are NOT
   deferred or narrowed. Cache state belongs to a single observation instance.

## Deterministic checks, not engine CPU predictions

An 8192-character ASCII string causes 8192 calls to charCodeAt on the old path
and zero on the new common path. This does not mean string scanning is free.
A 54-task / 12-reservation table removes 66 redundant own-membership helper
calls; it does not remove any records or safe-integer / health validation.
Observation creation allocates zero roomResources memo Maps until queried,
instead of one. First roomResources query allocates one, later queries reuse it.

The package includes byte-authenticated XIV reader, CPU and Core fixtures and
exact reversible transforms. The public generator chains map their canonical
old input all the way to XV and restore it exactly. Generation, source manifest,
provenance, immutable API, invalid input, Unicode and no-write tests are gates.

## Online interpretation

The goal is lower total cost, not more or cheaper-looking probes. CPU budget is
2, reserve is 5, and the existing observation/commitment/task probes and 5 CPU
heap safety latch are unchanged. No prewarming, cross-sample business cache,
per-record probe, skipped index, partial-table-as-complete or synthetic CPU
subtraction is introduced. There are four points, not five. The final point's
post-serialization tail remains unobservable without a successor and must be
reported as unavailable, not estimated. Earlier accepted tails remain measured.

The validated 75-minute finite time-admission execution and original exact-byte
recovery are reused, with one candidate and one restore maximum for this new
experiment. A read-only refusal or incomplete sample is a valid outcome, not an
instruction to modify the package or rerun the window.

History's large CPU spikes have not been causally explained. Local operation
counts and synthetic millisecond measurements cannot prove engine speedup,
stability, JIT/GC attribution, a 12-point observation, or production readiness.
