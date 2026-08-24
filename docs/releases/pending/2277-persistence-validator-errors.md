# All-at-once PR-review findings validation errors and a truthful persistence contract

## What changed

Persisting `/swarm pr-review` findings checkpoints now fails informatively instead of one record at a time (issue #2277).

- **Every violation, one rejection.** `write_pr_review_artifact` with `kind: "findings"` previously rejected on the first failing check of the first failing record, with no expected-vs-actual values — a real review run needed 9 sequential rejected writes to discover the full contract. The validator now collects every violation across every record and throws once, each line naming the finding id, the field, the expected value, and the actual value, sorted by finding id:
  ```
  BLOCKED: PR_REVIEW post_reviewer artifact invalid — 4 violation(s):
    C-0: status expected "DISPROVED", got "CONFIRMED"
    C-0: next_action expected "suppress_with_reason", got "report"
    C-1: next_action expected "route_to_critic", got "report"
    C-1: severity expected "HIGH", got "LOW"
  ```
- **Severity mismatch reporting made error-driven.** A severity that disagrees with the authoritative verdict is now reported with both values rather than surfacing as an unrelated single-check failure. (The transitional "omit the field when reviewer and critic disagree" rule this release originally shipped was superseded within the same release by the #2279 severity-dialect unification, which makes the critic authoritative for critic-routed records and requires `severity` on every record. See the #2279 entry for the contract that ships.)
- **Prerequisite and coverage refusals carry the remedy.** The trigger-evaluation prerequisite names the producing call (`write_pr_review_trigger_eval must complete first`); the candidate-inventory coverage check now lists `missing:`, `extra:`, and `duplicates:` ids in the same shape the dispatch-time ownership validator already uses; boundary-ordering refusals continue to name the missing prior checkpoint.
- **The bundled `swarm-pr-review` skill now documents the enforced contract** instead of leaving it discoverable only by rejection: the exact write order (base lanes settle → micro lanes settle → trigger-eval → `post_explorer` → `post_reviewer` → `post_critic`, each findings boundary requiring the prior checkpoint and the completed trigger evaluation), the full disposition matrix for `status`/`next_action` at every boundary, the `severity` semantics (superseded in this same release by #2279 — see its entry), the separate handoff schema, and the one-round-trip error-reporting behavior. The entry SKILL.md carries a compact summary and the full contract lives in `references/findings-persistence-contract.md` (progressive disclosure — the entry file stays at or below its issue #2131 ratchet baseline). The "durable recovery point … before Phase 6" claim was corrected: there is no durable findings checkpoint between explorer settlement and trigger-eval completion.
- No acceptance criteria changed: every predicate the validator enforced before it still enforces; only the error reporting and the documentation changed.

## Why

The discovered-by-failure contract made findings persistence a guess-and-retry loop that lower-tier orchestrators could not survive, and the skill's persistence-timing claim promised a checkpoint the controller structurally refuses until trigger evaluation completes. Validation predicates stay byte-identical — operators and orchestrators now learn the whole contract from one rejection and the skill states it up front.

Closes #2277.
