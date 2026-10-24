# Recovering interrupted coder settlements

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
current task before explicitly merging or cherry-picking that commit.

List retained backups with:

```sh
git for-each-ref --format='%(refname) %(objectname)' refs/swarm/coder-settlements/
```

A proven committed recovery releases its matching backup automatically.
Squash-unstaged landings, failed recovery and historical aborted settlements
retain backups because working-tree bytes alone are not a committed copy.
After explicitly landing and verifying such work, remove its exact backup
using the displayed ref and expected source object ID:

```sh
git update-ref --no-deref -d refs/swarm/coder-settlements/<source-oid> <source-oid>
```

The expected object ID prevents deleting a ref that changed after inspection.
Retained refs keep their source commits reachable to Git garbage collection;
they do not replace the settlement log or authorize reopening an old task.
