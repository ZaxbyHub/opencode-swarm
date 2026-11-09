---
issue: 3231
---

# PR-workflow observability appends: fail-open lock escape and same-revision stale overwrite

## What

Two integrity fixes to the PR-workflow gate's observability-only append path
(rejection journals, skill-contract advisories, and the PR_FEEDBACK
base-mismatch marker), closing #3232 and the remaining scope of #3231.

- **Advisory append honours its fail-open contract under lock contention
  (#3232).** `appendPrWorkflowSkillContractAdvisories` documents that any
  error drops the append silently, but its protective `try` sat inside the
  session-state lock callback, so a lock-acquisition timeout (another process
  holding the lock for the full retry budget) escaped as a rejected promise.
  Its only caller is the auto-resume wake path, which then aborted before
  sending the resume prompt. The lock acquisition now sits inside the
  fail-open boundary, matching the three sibling observability writers; the
  wake continues and the resume prompt is sent.
- **A stale observability append can no longer erase an interleaved one
  (#3231).** Observability appends deliberately never advance the gate state
  `revision` (#3199), so two appenders holding snapshots at the same revision
  were indistinguishable to the write CAS: the second, built from a snapshot
  that predates the first, replaced the whole row and silently erased the
  first append. Appends now carry their own persisted generation
  (`observabilityRevision`): a payload whose generation differs from the
  durable row's is rejected with the existing
  `BLOCKED: PR workflow gate state changed concurrently; reload the active
  session state before retrying` error, and each accepted append advances the
  generation by one. State-machine writes carry the durable generation
  forward unchanged (never reset by a workflow-instance replacement or a
  deliberate observability-field clear, never regressed by a stale snapshot).
  The previously-delivered field-diff guard and required codec binding from
  #3231 (PR #3226's feedback round) still enforce the registered observability
  fields exactly as before; the new append generation is deliberately not a
  registered field — the guard skips it because its own CAS owns
  stale-generation reporting.

## Why

Both defects were generated from the swarm-pr-review of PR #3226: the
advisory-append lock escape (#3232) aborted auto-resume wake evaluations
under lock contention — a user-visible workflow stop — and the same-revision
stale overwrite (#3231) could silently erase durable review evidence
(rejection journals, advisories, binding-mismatch markers) whenever two
appenders interleaved across lock generations. Both are latent-to-intermittent
correctness defects in the gate state's evidence layer, not behavior changes
for fresh-read writers.

## Behavior change

- Fresh-read appends (every in-tree caller re-reads under the session lock
  before appending) behave exactly as before; the durable state revision is
  still unchanged by an observability append.
- Gate state rows gain an optional `observabilityRevision` integer. Rows
  without it are read as generation 0, so existing sessions need no
  migration.

## Known limitations

- **Mixed-version operation is not protected.** An older binary neither
  checks nor advances `observabilityRevision`. Rolling back degrades to the
  previous behavior (the schema's `.passthrough()` keeps older binaries
  compatible with rows that carry the field — a compatibility guarantee, not
  a protection guarantee), and while old and new binaries write the same
  session, an old writer can ignore or regress the generation from a stale
  snapshot.
