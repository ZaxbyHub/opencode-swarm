# Checkpoint saves preserve runtime-state boundaries; rollback backups recover staged bytes and deletions; queued DB writes report truthful outcomes

## What

Checkpoint save, checkpoint restore, and the SQLite group-commit writer now
keep their durable-write promises end to end.

- **Checkpoint save never refuses over `.swarm` exclusion and never commits
  runtime state.** Staging enumerates the dirty set with literal pathspecs
  instead of naming `.swarm` inside the `git add` pathspec (which git rejects
  once `.swarm` is ignored), and both commit arms are scoped so a pre-staged
  `.swarm` entry stays staged and byte-exact instead of being committed.
  Unmerged (conflicted) trees and renames that cross the `.swarm` boundary
  now refuse the save up front rather than staging silently, and save works
  from subdirectory project roots (staging is normalized against the
  git-reported project prefix; file names that do not decode as valid UTF-8
  refuse the save honestly instead of corrupting the add).
- **Rollback backups recover the full picture.** A confirmed restore now
  backs up the staged (index) bytes and mode of every dirty file alongside
  the working-tree bytes (streamed, so large staged blobs no longer hit a
  capture limit; dirty submodule pointers are recorded honestly instead of
  refusing the restore), records deletions in a `recovery.json` manifest
  instead of refusing deletion-only restores, and fails closed on ANY
  recovery-capture incompleteness — including a manifest write failure after
  successful file copies, an unconfirmable "deleted" path, or a file name
  that does not decode as valid UTF-8. Restores now also refuse to run from a
  subdirectory project root, where the hard reset would destroy the PARENT
  repository's uncommitted work unbacked — run restores from the repository
  root.
- **Queued database writes have unambiguous outcomes.** A failed flush DROPS
  its batch (retryable busy/disk-full/read-only included) and throws the
  typed error — previously a retryable batch was retained while ALSO being
  reported as rejected, so an honest retry could commit twice. Nothing is
  requeued automatically: in-tree stores log the loss through their fail-open
  arms, and a caller that wants another attempt must re-enqueue the write
  itself. Every dropped op's optional `onDrop` callback fires exactly once,
  with exactly-once accounting across the observability sink.

## Why

Issues #3763 and #3772 (Workstream R audit consolidation, findings D8/E21
and D-S-1): checkpoint save refused whenever the plugin's own startup
`.swarm` exclusion was present; rollback backups silently dropped staged
state and refused deletion-only restores; the group-commit writer conflated
"retained for retry" with "reported as rejected", duplicating
learning-candidate rows on retry.

## Bounds

The post-COMMIT `synchronous=NORMAL` restore window in the writer
(`applyBatch`'s `finally`) and ambiguous-COMMIT throws remain a known,
disclosed narrow window (no fault-injection coverage in this change).
`close()` still drops unflushed queued writes by documented design, and the
in-memory vs DB observability counter drift on rollback is unchanged.
