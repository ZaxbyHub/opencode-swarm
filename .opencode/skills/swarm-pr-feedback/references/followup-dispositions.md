# Follow-up dispositions for unfixed items

This file is the routing rule for every closure-ledger item the PR does not fix. It is the swarm-pr-feedback form of `contributing.md` "Filing follow-up issues". Dispositions are planned in the closure ledger before the reviewer and critic closeout gate, which reviews them. They are executed during Publishing And Communication, after the push is verified.

Nothing is silently dropped.
- A `CONFIRMED` or `PARTIAL` item is fixed or disproved before Stage A. It never reaches this table.
- A `DISPROVED` item needs no disposition.
- Every `PRE_EXISTING`, `NEEDS_MORE_EVIDENCE`, or `NEEDS_USER_DECISION` item gets exactly one disposition in the closure ledger.

| Disposition | Use when | What you write |
|---|---|---|
| `ABSORB` | An open issue already covers it | A comment on that issue with the new evidence, plus the issue number in the ledger. No new issue. |
| `FILE` | It passes the necessity gate below and is Priority, or the user approved it | One collated follow-up issue (see Collation) |
| `RECORD` | It fails gate 1 or gate 2 of the necessity gate, or the user declined it | One row in the PR body's "Considered, not filed" table: item, reason, which gate test failed (or the quoted decline), re-evaluation trigger. This is a complete closure. |
| `ASK` | It needs a product or maintainer decision, it fails only gate 3, or it is an Improvement item awaiting approval | A question to the user. Nothing is filed until they answer. |

`ASK` takes precedence over fixing in the PR when the fix itself needs a product or compatibility decision. `ABSORB` takes precedence over `RECORD` when an open issue already covers the item.

## Necessity gate

`FILE` only when all four hold, or when the user approves filing a gate-3 or Improvement `ASK` proposal. Route failures as follows:
- **Failing gate 1 or gate 2** is `RECORD`, except that an unverified item whose claimed consequence is a wedge, fail-open gate, security, or data loss is `ASK` (or added to the standing investigation issue). If the user wants it pursued, it is investigated until it passes gate 1 and is then routed again, or it is added to the standing investigation issue; it is never filed as an `INFERENCE`.
- **Failing only gate 3** makes the item an Improvement-tier proposal. It stays `ASK` until the user approves it (`FILE`) or declines it (`RECORD`, quoting the decline).
- **Failing gate 4** is `ABSORB` when the item is already tracked. When it is untracked but fixable inside this PR's files and scope, it is `ASK`: propose the fix to the user. If they approve, it is fixed in this PR (ledger status becomes fixed) and the run restarts at Stage A. If they decline, it is `RECORD`, quoting the decline. The agent never records it alone, and its status is never relabelled `CONFIRMED`.
- **A wedge, fail-open gate, security, or data-loss consequence** satisfies gate 3 automatically.

1. **Verified.** An executed probe or an exact source trace at `path:line` proves it on the current head. Never file an `INFERENCE`. Route it by the gate 1 rule above instead, or add it to the repository's standing investigation issue if one exists.
2. **Consequential.** There is a concrete, reachable trigger with a correctness, safety/security, data-loss, or workflow-blocking (wedge) consequence.
   - Coverage gaps, docs, wording, and "could harden" items fail unless they hide a real defect.
   - Severity alone never qualifies.
3. **Material.** It sits on a hot path, invalidates a gate or contract, or blocks planned work. Low-interest debt in rarely touched code fails this gate. It is proposed to the user as an Improvement item and is never closed by the agent alone.
4. **Untracked and not fixable here.**
   - No open issue covers it; check before filing.
   - It cannot be fixed in this PR without leaving the PR's files or scope.

## Collation and budget

- All `FILE` items from one PR go into **one** issue titled `Follow-up from PR #<N>: <theme>`. Use the repository issue format, with at least one acceptance criterion per item, each bound to its own check.
- Before filing (OPTIONAL workstation tooling — `issue-lint` is NOT bundled with this skill; where an agent workstation has it installed): run `issue-lint <body-file> --repo <repo-root>` and fix every `mechanical-error` finding; surface `semantic-review-needed` findings to the plan critic. Where a PreToolUse `issue-lint-gate` hook is installed it enforces this at `gh issue create` time — the manual run stays the cheap path.
- Split into a second issue only when the items genuinely need separate PRs, for example different hotspot files that cannot share a review.
- A HIGH-severity item (fail-open gate, security, data loss) may stand alone.
- **Budget: at most two follow-up issues per PR.** A standalone HIGH item counts toward it.
  - If the gate passes more, stop and present the list to the user before filing.
  - Exception: Priority items over the budget are still filed during Publishing And Communication, after the push is verified, and the overflow is reported to the user. Only Improvement items wait for approval.

## Tiers

- **Priority.** A wedge, fail-open gate, security, or data-loss item. File it during Publishing And Communication, after the push is verified.
- **Improvement.** Passes the gate but is not Priority. Present these as a proposed list in the final response to the user, and file them only after the user approves.

## Findings about how the round was conducted

Findings about how this review or feedback round was conducted are `RECORD` unless they block a workflow. Examples are an incomplete ledger table, a missed disposition, or a formatting slip in a review artifact.

This never covers defects in any code, skill text, or gate, whether or not the PR changes it. Those are ordinary items:
- PR-introduced defects are fixed in this PR.
- A fail-open gate is Priority.

## Truthfulness

Before execution, ledger rows say `planned-FILE`, `planned-ABSORB`, or `planned-RECORD`. The published ledger drops the `planned-` prefix only after the artifact exists. A disposition stated in the published closure ledger or PR body must be true on the live artifact:
- the issue exists before `FILE` is written;
- the comment is posted before `ABSORB` is written;
- the row is in the PR body before `RECORD` is written.

## PR body table

Place the table inside `## Summary`, so the required `## Summary`, `## Invariant audit`, `## Test plan` order is kept.

```md
### Considered, not filed
| Item | Reason | Gate test failed | Re-evaluate when |
|---|---|---|---|
| FB-007 | Coverage gap for the macOS fallback label; no behavior defect | 2 (consequence) | the probe cleanup path is next edited |
```
