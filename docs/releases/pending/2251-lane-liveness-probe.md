# PR workflow lanes: a live session past the staleness horizon is no longer discarded

Issue #2242 made a stuck PR-workflow lane stop wedging `abort_pr_workflow`, the
PR_REVIEW→PR_FEEDBACK transition, and `complete_pr_workflow`: a lane whose
delegation record had not advanced its `updatedAt` for 30 minutes was **presumed
stale** and settled with disclosure instead of blocking forever.

That decision was made on **age alone**, and nothing heartbeats `updatedAt` — it
advances at record creation and at the single `pending`→`running` transition,
never during the work itself. So a lane that was genuinely running, just slowly,
was indistinguishable from one whose process had died. It went terminal `stale`,
the collector skips terminal records, and its transcript was never fetched. Its
work had to be re-dispatched from scratch.

## What changed

Before settling anything, the gate now runs a **liveness probe** across the stale
candidates. A lane whose session the host affirmatively reports as `busy` or
`retry` is **retained**: it keeps blocking, its delegation record stays
`pending`/`running`, and its output stays collectable with
`collect_lane_results`.

The probe is **fail-open by design**. For its *error* and *no-data* cases it is
the exact inverse of the collector's readiness check (`isLaneReadyForCollection`
in `src/tools/dispatch-lanes.ts`), which returns `false` on a truthy `error`, on
missing `data`, and on a throw — because a lane it cannot verify must not be
collected. The two agree rather than invert on one case: a host that exposes no
`session.status` function at all. There the collector returns `true` and this
probe reports `probe-unavailable`, so both fall through to proceeding — an
unprobeable host must not wedge either side.

Here the default outcome is "settle", so the reachability floor #2242 established
is untouched. Only a probe that *ran* and affirmatively named a live session may
contradict staleness:

| Outcome | Result | `probe_status` |
| --- | --- | --- |
| No session handle, or the host exposes no `status` | settles | `probe-unavailable` |
| The status call threw | settles | `probe-error` |
| The status call exceeded the 5-second probe deadline | settles | `probe-timeout` |
| The response carried a truthy `error` | settles | `probe-error` |
| The response carried no `data` | settles | `probe-no-data` |
| No entry for that lane's session | that lane settles | (probe ran) |
| Entry present, type is not `busy`/`retry` | that lane settles | (probe ran) |
| Entry present, type is `busy` or `retry` | **retained** | (probe ran) |

The live-status set is an **allowlist**, not `type !== 'idle'`, with a
compile-time exhaustiveness assert: if the SDK's `SessionStatus` union ever gains
a fourth member, the build fails rather than silently letting the new member
start contradicting staleness.

Below the horizon the probe is not consulted at all — a lane with a fresh
`updatedAt` already blocks, so there is no host round-trip on the common path.

## Where the verdict is disclosed

- `complete_pr_workflow` response: `probe_retained_lanes`, `probe_status`
- `abort_pr_workflow` response: `probe_status`
- `.swarm/events.jsonl` `pr_workflow_lanes_presumed_stale`: `probedAliveLanes`,
  `probeStatus`
- `.swarm/events.jsonl` `pr_workflow_aborted`: `probeRetainedLanes`,
  `probeStatus`, `probeRetentionOverrideDisclosure`,
  `probeRetentionOverrideLanes`
- `abortPrWorkflow`'s returned `openLanes`, and `openLanes` on the
  `pr_workflow_aborted` event, now count **fresh open lanes plus probe-retained
  lanes**. See *Semantics change: `openLanes`* below.
- The settled-lane disclosure keeps its existing prefix and **appends** either
  `liveness probe found no live session` or `settled despite liveness probe
  failure (<reason>)`, so a lane settled *after* re-verification is never
  confused with one settled *without* it.
- All three BLOCKED messages name the retained lanes, so a blocked caller can
  tell "a lane is genuinely young" from "a lane past the horizon answered".

## Retention has exactly one override, and it is human-only

Age alone used to guarantee an eventual exit. Retention removes that guarantee: a
session that never goes idle would make the workflow permanently unexitable
through every tool, recoverable only by hand-editing `.swarm/delegations.jsonl`.

`/swarm abort-pr-workflow` — the human-only `force` path, not agent-callable —
now clears the gate when probe-retained lanes are the **only** thing still
blocking, and prints a `WARNING:` naming exactly which lanes it overrode. Those
sessions are **not** stopped and their output is **not** collected; the operator
is told precisely that.

On that override path — and **only** there — each overridden lane's delegation
record is also finalized to the existing terminal `stale` status, immediately
after the gate clears. Without it the override traded an unexitable gate for an *un-restartable
session*: `countOpenPrWorkflowLanes` in `prepare_pr_workflow_checkout` counts
every `pending`/`running` `swarm-pr-*` record of the session with no age filter
and no horizon, and the overridden lane never terminates — that is the hypothesis
the override exists for — so the next checkout preparation was refused
permanently, recoverable only by hand-editing the ledger.

The finalization is deliberately narrow:

- **Override path only.** On the ordinary retention path a retained record stays
  `pending` and its output stays collectable. That distinction is the whole
  design; only an explicit human override abandons a live lane.
- **Exactly the overridden `correlationId`s**, via `includeCorrelationIds` (see
  Durability). Never a directory-wide pass, which would finalize other sessions'
  records and retryable `ingestion_error` records.
- **It cannot force a terminal record.** The sweep's status and age filters still
  apply on top of the id narrowing, so a lane that raced to `completed` between
  the settlement read and the override keeps its collected result.
- **Ordered after the CAS-guarded clear.** The finalization is irreversible (a
  `stale` record is never collected again) while the clear can legitimately lose
  its compare-and-swap and throw, so the irreversible half is conditional on the
  reversible one: a lost CAS abandons nothing and the operator's retry is a
  clean, complete override. The residual exposure is a process crash in the
  window between the two writes, which leaves the records `pending` — the session
  stays un-restartable until they settle, but nothing is destroyed and the output
  is still collectable.
- **Best-effort, but disclosed.** Reachability never depends on a durability
  write, so the abort stands even if the finalization fails — and the disclosure
  then names the exact `correlationId`s that will keep refusing checkout
  preparation *instead of* claiming the session is restartable. That read-back
  covers **every** still-open `swarm-pr-*` record of the session, not just the
  overridden ones: the ordinary settlement sweep swallows a store-lock timeout
  and returns 0, so a lane this abort reported as settled can still be `pending`
  on disk and refuse the next checkout preparation exactly like an unfinalized
  retained lane.
- **Every clause of the disclosure is a positive observation.** It states three
  *independent* facts on three independent conditions, because a mixed batch can
  make any one of them true while another is false:
  1. `Their delegation records were finalized (correlationId: ...)` — named from
     the overridden records actually **observed** terminal `stale`, so their
     output really is no longer collectable.
  2. `N of the overridden lane(s) were NOT finalized: the sweep left those
     records intact at the status they had already reached (...)` — the race the
     constraint above spares, named with each lane's **observed** status. The
     clause says *left intact*, never *collectable*: `error` and
     `ingestion_error` records surface through `collect_lane_results` as
     `failed` with no result text and `ingesting` is filtered out until it
     settles, so promising output would be the mirror of the defect below.
  3. `A new PR workflow can now be started for this session` — decided by every
     still-open record of the session, not by the overridden ids.

  Clause 1 used to be decided by a targeted lane's *absence* from the still-open
  set. A lane that raced to `completed` is absent for the opposite reason a
  finalized one is, so the override told the operator its result was gone while
  it sat on disk, recoverable. Nothing was ever destroyed by that — the record
  was spared either way — but "stop looking for output you can still collect" is
  the same class of silent discard this whole issue removes, so the clause now
  asserts abandonment only for records it saw go terminal.
- **The audit record states a decision, not an outcome.** `pr_workflow_aborted`
  is appended *before* the clear (issue #2242 FB-008), so it carries
  `probeRetentionOverrideLanes` — the `correlationId`s the override targets. An
  auditor reconciles that against `.swarm/delegations.jsonl`, which is the
  authority on which rows actually went terminal. When the clear fails, the
  existing `pr_workflow_abort_not_completed` retraction now states positively
  that no delegation record was finalized.

A lane with a fresh `updatedAt` is never overridden, by `force` or anything else.
An explicit human override of a *presumption* is not the same as softening a
check that can run and reports "still progressing".

## Durability

`sweepStaleDelegations` gained an optional `excludeCorrelationIds`. The sweep is
directory-wide and filters on status and age only, and a probe-retained lane is
`pending`/`running` and past the horizon by construction — so without the
exclusion the sweep would durably flip the very lane the probe had just spared,
and the spare would have lasted exactly one call.

It also gained the inverse, `includeCorrelationIds`, which narrows the sweep to
exactly the named records. That is what lets the force override finalize its own
overridden lanes without a directory-wide pass, and it deliberately composes with
(rather than replaces) the status and age filters, so narrowing to a record never
forces it terminal.

Omitting both options preserves the historical scope for the existing
lazy-maintenance caller.

## Semantics change: `openLanes`

`openLanes` used to mean "lanes still blocking because they are FRESH" — on a
successful abort it was therefore always `0`, because anything past the horizon
had settled. It now means **fresh open lanes plus probe-retained lanes**, so a
successful `force` abort that overrode one retained lane reports `openLanes: 1`.
This is the honest reading: a retained lane *is* still open, its record is
`pending` at the moment the count is taken, and reporting `0` would have hidden
the very lanes the override abandoned.

The change is visible in two places:

- the `openLanes` field of `abortPrWorkflow`'s return value, and
- the `openLanes` field of the `pr_workflow_aborted` audit event, where a
  successful force abort may now be recorded with a non-zero value.

Nothing in the codebase reads either as a value — `src/tools/abort-pr-workflow.ts`
passes it straight through to `open_lanes` on the tool response, and the only
other mention (`src/hooks/pr-workflow-response-gate.ts`) is a comment describing
the event's JSON-line format. So this is a **documentation** change for anyone
parsing `.swarm/events.jsonl`, not a code migration. Any external check of the
form "a successful abort has `openLanes === 0`" must be re-read as "a successful
abort has no *fresh* lanes"; use `probeRetainedLanes` to tell a retained lane
from a fresh one.

The count is taken *before* the override's finalization runs, so a
`pr_workflow_aborted` record with `openLanes: 1` and a
`probeRetentionOverrideDisclosure` describes a lane whose ledger row is expected
to be terminal immediately afterwards.

## Breaking changes

None at the API or configuration level: the probe adds no configuration and no
new state file, no signature changed, and with no SDK client bound — the case in
every existing test fixture and in any host that exposes no `session.status` —
behaviour is byte-identical to #2242's age-only settlement, plus the appended
disclosure. The one behavioural difference worth reading before upgrading is the
`openLanes` semantics change documented directly above, which affects only
consumers that parse the audit event.

Found while resolving issue #2251.
