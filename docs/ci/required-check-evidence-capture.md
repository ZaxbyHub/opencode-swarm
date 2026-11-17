# Required-check evidence capture runbook

`docs/ci/required-check-evidence.json` is a captured artifact whose validator
(`scripts/check-required-check-contract.ts`, `MAX_EVIDENCE_AGE_MS` = 30 days)
reddens the required `unit-passed` check on **every open PR** once
`capturedAt` ages past 30 days. Two crossings (2026-10-12 and 2026-11-11)
each blocked the repository's merge queue for hours until someone re-attested
the artifact by hand. This runbook is the standing operational answer (#3653).

## Command

```bash
# Offline sanity check of the committed artifact (no network, no writes).
# Scope: the validator's OFFLINE contract (schema shape, hex digests, contexts,
# endpoints, run receipts, cross-field consistency) with now = capturedAt + 1ms
# so staleness cannot mask malformation. It does NOT detect local workflow
# drift — that check (WORKFLOW_CHANGED_AFTER_CAPTURE) needs the local tree and
# runs in the full capture modes below, where divergence refuses the capture.
bun ./scripts/capture-required-check-evidence.ts --self-test

# Full re-capture from the live GitHub API, preview only (no writes):
bun ./scripts/capture-required-check-evidence.ts --dry-run

# Full re-capture, writing the committed artifact (the real refresh):
bun ./scripts/capture-required-check-evidence.ts

# Full re-capture to a reviewable temp file first:
bun ./scripts/capture-required-check-evidence.ts --output /path/to/review.json
```

The script refuses (exit non-zero, writes nothing) when any captured fact
cannot be established: the ruleset does not target the contract branch (its
ref-name conditions AND the branch-rules endpoint are both checked), the
branch is unprotected, the ruleset lacks a contract-required context, no
recent successful merge-group head carries every required context as a
completed successful check run, a workflow blob diverges from the local
working copy, or the generated artifact fails the validator's own offline
evaluation. A refusal is a signal to investigate, never to bypass.

After writing the committed artifact, validate the fresh capture end-to-end
with the real validator:

```bash
bun ./scripts/check-required-check-contract.ts
```

## Owner

The required-check-contract workstream (the #2677 wiring owners / repository
maintainers). Any contributor can run the capture; the owner surface is who
notices the wall approaching and lands the refresh.

## Cadence

Re-capture **at least every three weeks** — comfortably ahead of each 30-day
`MAX_EVIDENCE_AGE_MS` wall — and immediately after any change to
`scripts/required-check-contract.json` (required contexts, workflow surface)
or to `.github/workflows/*` that renames or removes a required check. A
cheap reminder hook: the validator's `EVIDENCE_STALE` finding itself is the
backstop; the cadence exists so the backstop never fires on innocent PRs.

## What the capture records

For the exact per-field contract, see the `RequiredCheckEvidence` interface in
`scripts/check-required-check-contract.ts` — the capture script reuses the
validator's own evaluation and workflow-surface parser, so the generated
artifact can never drift from what the validator accepts.
