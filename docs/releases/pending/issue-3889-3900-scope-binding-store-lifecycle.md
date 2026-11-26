---
issue: 3889, 3900
---

# Scope binding store lifecycle: deny ledger, class-faithful diagnostics, reset recovery, tombstone preservation

## What changed

- `SCOPE_BINDING_STORE_OVERLOADED` is no longer a catch-all: durable-read
  failures that are not capacity (malformed or workspace-mismatched rows,
  import/ledger errors) surface as a new fail-closed
  `SCOPE_BINDING_STORE_UNREADABLE` class with a recovery message that names
  the real store (the `scope-binding` rows of `.swarm/swarm.db`), wired
  through the delegation gate, scope-guard (which also stops falling through
  to the PR-feedback scope when the store is unreadable), the shell write
  path, and the session-wide resolver. A corrupted row can no longer wedge
  every coder write behind a misleading capacity message (#3889).
- A compact per-workspace deny ledger (one coordination row,
  `scope-binding-deny` namespace) now backs immediate terminal-row
  collection: declaration/claim/teardown/compensation/reset transitions
  delete the retired row and install exact-generation deny evidence in the
  same transaction, so stale in-memory authority in another runtime stays
  denied after the row disappears. A transition retires only the row its
  caller named: a different binding stored under the same key and revision
  is refused, and a caller that passes the payload it observed (the reset
  sweep does) retires exactly that content or nothing — legacy rows that
  carry no binding id stay on the key-and-revision check. The legacy `binding-*.json` projection is
  removed with the row instead of being left behind as a tombstone file.
  Time-expired live rows are collected once past the 24h idle-revival window
  (in-window revival candidates are preserved); reads schedule bounded
  maintenance when collectable rows exist. Unbounded superseded/expired
  accumulation is gone (#3889).
- Consequence for expired generations: a lease that lapsed beyond the
  idle-revival window is no longer revived. Until bounded maintenance
  collects its row, a gate that observes it denies the write as
  `SCOPE_BINDING_EXPIRED` (with its expiry); once the row is collected,
  lookups report it as not declared. A generation retired by an
  explicit terminal tombstone is collected at once and resolves as
  not-declared. Both outcomes deny writes and point the architect at
  `declare_scope`.
- Claim/declaration successors commit with admission-pending deny evidence
  in the same transaction (deny-first): a crash or compensation failure can
  never leave an unadmitted live successor authorizable; successful
  admission releases the entry via compare-and-remove.
- `/swarm reset-session` now sweeps the reset sessions' durable scope rows
  (raw-authoritative attribution by owner/parent/workflow session) through
  the same sink and clears the matching in-memory authority. The sweep pages
  past the scan capacity while rows are being removed, and reports honestly
  instead of printing a successful zero. Each line states only what the sweep
  established: a store it could not read (with the rows swept before
  that), a sweep that filled its scan capacity or reached its pass limit
  before it could confirm the store was seen in full, rows no session can
  claim (the realistic corruption, reported as seen), and every row whose
  retirement attempt threw — resolved by the sweep's last listing of it or,
  failing that, read once more before it is reported, so that one still in
  place, one gone or no longer the reset sessions', one found corrupt and
  one the store refuses to read are each reported separately. Because a
  thrown attempt does not say whether the retirement committed, the sweep
  never claims a row could not have been retired; a row gone or handed to
  another session after such an attempt is named in its own line rather
  than dropped, and is not counted as cleared — and the sweep retires only
  the exact content it listed, so a row replaced under the same key and
  revision by different content is refused, left in place, and reported
  that way instead of deleted. Every row is reported one way, never two.
  Every warning names the real location (#3889).
- `sweepExpired` preserves deliberate revocation/supersession tombstones
  across sweep eviction and advances their revision so the deny covers the
  revived revision — the fail-open of #3900 is closed.
- Committed regression batteries:
  `tests/unit/scope/scope-binding-store-lifecycle-3889-3900.test.ts`
  (parameterized over revoked/superseded tombstones under lease-lapse and
  24h-age triggers, revived-revision denial, fresh-declaration recovery);
  `tests/unit/scope/scope-store-lifecycle-obligations-3889-3900.test.ts`
  (legacy backfill deny entries, second-runtime reset denial, post-commit
  compensation-failure via the sink seam, claim-pending release, 300-row
  single-flush drain, the sink refusing a different binding under the same
  key and revision);
  `tests/unit/scope/scope-maintenance-zero-progress-3889.test.ts`
  (fault-injected maintenance stays quiet with rows retained, then drains
  after recovery); `tests/unit/scope/scope-failclosed-contract-3889.test.ts`
  (store-level fail-closed legs: store_unreadable classification, unreadable
  deny ledger, null-payload reset rows, FIFO-flood/no-TTL pending survival,
  compare-and-remove scoping, post-window terminalization, pending-denied
  revival); `tests/unit/scope/scope-failclosed-routes-3889.test.ts`
  (route-level legs: reset-session durable sweep wiring and lineage
  attribution, scope-guard denial without the PR-feedback fallback under an
  unreadable store on both the task and session routes, delegation-gate
  denial); `tests/unit/scope/scope-reset-sweep-reporting-3889.test.ts`
  (recovery text names the real store, an unreadable store is reported and
  still clears in-memory lineage, paging past the scan capacity, truncation
  reporting, rows whose retirement attempt threw are read again and reported
  by what that read showed);
  `tests/unit/scope/scope-reset-sweep-reconcile-3889.test.ts` (a row a
  concurrent writer removed is reported as gone, not as left in place; one it
  re-attributed is reported as no longer theirs; one the store refuses
  to read again is reported separately from one found still in place; one
  found corrupt is reported as unidentifiable);
  `tests/unit/scope/scope-reset-sweep-buckets-3889.test.ts` (a row is
  reported once by what the sweep last established, across interleavings of
  pages, concurrent writers and a failing final read — including a row
  cleared and then re-inserted, one that failed and is then listed again as
  another session's (not read again, reported as relinquished), and one that
  changed hands and was then deleted; fixtures shared
  through `tests/helpers/reset-sweep-fixtures-3889.ts`);
  `tests/unit/scope/scope-reset-sweep-replacement-3889.test.ts` (the sweep
  retires only the content it listed: a row replaced under the same key and
  revision by a different binding, or by content that carries no binding id,
  is neither cleared nor deleted, while the same content stored again is
  retired; a row it gave up on and later listed as theirs again is reported
  by its latest word);
  `tests/unit/scope/scope-store-readers-3889.test.ts` (the raw
  row list matches the validated reader, stays bounded, and hands an
  unparsable payload to recovery untouched; a deny ledger that fails
  validation reads as unreadable on the resolver and as a typed failure on a
  terminal transition, never a throw).
  Pre-existing suites re-pinned to the ledger contract:
  `scope-admission-rollback.test.ts`, `scope-binding-durability.test.ts`;
  to the new failure class: `nested-project-boundary-writers.test.ts`;
  to a realistic lapsed-lease expiry: `scope-diagnostic-advisory-2096`
  and `scope-lease-renewal-wiring-2096`; to projection removal:
  `scope-persistence-cleanup`.

## Why

#3889: the scope binding store never garbage-collected superseded/expired
rows and rendered every durable-read failure as a capacity wedge with no
self-service recovery. #3900: `sweepExpired` overwrote deliberate revocation
tombstones with `expired` ones, re-authorizing bindings whose durable
retirement failed.
