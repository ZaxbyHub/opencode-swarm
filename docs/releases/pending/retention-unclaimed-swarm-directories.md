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
   a permanent exemption: the claim SETS the directory's horizon to its
   `maxAgeDays` (longer or shorter than the 30-day default), and past it the
   directory becomes reclaimable again, because a claim that never expires
   would recreate the very defect this fixes. A malformed, ambiguous, or unreadable manifest, or a `.json` file in
   `retention.d` whose name is outside the manifest grammar, refuses the **whole**
   sweep (fail closed) and names the file and the reason.
3. **Tier 3 — catch-all.** An unclaimed directory is pruned only when it is a
   real directory (never a symlink), has no `.preserve` marker, contains no
   future-dated files, and all of its content is older than its horizon
   (30 days by default, or the owning manifest's `maxAgeDays`). The pass
   refuses to run when `.swarm/retention.log` is a link, is not a regular file,
   or cannot be inspected, so a prune is not started against a log it cannot
   record to (a permission failure on a regular log still surfaces only after
   the deletes, in `result.errors`); after the deletes, every pruned path is appended to the
   log as `<ISO-8601> pruned <path> age=<days> size=<bytes>` (control characters
   in a name are escaped), and the log itself is compacted to its newest
   256 KiB.

`retention.dry_run` (`runRetentionSweep({ dryRun: true })`) keeps its existing
count-and-report behaviour and now also populates `result.explained` with every
planned prune (path, age, size, owning manifest) and writes that list to the
debug log (visible only with `OPENCODE_SWARM_DEBUG=1`), which is how an operator previews what the catch-all would remove
before enabling it. It deletes nothing: no family file and no directory.

Containment has three layers. The catch-all refuses to run at all when `.swarm`
is itself a link (a `.swarm` linked to the project root would otherwise make
`.git` and `src` look like unclaimed children). Each candidate must be a real
directory, not a link. And each candidate is `realpath`-ed and required to be an
immediate child of the `realpath`-ed `.swarm` root immediately before deletion;
this narrows, but cannot close, the window in which a parent could be swapped
for a link, and that window needs write access to `.swarm`.

## Why

An unbounded, unreclaimable directory family is a disk-exhaustion defect with
no operator remedy: the shell guardrails refuse an unsanctioned recursive
delete, and the sweep refused every path it had not been taught. The three
tiers restore the missing lifecycle without weakening either safety property
that caused the refusal — swarm's own state stays untouchable, and an
ownership claim that cannot be parsed stops the sweep rather than being
treated as permission to delete.

## Migration

No config key and no API removal, but **this release deletes data on upgrade**:

- **The first sweep after upgrade deletes unrecognised `.swarm/` directories
  whose newest file is older than 30 days.** The sweep runs at every session
  start and before `/swarm close`, with `retention.enabled` defaulting to on.
  The tier-1 allowlist covers the directories swarm itself writes (a unit test
  checks it against the retention registry), but anything else under `.swarm/`
  that you or a tool put there — scratch trees, hand-made backups, exported
  reports — is reclaimable.
- To keep a directory: put a `.preserve` file in it (permanent), or declare it
  in `.swarm/retention.d/<owner>.json` (a lease with its own `maxAgeDays`).
- To preview first: set `retention.dry_run: true` and run with
  `OPENCODE_SWARM_DEBUG=1`; the planned prunes are then written to the debug
  log (without that variable the log is silent) and nothing is deleted. To opt out entirely:
  `retention.enabled: false` (this also disables every other retention
  family; there is no catch-all-only switch).
- A malformed `retention.d` manifest refuses the whole sweep, family prunes
  included; the reason is in `result.errors` and, because neither production
  caller surfaces the result, only in the debug log (`OPENCODE_SWARM_DEBUG=1`).
- `RetentionSweepResult` gains an optional `explained` field (populated under
  `dryRun`); it is additive.

## Caveats

- The catch-all runs last in the sweep, so a sweep cancelled by its budget
  leaves unclaimed directories for the next pass (retention is idempotent and
  runs at every session start and before `/swarm close`).
- Claim expiry is measured from the newest file in the claimed subtree, so an
  owner that keeps writing into a claimed directory keeps its lease.
- A directory whose content cannot be enumerated within the bounded subtree
  scan (2000 entries, counting files, directories and links) is treated as in
  use and kept, and the sweep reports it in `result.errors['.swarm/<name>']` (visible
  only in the debug log, `OPENCODE_SWARM_DEBUG=1`) so an operator can tell why a large stale tree is never
  reclaimed. Large source-tree-like sandboxes exceed this budget: mark them
  with `.preserve` or remove them by hand.
- Age is the newest regular-file mtime in the tree. Copies that preserve
  mtimes (`cp -a`, tar, Windows `copyFile`) look old on the day they are made,
  so put a `.preserve` marker in a freshly copied scratch tree you want to
  keep.
- The scan cost is per candidate directory and synchronous; a `.swarm/` with
  thousands of large unclaimed directories makes the first sweep slow.
