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
| no critic verdict for a critic-routed record | (defensive) | (defensive) |

The "no critic verdict" row is defensive: through the controller the critic
phase must already be settled over every critic-routed item before the
`post_critic` boundary is admitted, so a critic-routed record without a critic
verdict indicates an invariant break, not a caller mistake — the rejection
reports `no authoritative critic verdict (absent from the settled critic map)`
(and any reviewer-severity mismatch alongside it).

At `post_explorer` every record must be `PENDING` with
`next_action: "route_to_reviewer"`.

## Severity semantics

`severity` is REQUIRED on every findings record, at every boundary. Omitting it
is a violation, not a shortcut — the rejection names the value you owed, e.g.
`severity expected "MEDIUM", got (omitted)` (issue #2279).

The vocabulary is the VERDICT dialect — `INFO | LOW | MEDIUM | HIGH | CRITICAL |
NONE` — because a findings record is a projection of an authenticated
`[REVIEWED]`/`[CRITIC]` row. `NONE` is a first-class value here: a `DISPROVED`
critic verdict is required to carry it, and a CONFIRMED-but-cosmetic reviewer
verdict legitimately does. (This is a WIDER set than the `[CANDIDATE]` row
severities, which exclude `NONE` — a discovered candidate asserting "no severity"
is a contradiction.)

Exactly one authority applies per record; there is never a value that must
satisfy two:

| Boundary | Routing | `severity` must equal |
| --- | --- | --- |
| `post_explorer` | has a `[CANDIDATE]` row | the severity that row declared (never `NONE`) |
| `post_explorer` | `CLEAN-REVIEW` with no row | `NONE` |
| `post_reviewer` | any | the reviewer `final_severity` |
| `post_critic` | not critic-routed | the reviewer `final_severity` |
| `post_critic` | critic-routed | the **critic** `final_severity` — the final word |

A record is critic-routed when the reviewer classification is `CONFIRMED` and the
reviewer severity is `CRITICAL`, `HIGH`, or `MEDIUM`.

Because the critic is authoritative for critic-routed records, a **downgrade is
encodable verbatim**: reviewer `MEDIUM` + critic `LOW` persists as
`severity: "LOW"` and validates. The former rule — omit the field when the two
authorities disagree — is gone; it disabled the comparison against both
authorities and is now itself rejected.

At `post_explorer` the authority is the `[CANDIDATE]` row the record projects:
the severity must equal what that row declared, compared exactly (issue #2320).
Because candidate rows validate against the candidate vocabulary, `NONE` can
never match one.

The one exception is the mechanically derived `CLEAN-REVIEW` sentinel, emitted
as the whole inventory when discovery found nothing at all. It has no
`[CANDIDATE]` row, so its severity is `NONE` — the same value its mandated
reviewer row carries — and a zero-finding review never has to invent a severity
and then change it.

`CLEAN-REVIEW` is **not a reserved id**: `candidate_id` is free text, so a lane
may name a real finding that. The rule is therefore keyed on the authority, not
the name — whenever a `[CANDIDATE]` row exists for the id, that row wins and its
severity is compared exactly. The sentinel rule applies only when no row exists.

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

A critic-downgraded record is compared against the critic alone, so carrying the
stale reviewer value is reported plainly: `severity expected "LOW", got "MEDIUM"`.
An omitted severity is reported the same way: `severity expected "LOW", got
(omitted)`. Repair every listed violation and resubmit in a single round trip; do
not guess-and-retry one record at a time.

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
