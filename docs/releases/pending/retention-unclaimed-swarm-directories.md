# Unclaimed `.swarm/` directories get a lifecycle

## What

The retention sweep only ever reclaimed the `.swarm/` families it hardcoded,
and blocked every other delete under `.swarm/` — so any directory a subagent
wrote outside that closed set had no lifecycle at all and no supported command
could reclaim it. One production project had 140 MB of its 166 MB `.swarm/`
sitting in `.swarm/review-sandbox` and `.swarm/review-mut`, written by reviewer
subagents and reclaimable by nothing.

Directories immediately under `.swarm/` now have three tiers of ownership:

1. **Tier 1 — hardcoded preserve allowlist.** Swarm's own state (database and
   sidecars, memory, evidence, plan store, knowledge, session/summary state,
   every retention family root, skill stores, locks, quarantine, …) is never
   pruned by the catch-all, whatever its age.
2. **Tier 2 — owner manifests.** `.swarm/retention.d/<owner>.json`:
   `{ "owner": "reviewer", "preserve": ["review-sandbox"], "maxAgeDays": 90 }`.
   One file per owner and one writer each, so there is no shared file to merge
   and no cross-agent edit surface — a single shared config key would turn
   every new scratch owner into a conflict in one file. A claim is a lease, not
   a permanent exemption: past its `maxAgeDays` the directory becomes
   reclaimable again, because a claim that never expires would recreate the
   very defect this fixes. A malformed, ambiguous, or unreadable manifest
   refuses the **whole** sweep (fail closed) and names the file and the reason.
3. **Tier 3 — catch-all.** An unclaimed directory is pruned only when it is a
   real directory (never a symlink), has no `.preserve` marker, contains no
   future-dated entries, and all of its content is older than its horizon
   (30 days by default, or the owning manifest's `maxAgeDays`). Every pruned
   path is appended to `.swarm/retention.log` as
   `<ISO-8601> pruned <path> age=<days> size=<bytes>`, and the log itself is
   compacted to its newest 256 KiB.

`runRetentionSweep({ explain: true })` is the `--explain` surface: it returns
every planned prune (path, age, size, owning manifest) in `result.explained`
and deletes nothing. `dryRun` keeps its existing count-and-report behaviour and
now also populates `explained`.

Containment is enforced **per resolved path**: each candidate is `realpath`-ed
and required to sit inside the `realpath`-ed `.swarm` root immediately before
deletion. The existing whole-sweep containment guard remains as the outer
check, which is not sufficient for a catch-all that deletes arbitrary children
(a child can be swapped for a symlink after that check ran).

## Why

An unbounded, unreclaimable directory family is a disk-exhaustion defect with
no operator remedy: the shell guardrails refuse an unsanctioned recursive
delete, and the sweep refused every path it had not been taught. The three
tiers restore the missing lifecycle without weakening either safety property
that caused the refusal — swarm's own state stays untouchable, and an
ownership claim that cannot be parsed stops the sweep rather than being
treated as permission to delete.

## Migration

No breaking changes and no config key:

- Existing projects need no action; the tier-1 allowlist already covers
  everything swarm writes today.
- An agent that writes its own scratch tree can add
  `.swarm/retention.d/<owner>.json` to declare the horizon it wants. Omitting
  the manifest simply means the 30-day default applies.
- `RetentionSweepResult` gains an optional `explained` field and
  `RetentionSweepOptions` gains an optional `explain` flag; both are additive.

## Caveats

- The catch-all runs last in the sweep, so a sweep cancelled by its budget
  leaves unclaimed directories for the next pass (retention is idempotent and
  runs at every session start and before `/swarm close`).
- Claim expiry is measured from the newest file in the claimed subtree, so an
  owner that keeps writing into a claimed directory keeps its lease.
- A directory whose content cannot be enumerated within the bounded subtree
  scan (2000 stat operations) is treated as in use and kept.
