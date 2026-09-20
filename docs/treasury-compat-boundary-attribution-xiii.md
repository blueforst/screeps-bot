# Boundary Attribution XIII

This diagnostic-only change starts from the exact XII default-OFF tree. It does not change, prewarm or replace the commitment index algorithm. It preserves real independent direct/Core Store reads, complete bounded input-table validation, safe integers, canonical task/reservation semantics, full eager indexes and explicit projection completeness. No action, facade lifecycle, or Memory persistence is added.

## Question and measurement boundaries

The rejected raw report at tick 73830700 recorded a 19.1933352 CPU commitment parent interval but only 0.5313477 CPU in its four existing child intervals. The 18.6619875 difference is an unexplained measurement coverage gap, not proof that task scanning, JIT compilation or garbage collection caused it.

Six offsets from the same admitted sample start delimit the parent start, immediately before the actual call, the existing first inner boundary, existing final inner boundary, immediately after the actual call, and the parent end. Their five consecutive differences partition the measured outer interval. The body span overlaps the four existing IX child intervals and is not added to them again.

There are two additional CPU-port observations per completed traced builder call, independent of record count. A pre-call budget rejection can use one additional observation without invoking the builder. All overhead remains in the outer and child measurements: no estimated overhead is subtracted. A calls=0 result is explicitly not_called, never a zero-cost build.

Incomplete or malformed envelopes are not accepted as complete traces. Tail-only successor profiles remain compact and do not repeat the envelope. Fault reports and raw safety-stop reports are retained separately from validated samples.

## Local containment, not hard preemption

The cooperative admission budget remains 2 CPU with reserve 5. The additional pre-call probe also participates in admission: it cannot authorize a builder after the sampled 2 CPU budget is exhausted.

Any observed sample expenditure above 5 CPU latches localSafetyStop. No further sample is executed in that preview heap instance. This cannot interrupt an already executing synchronous builder, reverse its cost, or roll back online code. A best-effort single treasury-compat-safety-stop control message requests external recovery; it is not a fifth business sample.

A newly constructed preview cannot begin at a later due tick within a bound window. The latch itself is heap-local and not persistent across a reset. There is no claim of durable cross-reset exactly-once sampling, particularly if reset/reconstruction occurs during the first due tick. The absolute end tick and independent restore remain required. When the first scheduled sample is skipped or missed, this stricter admission intentionally aborts later sampling rather than silently shifting the window.

## Verification and experiment contract

Default OFF remains mandatory. The generator composes the authenticated IX-to-XI, XI-to-XII, and new XII-to-XIII transformations in both directions; generated Core bytes are unchanged. Every source-manifest output is checked.

Source regression verifies injected latency before, inside and after the body, constant probe count, business parity, zero Memory writes and local containment. Synthetic CPU values and Node timings are not Screeps engine measurements. Only a newly authorized four-point two-room/two-resource window can provide engine evidence. Threshold-triggered closure is valid containment but leaves capture INCONCLUSIVE; it is not repaired by adding points or changing budgets.

The new execution tool grants one candidate upload and one canonical-backup restore attempt for this new experiment. A failed POST is never automatically resent. Third-party code is not overwritten. Recovery requires exact byte reads bracketing a new independent 75-second console/CPU observation. Existing XII incident authorizations remain consumed and are never reused.
