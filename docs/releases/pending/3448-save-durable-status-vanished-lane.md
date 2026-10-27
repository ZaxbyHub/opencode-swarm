# Fix: coder settlement self-heal could never fire because saveDurableStatus recreated the vanished lane directory

## What changed

`saveDurableStatus` in `src/hooks/delegation-gate/worktree-merge-status.ts` created its target
directory with `fs.mkdirSync(dir, { recursive: true })` whenever it did not exist. A coder child
session binds the durable-status singleton to its own lane worktree, so when a lane worktree (and
its branch) were removed while a coder settlement was still DISPATCHED, the failed
`/swarm recover <task>` re-attempt recorded its `source-worktree-gone` failure by recreating the
vanished lane root — containing only `.swarm/worktree-merge-status.json`.

That resurrection permanently defeated the settlement self-heal
(`selfHealMissingLaneWorktree` treats any existing lane directory as "still alive"), so every
recovery attempt re-created the directory and threw
`CODER_SETTLEMENT_MERGE_RECOVERY_REQUIRED` forever — a self-defeating loop requiring manual
deletion of the recreated directory between attempts.

The write is now guarded: the `.swarm` status directory is created only when its parent (the
project or lane root) still exists, and the mkdir is non-recursive (that directory is always
exactly one level below a root). A vanished root is left absent, so the self-heal fires on the
first attempt; a live root persists exactly as before.

## Why

`/swarm recover` on a DISPATCHED settlement whose lane worktree and branch are both gone now
reaches `STALE_CODER_SETTLEMENT_SELF_HEALED` (WAL marked ABORTED, task unblocked) on the first
attempt. No project-visible recovery data is lost by the skipped lane-local write: the self-heal
decision reads the WAL descriptor's worktree/branch paths, not this status file, and no reader
scans a lane-local copy (project-level readers scan the project root). The in-memory registry
remains authoritative for the process; a failure recorded while bound to an already-vanished lane
is memory-only and is not restored after a restart (it previously persisted only to a file inside
the removed lane, which no reader consulted either).

## Impact

- `/swarm recover <task>` no longer wedges in the worktree+branch-both-gone scenario; new
  occurrences need no manual directory deletion.
- Normal durable-status persistence on live project/lane roots is unchanged (atomic temp-write
  path untouched).
- Concurrent `.swarm` creation by another writer (`EEXIST`) proceeds to the write; a root that
  vanishes mid-write can no longer be recreated by this writer.

## Migration

No migration is required to benefit from the fix, but an install that already hit the old loop
still has the plugin-recreated lane directory on disk (containing only
`.swarm/worktree-merge-status.json`); recovery keeps failing until that leftover directory is
deleted once. A host restart may reclaim it automatically as an ownerless lane directory;
otherwise delete `.swarm-worktrees/<session>/<task>/` by hand, then re-run `/swarm recover`.
