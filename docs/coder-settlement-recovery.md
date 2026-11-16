# Recovering interrupted coder settlements

> This guide documents the operator recovery surface for coder settlements:
> the `/swarm recover` entry point, retained backup refs under
> `refs/swarm/coder-settlements/`, the historical `RECOVERABLE_ORPHAN_COMMIT`
> advisory and its exits, and the
> [operator-visible error codes](#operator-visible-error-codes).

Run `/swarm recover <task-id>` after an interrupted isolated coder dispatch.
The settlement write-ahead log remains authoritative. Do not remove its JSON
file to unblock a task: it contains the source commit and dispatch identity
needed to distinguish recoverable work from an empty, abandoned lane.

Recovery verifies the recorded source object before deciding that a missing
checkout is unrecoverable. When that object survives, recovery retains it at
`refs/swarm/coder-settlements/<source-oid>`. An absent original lane branch can
be restored only if its name is still unoccupied. A different or symbolic ref
is preserved and recovery refuses to overwrite it.

For merge settlements, recovery can land the exact recorded source on a
primary branch that has advanced from the recorded target. It verifies target
ancestry and checks dirty overlap again before applying the immutable merge.
Conflicts, source drift, inaccessible objects and uncertain state remain
recoverable failures. Pending settlement records also protect their checkout
and branch from ordinary cleanup; dispatch publication and deletion share a
bounded admission lock.

When a foreground coder dispatch completes through background execution, the
background record saves its merge provenance before retiring the exact
foreground settlement owner. A failed handoff retains the lane for replay.
If physical cleanup fails after settlement, replay checks the saved identity
and cleans up without applying the merge again. Dirty or changed lanes remain
available for manual recovery, and cleanup of older settled records retains
their source branch.

An older release may already have marked a settlement `ABORTED` with the reason
`CODER_SETTLEMENT_SELF_HEALED_MISSING_WORKTREE`. Recovery of that specific state
preserves a surviving source and reports `RECOVERABLE_ORPHAN_COMMIT`, including
the exact object ID and backup ref. It keeps the historical task terminal and
does not automatically apply work from its old workflow generation. Review the
current task before explicitly applying that commit.

The `RECOVERABLE_ORPHAN_COMMIT` report for such a historical record is
advisory and non-blocking. It is printed as a critical warning and buffered
for `/swarm diagnose`, at most once per ten minutes for the same source in one
process. Recovery still completes: task status updates, re-dispatch and
`/swarm close` are not blocked by it, and the settlement log stays `ABORTED`
and unchanged. Recovery only fails closed when it cannot establish the facts,
for example `CODER_SETTLEMENT_SOURCE_UNCERTAIN` when Git cannot say whether the
source object exists. It also refuses, and does block until the ref is fixed,
when it cannot secure or release the backup: if
`refs/swarm/coder-settlements/<source-oid>` is symbolic, unreadable or points
at a different object, the error starts with
`RECOVERABLE_ORPHAN_COMMIT: <source-oid>; occupied ref` or
`CODER_SETTLEMENT_REF_UNCERTAIN`.

The report repeats until the preserved source counts as landed. For a
historical record with the default `merge` strategy, only a Git merge that
makes the preserved source commit an ancestor of `HEAD` clears it. That
includes `git merge -s ours <source-oid>`, which records the commit as handled
without taking its changes. Recovery then releases the backup ref and stops
reporting. A squash merge, a cherry-pick or a rebased copy of the changes does
not make the original commit an ancestor, so the record keeps reporting.
Deleting the backup ref does not clear the report either. It only removes the
protection that keeps the preserved commit from Git garbage collection: while
the object still exists, the next recovery re-creates the ref and reports
again, and once garbage collection prunes the object, the work is gone.

List retained backups with:

```sh
git for-each-ref --format='%(refname) %(objectname)' refs/swarm/coder-settlements/
```

A proven committed recovery releases its matching backup automatically, and so
does recovery of a historical aborted settlement whose source is already an
ancestor of `HEAD`. Squash-unstaged landings, failed recovery and historical
aborted settlements whose source has not landed by ancestry retain backups,
because working-tree bytes alone are not a committed copy. After explicitly
landing and verifying such work, remove its exact backup using the displayed
ref and expected source object ID:

```sh
git update-ref --no-deref -d refs/swarm/coder-settlements/<source-oid> <source-oid>
```

The expected object ID prevents deleting a ref that changed after inspection.
Retained refs keep their source commits reachable to Git garbage collection;
they do not replace the settlement log or authorize reopening an old task.

## Operator-visible error codes

These codes are new with this recovery surface. Each one refuses an operation
instead of guessing, and none of them discards a recorded settlement, lane or
source. Resolve the stated condition, then retry the operation or run
`/swarm recover <task-id>` again.

- `CODER_SETTLEMENT_ARTIFACT_PROTECTED`: a cleanup tried to remove a lane
  worktree or branch that a `DISPATCHED` or `PREPARED` settlement still
  records, so the artifact was kept.
- `CODER_SETTLEMENT_ARTIFACT_UNCERTAIN`: the settlement inventory could not be
  read completely (for example a symbolic or non-regular record, or more than
  200 entries), so a removal was refused rather than guessed.
- `CODER_SETTLEMENT_ARTIFACT_REMOVAL_REFUSED`: worktree removal was refused
  because settlement artifact admission or its protection check failed; the
  message carries the underlying error.
- `CODER_SETTLEMENT_DISPATCH_ARTIFACT_CHANGED`: at dispatch publication the
  lane checkout, branch or `HEAD` no longer matched the captured baseline, so
  the dispatch was not recorded.
- `CODER_SETTLEMENT_REF_UNCERTAIN`: a lane branch or backup ref under
  `refs/swarm/coder-settlements/` was symbolic, unreadable, malformed or held
  a different object, so recovery would not overwrite or delete it.
- `CODER_SETTLEMENT_SOURCE_UNCERTAIN`: Git could not determine whether the
  recorded source object exists (for example an unreadable object store or a
  malformed object ID), so the source is never treated as absent.
