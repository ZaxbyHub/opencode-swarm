# Bounded retention for every residual durable stream under .swarm/

## What changed

Roughly twenty durable streams under `.swarm/` used to grow without bound:
per-session feedback events, review-receipt and lane-result artifacts,
capsules, per-run memory logs, skill proposals, recovery files, epic
divergence/calibration diagnostics, knowledge retraction/consolidation
audits, the context snapshot, test-impact history, skill changelogs, and
summaries. Nothing capped, pruned, or expired them, and
`summaries.retention_days` was a dead setting with unwired cleanup
machinery. This change installs bounds at three layers:

- **Writer-side caps (issue #2483):** every rebuildable/diagnostic stream is
  now clamped by its production writer — FIFO entry caps (500 retractions /
  500 unacknowledged-criticals / 200 curation proposals / 500 consolidation
  log entries / 5000 test-history entries / 10000 skill-changelog entries),
  byte caps with a whole-record floor (64 KiB context snapshot, 8 MiB epic
  divergence audit), a 500-module lexicographic cap on the epic calibration
  hot-module list, and capped FIFO run logs. Compaction rewrites are
  crash-atomic (temp + rename), and the shared readers are tail-bounded so
  reads stay O(cap), not O(history).

- **First-run retention sweep (30-day horizon):** plugin load schedules one
  bounded, fail-open pass (and `/swarm close` runs another between its
  archive and clean stages) that prunes the residual keyspace families:
  pr-feedback events, PR-review reentry-authorization shadows and run
  artifacts, review receipts, lane results, capsules, run logs, skill and
  skill-improver proposals (14-day pending-review expiry), and recovery
  files at 30 days; the rebuildable `epic/divergence.jsonl` and
  `epic/calibration.json` diagnostics and legacy `doc-drift-phase-*.json.imported`
  archives are deleted whole at 30 days; terminal skill-evolution candidates
  are pruned 30 days after reaching a terminal state (with a 90-day
  age-only backstop for unreadable ones). Summaries cleanup now honors
  `summaries.retention_days` (default 7 days) — the previously dead setting
  is live. The sweep only ever touches paths under `.swarm/`, never follows
  symlinks, never prunes future-dated entries, only ever unlinks whole
  entries matching a family grammar (never partial/`.tmp` names — a
  cloud-sync-style partial artifact is outside every family), and never
  touches the
  authoritative streams (plan ledger, knowledge store, council, evidence,
  scopes, `swarm.db`, telemetry).

- **Close lifecycle (deliberately reversing #1692):** `/swarm close` now
  archives and cleans the repo-graph fingerprint sidecar alongside
  `repo-graph.json` (it used to be orphaned), ends epic-mode runtime state
  (`epic/`, `runs/`, `epic-state.json`, `turbo-state.json` — archived into
  the session bundle first), and removes the `swarm.db-wal` / `swarm.db-shm`
  sidecar paths right after the `swarm.db` unlink. Once the main database is
  unlinked no new opener can attach, and live processes keep their open file
  descriptors, so deleting the sidecar paths cannot corrupt anything; a
  Windows open-handle collision (EBUSY) is skipped fail-open.

## Why

Unbounded durable streams were the last unbounded-growth class under
`.swarm/`: a long-lived project accumulated every review artifact, capsule,
and diagnostic forever, and the retention registry carried the debt as
"fix-in-issue under #2309" — an umbrella with no owner and no bound. The
sweep's deletions are on documented windows (30-day minimum, well outside
any active-session working set), close always archives before cleaning, and
cautious operators can rehearse or disable the whole thing via config:

```json
{
	"retention": {
		"enabled": true,
		"dry_run": false
	}
}
```

`retention.dry_run: true` counts and logs what WOULD be pruned per family
(counts + bytes) without deleting; `retention.enabled: false` turns the
sweep into a no-op. Note the reversibility boundary: **data deleted by the
sweep is not restored by reverting the code** — the opt-out, dry-run mode,
and close-time archiving exist for exactly that reason.

## Notes

- Registry ratchet: the retention registry gate now rejects a new
  `authoritative` direct-file store that does not carry a reviewed
  `directFileExemption` (new authoritative stores belong in `swarm.db`
  unless a reviewed reason exempts them), and a `fix-in-issue` disposition
  can no longer name the resolved scope issues (#2309, #2483, #2045–#2048) —
  a new unbounded stream must carry a real bound or point at an OPEN owning
  issue.
- Tests: `tests/unit/retention/bounded-writers-2483.test.ts` (all nine
  capped writers clamp through the test seam, crash-atomicity, reopen),
  `tests/unit/retention/sweep-2483.test.ts` (per-family prune/keep,
  summaries retention, containment, dry-run, fail-open, wiring),
  `tests/unit/retention/close-sidecars-2483.test.ts` (array memberships,
  sidecar removal, VACUUM INTO archive preserved),
  `tests/unit/retention/edge-cases-2483.test.ts` (deleted/renamed keys,
  drained queues, symlinks, clock skew, torn lines), and
  `tests/unit/scripts/retention-registry-authoritative-ratchet-2483.test.ts`
  (both ratchet rungs).
