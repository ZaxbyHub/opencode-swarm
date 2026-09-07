# Worktree reclamation can no longer destroy sibling projects' lanes or uncommitted work (#2527)

## What changed

- **The worktree base now lives INSIDE the project.** The default lane base moved from the
  project's parent directory (`<parent>/.swarm-worktrees`, silently shared by every sibling
  checkout) to `<project>/.swarm-worktrees`. On the next plugin start, an owned, non-live
  lane under the old shared base is migrated with `git worktree move`; foreign and live
  lanes are left untouched for their owning checkouts, and the legacy base is removed only
  when empty. Migration never deletes anything.
- **Every reclamation is ownership-gated.** Plugin init (`runInitOrphanRecovery`) and
  `/swarm reset-session` now route every worktree deletion through one gated helper that
  proves this repository owns the candidate via git's own `commondir` metadata. A foreign
  project's lane is skipped and reported — never deleted.
- **A `git worktree remove` refusal is a stop, never an escalation.** The old code rm-rf'd
  a candidate after git refused it (the "is not a working tree" refusal IS git saying
  "not yours"). Now the refusal preserves the candidate and surfaces the reason.
- **Lane liveness is durable.** Lanes publish a durable owner record
  (`.swarm/live-lane-owners.json`) whose lifetime is the lane's — not the previous
  five-minute lock TTL that made any lane older than five minutes look orphaned to a
  second OpenCode window. Liveness = owning PID alive within a 24-hour claim window
  (bounded PID-reuse blindness; a genuinely >24h dirty lane still survives via git's
  own dirty refusal).
- **`/swarm reset-session` is scoped and confirmed.** It now deletes only lanes this repo
  owns. Clean owned lanes still go without confirmation (unchanged UX); lanes with
  uncommitted or live work are preserved and require re-running with
  `--confirm=<token>`, and the arm step prints the exact per-lane purge preview so the
  operator can see what will be destroyed before confirming (15-minute, single-use
  token — the shared two-step destructive-purge primitive that `/swarm close` (#2508)
  will adopt too). Foreign lanes and ownership-unprovable candidates are never deleted,
  with or without a token: a `.git`-less remnant is purgeable only inside this
  project's own default worktree base — under a configured `worktree_dir` override
  (which may point anywhere) it is reported and preserved.

## Why

Opening a second project in the same parent folder — or running `/swarm reset-session` in
one project — silently deleted the other project's in-flight lane worktrees and every
uncommitted file inside them, reporting a clean success (audit STATE-1/STATE-2/PARALLEL-3;
reproduced on both Bun and Node).

## Known limitations

- A lane genuinely running longer than 24 hours becomes reclaimable if it is CLEAN
  (dispatch deadlines are minutes; a dirty lane always survives git's refusal). A
  forward system-clock jump (NTP correction, VM resume) can also expire a record's
  24-hour claim window early; the lane then loses only its durable owner record —
  init recovery still honors its locks, git registration, and the ownership gate.
- A sibling that never runs this version keeps its lanes at the legacy parent-level
  path; they are surfaced by a bounded advisory line and never touched by this project.
  Downgrading back to a pre-#2527 version after lanes have migrated: the old version
  cannot see (and will not touch) lanes inside `<project>/.swarm-worktrees` — lane
  management is simply unavailable until you re-upgrade.
- A `live-lane-owners.json` written by a FUTURE plugin version is rejected wholesale
  (treated as empty), which silently disables the durable-owner layer until the newer
  version runs again; the other reclamation gates (locks, git registration, dirty
  refusal, ownership) are unaffected.
- `src/evaluation/disposable-worktree.ts` still rmSyncs after `git worktree remove
  --force`, but only inside a tmpdir-contained evaluation sandbox — never a lane path.
