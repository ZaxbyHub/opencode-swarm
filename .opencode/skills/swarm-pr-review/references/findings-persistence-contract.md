# Findings Persistence Contract (Profile A)

The enforced write order, per-boundary disposition matrix, severity semantics,
error-reporting shape, and handoff schema for `write_pr_review_artifact`
(issue #2277). The entry SKILL.md carries the summary; this reference is the
full contract.

## Enforced write order and prerequisites

The controller admits findings checkpoints only in this exact sequence, each
step a hard prerequisite for the next:

1. Base lanes settle and micro lanes settle.
2. `write_pr_review_trigger_eval` completes — every findings boundary is
   refused until this artifact exists (the refusal names the producing call).
3. `boundary: "post_explorer"` checkpoint: records must exactly cover the
   discovered candidate inventory, every record `PENDING` with
   `next_action: "route_to_reviewer"`. The coverage refusal lists the
   `missing:`, `extra:`, and `duplicates:` ids.
4. `boundary: "post_reviewer"` checkpoint: requires the persisted
   `post_explorer` checkpoint and a settled reviewer phase.
5. `boundary: "post_critic"` checkpoint: requires the persisted
   `post_reviewer` checkpoint and a settled critic phase whenever any
   CONFIRMED CRITICAL/HIGH/MEDIUM verdict exists.

Writing a boundary after a later checkpoint already exists is also refused.
Every ordering refusal names the missing prerequisite boundary. There is no
durable findings checkpoint between explorer settlement and trigger-eval
completion; from trigger-eval completion onward, the persisted ledger is the
durable recovery point for context compaction.

## Disposition matrix

Records are validated against the authenticated reviewer/critic verdict rows,
never against caller claims.

| Reviewer verdict | expected `status` | expected `next_action` |
| --- | --- | --- |
| CONFIRMED CRITICAL/HIGH/MEDIUM | `CONFIRMED` | `route_to_critic` |
| CONFIRMED LOW/INFO | `CONFIRMED` | `report` |
| PRE_EXISTING | `PRE_EXISTING` | `report` |
| DISPROVED | `DISPROVED` | `suppress_with_reason` |
| UNVERIFIED | `PENDING` | `route_to_reviewer` |

At `post_critic`, records the reviewer did NOT route to the critic keep the
reviewer disposition above; critic-routed records follow the critic verdict:

| Critic verdict | expected `status` | expected `next_action` |
| --- | --- | --- |
| DISPROVED | `DISPROVED` | `suppress_with_reason` |
| UPHELD / DOWNGRADED (any non-DISPROVED) | `CONFIRMED` | `report` or `handoff_to_feedback` |

At `post_explorer` every record must be `PENDING` with
`next_action: "route_to_reviewer"`.

## Severity semantics

`severity` is optional at every boundary and is not validated on
`post_explorer` records. When present it must equal the authoritative severity
verbatim: the reviewer `final_severity` at `post_reviewer` (and for
non-critic-routed records at `post_critic`); for critic-routed records at
`post_critic` it must satisfy BOTH the reviewer and critic severities — so
when the critic downgrades (reviewer `MEDIUM`, critic `LOW`), the only
accepted record omits `severity` entirely until the severity-dialect
unification lands (#2279). Omitting the field is accepted at every boundary.

## Error reporting

An invalid records payload is rejected in ONE call: every violation across
every record is listed with the field, the expected value, and the actual
value, sorted by finding_id — for example:

```
BLOCKED: PR_REVIEW post_reviewer artifact invalid — 4 violation(s):
  C-0: status expected "DISPROVED", got "CONFIRMED"
  C-0: next_action expected "suppress_with_reason", got "report"
  C-1: next_action expected "route_to_critic", got "report"
  C-1: severity expected "HIGH", got "LOW"
```

A critic-downgraded record that carries a severity is told the only passing
value explicitly: `severity expected NONE (omit field; reviewer "MEDIUM" and
critic "LOW" disagree), got "LOW"`. Repair every listed violation and resubmit
in a single round trip; do not guess-and-retry one record at a time.

## Handoff artifact schema

The `kind: "handoff"` write is a different schema from findings records — no
`boundary` and no `records` keys; it takes
`handoff: {pr_url, finding_ids, summary, provenance}`, and `finding_ids` must
exactly equal the set of latest records whose status is `CONFIRMED` and whose
`next_action` is `handoff_to_feedback`.

## Resume/reload detail

Before continuing any compacted or resumed review, read the latest
`findings.jsonl` artifact and reconstruct the candidate/reviewer/critic ledger
from disk before dispatching more lanes. If the artifact is missing but a
review context says prior lanes ran, stop and surface the missing artifact as
a coverage gap instead of reclassifying from memory. Append new records rather
than overwriting history unless the artifact format explicitly tracks
revisions; the latest record for a `finding_id` wins during reload.
