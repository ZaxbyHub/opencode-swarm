# PR_FEEDBACK publication generations (issue #2108)

The PR_FEEDBACK publication window is a **generation-numbered state machine**
with audited invalidation and reapproval. This document is the operator
reference: state diagram, generation identity, the exact push grammar,
invalidation triggers, the reapproval path, cancellation without publication,
migration from the pre-#2108 armed record, and how to inspect the audit trail
without ever editing state files.

## State diagram

```
                 complete_pr_workflow (every ordered gate passes,
                 exactly one reviewed commit, full identity resolves)
  reviewing ────────────────────────────────────────────────► armed
     ▲                                                            │
     │                          proven drift (any actor)          │ admit exact push
     │                          or invalidate_pr_feedback_        │ (durable attempt-start)
     │                          publication (controller rework)   ▼
     │                                                      push_in_flight
     │                                                            │
     │              result observed (tool-after or reaper)        │
     │                    ┌───────────────────────────────────────┘
     │                    ▼
     │  fresh Stage A +   armed ──complete_pr_workflow──► published (terminal)
     └──independent gates─┤                                   (verified remote head)
                          │
                          └──abort_pr_workflow──► cancelled_without_publication
                              cancel_publication        (terminal, no push authority)
```

States (durable, on the gate state file under `.swarm/pr-workflow-gates/`):

| State | Meaning | Safe exits |
| --- | --- | --- |
| `reviewing` | Ladder in progress, nothing armed | the normal workflow |
| `armed` | One generation armed for publication | exact push → `push_in_flight`; `complete_pr_workflow` → `published`; audited invalidation → `invalidated`; cancellation → `cancelled_without_publication` |
| `push_in_flight` | An admitted push attempt has no observed result yet | result observation or reaper → `armed`; invalidation; cancellation |
| `invalidated` | The generation's approvals are ALL superseded; rework open | fresh ladder re-arms generation N+1; cancellation |
| `published` | Terminal — verified remote head at the approved commit | none (workflow clears) |
| `cancelled_without_publication` | Terminal no-publish state | none (workflow clears) |

## Generation identity

The authorization key is the **full generation identity**, not a session id,
branch name, or digest alone. Captured at arming, re-verified on every armed
interaction:

- canonical workspace identity (`canonicalWorkspaceIdentity`)
- session id and PR target URL
- immutable intake head SHA; local branch ref + exact local head SHA
- remote name + **credential-redacted remote URL identity** (`git remote get-url`, userinfo stripped — a repointed remote cannot receive the approved push)
- remote branch ref + remote-tracking ref
- the independently approved revision digest
- the exact receipt set that authorized the generation (Stage A `validatedAt` + one batch id/lane id per ordered phase)
- generation number and created/armed/invalidated/published/cancelled timestamps

## Exact push grammar

The only publish-capable command is exactly:

```
git push <remote> <approvedHeadSHA>:refs/heads/<branch>
```

parsed structurally before shell execution. Everything else is rejected with a
typed reason: force/force-with-lease (any flag), delete refspecs, tags,
wildcards, multiple refspecs, mirror/all/prune/atomic, alternate remote or
branch (case-sensitive compare), credential-bearing or URL remote tokens,
config injection (`-c`), `--repo=`/`--receive-pack=` overrides, shell
wrappers, redirection, control operators, and command substitution. The
accepted set is byte-identical to the pre-#2108 regex defense.

## Invalidation triggers (proven drift, from any actor)

Drift is detected at every armed-window gate (push admission, completion,
status-bearing asserts). Proven drift on any component — revision digest, Git
HEAD, working tree, upstream triple, remote URL identity, workspace identity —
durably invalidates the generation (under the session lock, with the drifted
component re-verified there). Unresolvable components (git outage, digest
resolver failure) **stay armed and fail closed** — unverifiable is not
invalidation evidence. Reads, rejected calls, failed writes, and byte-identical
no-op writes never revoke approval.

Invalidation supersedes every content-dependent approval of the generation —
Stage A result, verification batches, ordered-gate batches, scope declarations
(the coder write preflight then fails with `SCOPE_NOT_DECLARED` until a fresh
declaration matches the corrected content). Underlying lane artifacts are never
deleted; the superseded join is pinned in the generation record and the events
trail.

## Reapproval (generation N+1)

From `invalidated`, the productive paths reopen in ladder order: verification
lanes re-settle → `run_pr_feedback_stage_a` re-records → the four ordered
gates re-record → `complete_pr_workflow` arms **generation N+1** with a fresh
identity and fresh evidence join. Evidence from generation N cannot satisfy
N+1 — including the content-drifts-away-and-back (ABA) case, because the old
receipts are gone from active state regardless of the digest returning to the
approved value.

## Cancellation without publication

`abort_pr_workflow` with `kind: "cancel-publication"`, `cancel_publication:
true`, and a non-empty `reason` is the terminal no-publish exit from
`{armed, push_in_flight, invalidated}`. It finalizes any in-flight attempt as
`cancelled`, discloses the observed remote head, and records
`pr_feedback_publication_cancelled` in the events trail. It never grants push
authority. Plain `recovery`/`force` aborts remain refused while an armed
window is live.

## Migration and rollback

A pre-#2108 armed record (no generation record) migrates conservatively on the
next gated interaction: every identity component must recompute and match
under the lock AND the backing receipts must be present — otherwise the record
persists as generation 1 `invalidated` with a `legacy-migration-*` reason.
**Never silently armed.** While `{armed, push_in_flight}` a derived legacy
mirror (`prFeedbackReadyToPublish`) is kept in sync so a rolled-back binary
keeps enforcing the armed window; the state schema is `.passthrough()`, so
older readers ignore (never delete) the new record.

## Operator diagnostics

- `pr_workflow_status` prints a `publication` section: generation, state,
  target, attempt outcomes, invalidation reason, and the state-appropriate
  next step.
- The full audit trail is `.swarm/events.jsonl`:
  `pr_feedback_publication_armed`, `pr_feedback_publication_migrated`,
  `pr_feedback_publication_invalidated`, `pr_feedback_push_attempt_started`,
  `pr_feedback_push_attempt_result`, `pr_feedback_published`,
  `pr_feedback_publication_cancelled`.
- Inspect and export with those two surfaces. **Never hand-edit the gate
  state file** — a manual edit is corruption, is treated fail-closed, and is
  not an authorization path.

### Deleted gate state (manual removal while a generation is live)

Deleting the gate state file by hand does not clear the authorization
requirement either: while the events trail still shows a **live** generation
(`armed` / `push_attempt_started` with no later terminal), every
publication-capable command (`git push …`) for that session fails closed with
a diagnostic naming the dangling generation. Other commands are unaffected,
and the audited exit is `abort_pr_workflow` with `kind: "cancel-publication"`,
`cancel_publication: true`, and a reason — it records the terminal
`cancelled_without_publication` event **even without gate state** (the events
store is the append-only authority the deletion cannot touch) and the hold
lifts. When the trail is empty or compacted past the event, the guard stays
silent — it never invents a dangling generation from absent evidence.

### Push exit statuses

The plugin host's `tool.execute.after` contract exposes
`{ title, output, metadata }` — no structured exit code. Attempt results
persist `exitStatus` when the host populates one on `metadata.exitCode`
(known-zero + verified remote head → `completed`; known-nonzero without the
remote at the approved head → `rejected`) and record the honest
`not-observed` otherwise. In every case **publication truth is the direct
remote-head verification in `complete_pr_workflow`**, never the exit code: a
nonzero exit with the remote verified at the approved commit is `completed`
with the exit disclosed in the diagnostic.
