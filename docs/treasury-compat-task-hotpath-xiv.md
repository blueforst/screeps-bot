# Task Hotpath XIV and bounded first-pending attribution

## Scope and evidence

XIII measured one rejected forensic report with 6 tasks (5 pending):
`commitmentTasks` 14.211667600007786 CPU, inside a closed 15.029942199988 CPU
commitment parent. Three earlier samples did not call the builder and already
exceeded 2 CPU. This is a location observation, not proof of a function-level,
JIT, GC, or task-count cause. The exact six online task records were not captured.
XIV neither claims to reproduce that event nor estimates engine improvement
from Node wall-clock measurements.

## Deterministic changes

The Preview resolves an own data property with one descriptor lookup instead
of a separate own-property test followed by the same descriptor lookup. Missing,
inherited and accessor properties remain distinguishable; accessors are never
invoked by these path helpers. The legacy projection root is traversed once per
admitted sample, lazily when the first readable endpoint needs it. The cursor
expires with the sample, and never supplies Store values to either reader.

The task loop inlines four ordinary checked-add helper calls. Addition and
`Number.isSafeInteger` validation remain before the corresponding bucket writes;
overflow still marks the same incomplete scopes and continues the full scan.
Canonical record validation, pending status, demand/receiver health, expiry,
owner handling, self-route aliasing, merge first-wins behavior, all reservations,
all indexes, detached query methods, and every projection row remain intact.
No business result is cached across samples. The public current transforms H/P
compose the new exact reversible transforms; historical intermediate transforms
and authenticated XIII fixtures remain separately inspectable.

## Bounded task interval probe

Only the first valid pending record in a table receives one start/end pair.
Its ordinal includes invalid and nonpending records before it. The start is
after that record passed canonical validation and before its pending-processing
body. A finally boundary includes overflow/early-continue paths and faults.
The existing task-subphase start/end delimit the whole table; no extra clock
calls are made for those outer marks. The partition is:

- beforeFirstValidPending: table setup, earlier records and first validation;
- firstPendingProcessing: the selected record's pending work;
- remainingTable: all following records and task-loop completion.

Empty or nonpending-only tables add zero CPU reads. Tables with 1, 6 or 256
pending records add exactly two reads in total, not two per record. The existing
XIII outer call pair and nine subphases remain. All probe costs are included.
No pending record is omitted or allowed to bypass a correctness guard.

These three regions overlap commitmentTasks, which overlaps measuredBody and
the commitment parent. Never sum overlapping views. not_called is not zero-cost
construction; no_pending is not permission to report an empty table if records
were invalid. Faults and incomplete traces remain explicit and cannot qualify
as complete samples. Tail-only completion never repeats task envelopes.

## Offline and online boundaries

The local replay uses synthetic empty, six-record and 256-record corpora,
including mixed-invalid and reservation inputs, and compares all indexed API
results for first and repeated actual calls. It reads no live Memory, performs
no production warm-up and cannot prove a 14 CPU spike or an engine speedup.

The existing 2 CPU cooperative budget, reserve 5, two rooms/two resources,
independent direct/Core Store reads, full 256-entry table bounds, four points,
100-tick spacing and default OFF remain. The heap-local >5 CPU safety latch
still blocks later samples and fails closed on late starts after reset, but
cannot preempt a running synchronous call or guarantee cross-reset exactly-once.
Every sample includes the latch and timing overhead. A rejected raw report can
inform forensics only, not formal diagnostic or production acceptance.
