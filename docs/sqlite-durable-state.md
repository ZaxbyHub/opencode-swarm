# `.swarm/swarm.db` — the SQLite durable-state foundation

> Issues #2480–#2481 (Workstream D, PRs 1–2 of 8). This document is the policy source for
> the durable-state substrate: connection identity, support floors, migrations,
> durability classes, integrity/backup/checkpoint policy, the four table
> patterns, the legacy-import contract, and the group-commit writer. Later
> Workstream D PRs (D2–D8) extend the substrate; they do not replace these
> policies.

## Identity — one connection per canonical project root

`canonicalProjectKey(directory)` (`src/db/canonical-project.ts`) computes the
cache key for the project DB handle:

1. `path.resolve` (lexical cleanup), then
2. best-effort `fs.realpathSync` (collapses symlinks/junctions; on Windows it
   also expands 8.3 short names), then
3. case-fold the whole key **on win32 only**. POSIX case is significant —
   `/a/B` and `/a/b` are different roots and stay isolated.

`realpathSync` failure (broken symlink, permissions, a race that removed the
directory) degrades to the lexical spelling — canonicalization never prevents
the DB from opening.

This is project-root *identity*, not security-sensitive file equivalence;
those are different threat models (Workstream B1 / #2474 owns the repo-wide
identity rollout and may adopt this helper).

**Lifecycle.** The handle map has no artificial ceiling: a host process serves
one `ctx.directory`, tests close via `closeProjectDb`/`closeAllProjectDbs`, and
`getOpenProjectDbCount()` is exported for observability. Close paths:

- `closeProjectDb` runs a best-effort WAL checkpoint — `PRAGMA
  wal_checkpoint(TRUNCATE)`, reading its `(busy, log, checkpointed)` result row
  (it REPORTS contention rather than blocking); a busy checkpoint degrades to
  PASSIVE and then gives up — then closes. Never throws.
- The plugin returns a `dispose` hook (`@opencode-ai/plugin` `Hooks.dispose?`)
  that flushes group-commit writers and closes the canonical handle
  (best-effort; whether the host calls it is not verifiable from this repo).
- `process.on('exit')` (`cleanupAutomation` in `src/index.ts`) performs the
  fast close only — SQLite's last-connection close checkpoints the WAL
  implicitly; exit handlers must stay synchronous and fast.
- `/swarm close` closes per-root handles before unlinking (Windows EBUSY
  guard; since #2480 it also closes the group-commit writer first — see
  §Group-commit writer).

## Support floors and driver parity

- `package.json#engines` declares `bun >= 1.3.13` **and** `node >= 22.13`.
- `node:sqlite` is available flag-free only from Node 22.13. The loader
  (`src/db/sqlite-loader.ts`) probes `process.versions.node` on the node
  fallback path and produces a typed floor diagnostic instead of a bare
  module-not-found.
- **The parity contract** (`src/db/driver-parity.ts`, `runDriverParityContract`):
  - EXACT parameter counts — a bound parameter with NO placeholder throws
    `SQLITE_RANGE` under node:sqlite while bun:sqlite tolerates it. Portable
    code never relies on the lax form; the strict fake in
    `src/db/sqlite-loader.test.ts` models it so adapter parity is PR-tested
    under Bun.
  - Multi-statement strings only through the no-parameter `run(sql)` path
    (`exec` on both drivers).
  - Transaction + SAVEPOINT nesting round trip; WAL / busy_timeout /
    synchronous pragma reads.
  - The real node:sqlite leg runs in the merge-queue smoke job
    (`scripts/repro-1873.mjs`, 3-OS, real Node 22) together with the full
    foundation exercise (canonical identity, migrations, writer, stores,
    legacy import, quick_check, backup/restore).

## Versioned migrations + failed-migration recovery

`schema_migrations` (`MAX(version)` + one transaction per migration) remains
the versioning mechanism; v14–v17 added the foundation tables, v18–v25 add the
coordination event/state/lease/import tables and indexes, and every new
migration is a SINGLE statement (a partial application can never hide inside a
multi-statement string). On a migration failure:

1. the migration's transaction rolls back (version stays un-bumped → the next
   open retries it), and
2. the failure is recorded — a row in `migration_failures` (v14) in its own
   transaction; if that table is unavailable (a failure inside v14 itself) or
   the DB refuses the write, a bounded atomic marker
   `.swarm/db-migration-failure.json` is written instead. The marker is
   removed on the next successful migration run.
3. `runProjectMigrations` rethrows a typed `ProjectDbError('migration_failed')`.

Diagnose surfaces open failures (`/swarm diagnose` swarm.db check).

## Legacy import contract (idempotent)

`src/db/legacy-import.ts`:

- Legacy artifact PRESENT + target table/stream EMPTY → import every record in
  ONE `BEGIN IMMEDIATE` transaction (emptiness re-checked inside) → on commit,
  rename the artifact to `<name>.imported` (bounded Windows EPERM retry on the
  low-level rename).
- Crash before commit → nothing imported; the next run retries (idempotent).
- Crash after commit before rename (or a file reappearing because an older
  plugin version wrote it again) → the table is non-empty, so nothing is
  re-imported and **the stale file is left untouched** (inert — readers use
  swarm.db) with a once-per-process warning. Legacy lines are never silently
  destroyed.
- Import runs lazily on first store use, never at plugin init.

## Durability classes (per table)

`src/db/durability.ts` declares a class for EVERY swarm.db table:

| table | class | rationale |
|---|---|---|
| `qa_gate_profile`, `qa_gate_profile_identity` | `full` | locked profiles are terminal state |
| `task_checkpoint_receipt` | `full` | completion receipts are terminal state |
| `coordination_event`, `coordination_state`, `coordination_lease`, `coordination_import` | `full` | cross-process authorization, ownership, and recovery state |
| `insight_candidate` | `normal` | operational learning queue (FIFO + retention bounded) |
| `phase_report` | `normal` | advisory per-phase reports |
| `project_constraints`, `migration_failures`, `schema_migrations` | `normal` | operational/metadata |

SQLite's `synchronous` pragma is connection-scoped and takes effect at the
next commit, so classes are enforced by escalating the pragma around the
write transaction (`withDurabilityClass` / `applySynchronousForClass`):
**any batch containing a full-class op runs the whole transaction at
synchronous=FULL** — authoritative state never inherits the rebuildable-index
durability setting — and the connection is restored to NORMAL afterwards.
Production wiring: every `src/db/qa-gate-profile.ts` write transaction
(`withImmediateTransaction`) and every `task-checkpoint-receipt` write
function; the group-commit writer consults the same map per batch.

## Integrity, backup, checkpoint, busy_timeout, disk-full

- **quick_check in diagnose**: the `swarm.db` health check runs
  `PRAGMA quick_check` size-capped (≤64 MiB; oversize reports a warning),
  reports journal mode, page count, recorded migration failures, and the
  active driver/runtime against the floors. Absent DB is healthy; the check
  never opens-for-create and never throws.
- **VACUUM INTO backup at close**: the `/swarm close` archive stage snapshots
  swarm.db via `archiveSqliteSnapshot` (issue #2030);
  `tests/unit/db/swarm-db-backup-restore.test.ts` pins the
  snapshot→restore→quick_check round trip including the foundation tables.
- **WAL checkpoint policy**: TRUNCATE (PASSIVE fallback) on
  `closeProjectDb`/dispose; SQLite's automatic PASSIVE checkpoints otherwise;
  the memory provider's `checkpointCloseSnapshot` is unchanged.
- **busy_timeout**: 5000 ms on every opener — the cross-process serialization
  budget for the two-windows case (WAL + busy_timeout + BEGIN IMMEDIATE write
  transactions; pinned by `tests/unit/db/project-db-concurrency.test.ts`).
- **disk-full / read-only / corrupt**: open-path failures throw typed
  `ProjectDbError`s (`mkdir_failed | driver_unavailable | open_failed |
  migration_failed`); write failures classify into `DbWriteError` categories
  (`disk_full | read_only | corrupt | busy | unknown`). The group-commit
  writer RETAINS its queue on busy/disk-full/read-only with a cooldown-bounded
  advisory and retries on the next flush; migrated stores keep their
  fail-open semantics (an insight append or phase report failing must never
  block a phase).

## The four table patterns (issue #2480 obligation 7)

1. **Append-only event stream** — `insight_candidate`: PK
   `(stream_id, version)` IS the `UNIQUE(stream_id, version)` contract; the
   version is assigned `MAX(version)+1` inside the appending transaction.
2. **Dual-contract event + state in one transaction** —
   `consumeInsightCandidatesDb`: the SELECT of the pending batch and the
   `consumed_at` UPDATE for exactly those versions happen in ONE
   `BEGIN IMMEDIATE` transaction (and the group-commit writer co-commits
   multi-store batches atomically). D2's coordination migrations build on
   this pattern.
3. **Entity/KV** — `phase_report`: one row per `(kind, phase)`,
   last-write-wins via upsert.
4. **Telemetry sink with DELETE-based retention** — the insight stream's
   pending FIFO cap (500, delete-oldest) and the 7-day consumed-row pruning
   are DELETE-based retention. **FTS5 is the optional extension** of this
   pattern (live precedent: `memory_items_fts` in the memory provider); no
   D1 store needs text search, so no new FTS table exists yet — when one is
   added it follows the memory provider's shadow-table shape.

## Group-commit writer

`src/db/group-commit-writer.ts`: `enqueue(op)` → ONE `BEGIN IMMEDIATE`
transaction per flush applying every queued op (plain `db.transaction()`
issues a deferred BEGIN that deadlocks into SQLITE_BUSY under two-windows
contention — the qa-gate-profile immediate-transaction precedent is the
model). Migrated stores `await flush()` so write durability matches the
legacy awaited file appends; concurrent callers' ops coalesce into one
transaction. Backpressure: the queue is hard-bounded at `MAX_QUEUED_OPS`
(1024) — reaching the bound forces a synchronous flush rather than dropping
writes. Nothing here runs at plugin init.

**Self-healing against a closed handle.** A close site that evicts the DB
handle without closing the writer (the pre-#2480-fix `/swarm close` shape)
would leave the writer flushing against a dead handle. Every production
close site now closes the writer BEFORE the handle (`/swarm close`, plugin
`dispose`, process exit), and as defense-in-depth `flushSync` detects a
closed-handle failure on EITHER driver (bun:sqlite "database has closed";
node:sqlite `ERR_INVALID_STATE` "database is not open"), rebinds to a fresh
handle via `_internals.getProjectDb(registryKey)`, and retries the SAME
batch exactly once — so post-close writes complete transparently. Only if
the retry also fails closed does the writer close itself and evict from the
registry (the next store call then gets a fresh writer); FOREIGN errors
(e.g. a corrupt reopen) never evict. Pinned by sabotage-verified tests and
by the real-node:sqlite leg of the merge-queue smoke repro.

## Atomic coordination state (issue #2481)

`src/db/coordination-store.ts` is the shared authority for cross-process state.
An outer `BEGIN IMMEDIATE` transaction owns the connection's FULL durability;
nested coordination calls use savepoints and cannot lower `synchronous` before
the outer commit. Calls made inside an unknown transaction fail closed. State
transitions support entity revision CAS, monotonic generation fences,
idempotency-key collision detection, and optional append-stream version CAS.
Event append and mutable-state projection commit together.

Legacy files are imported only after plugin registration resolves. Import
re-checks an empty namespace and records its digest in the same transaction;
after commit the source is renamed to `.imported`. A crash before commit leaves
no rows, while a crash after commit cannot duplicate them. Corrupt or ambiguous
legacy authority blocks import. Compatibility files written after cutover are
post-commit shadow projections and never authorize an operation.

The readiness registry retains the underlying import promise even after its
watchdog reports a timeout. Close waits for that promise, and recovery refuses
to start a second attempt while it remains unsettled. `/swarm status` reports
failed/timed-out readiness and `/swarm recover --coordination` performs the
bounded explicit retry after settlement.

## Migration roadmap boundaries (what is NOT in D1)

- Plan ledger (`.swarm/plan-ledger.jsonl`) → D5 (#2484).
- Coordination state (session snapshots, pending delegations, pr-monitor,
  scope bindings, PR reentry authorizations, lane state, workflow
  gates/circuits, background ownership) shipped in D2 (#2481).
- Observability streams (`telemetry.jsonl`, `events.jsonl`,
  `context-telemetry.jsonl`, skill-usage) → D3 (#2482).
- Residual streams (trajectories, knowledge family, run-memory, epic) →
  D4 (#2483).
- Human-facing artifacts (`plan.md`, `SWARM_PLAN.*`, evidence files, …) stay
  files, written as projections.
