# Fragment-gate hardening: fail-closed quality gate, NUL-safe cleanup transport, bounded check-title, dispatch guards

## What

Collated delivery for the fragment-gate follow-up family from the #3276/#3297
review lineage:

- **#3283** — the pending-fragment quality gate no longer passes when git
  cannot answer. Merge-base resolution failures, changed/added diff failures,
  spawned-git timeouts, unusable repository roots (empty or malformed `.git`
  markers), and base-branch probe failures now fail the required `quality`
  context with an infrastructure-labeled message instead of "gate
  inconclusive, passing" — and an added-diff failure is no longer reported as
  an author-facing fragment VIOLATION. The documented non-repository /
  no-base local pass is preserved through positive marker-absence and
  positive ref-absence checks (locale-independent: git stderr is never
  consulted). `FRAGMENT_CHECK_ENFORCE=0` still soft-warns, now explicitly
  including infrastructure failures, for local runs.
- **#3299** — the `cleanup-release-fragments` arm in
  `release-and-publish.yml` now derives its changed-path list NUL-end-to-end
  (`git status --porcelain=v1 -z` through a jq reducer into the classifier's
  `--paths-format jsonl --changed-file` framing) instead of the legacy
  newline-delimited pipe that C-quoted and split adversarial paths before the
  classifier could see them. The snapshot stays before the cleanup commit,
  and the temp file is trap-cleaned.
- **#3300** — the `check-title` job in `pr-standards.yml` declares
  `timeout-minutes: 10`, closing the last unbounded job in that workflow.
- **#3307** — both dispatched run blocks that interpolate the
  `pr_number` input into `gh api` paths now refuse non-decimal values before
  any call; a concurrency group cancels superseded `pull_request` runs only
  (merge-group and dispatch runs get run-unique groups and are never
  cancelled, keeping merge-queue checks safe); the non-integer
  `changed_files` guard from #3297 and the least-privilege top-level
  permissions posture are pinned by tests that previously did not exist.

## Why

A required check that maps "cannot determine" to "pass" silently approves
user-visible PRs without release notes whenever git hiccups in CI, and a
lossy list transport can flip a required fragment verdict on paths the
classifier never faithfully saw. Both are fail-open shapes in the gate that
owns the repo's release-notes mandate.

## Verification

`tests/unit/scripts/check-pending-fragment-git.test.ts` (13 tests: real-git
failure legs plus `_internals.spawnSync` seam legs for deterministic timeout
and per-call failure shapes), `fragment-gate-cleanup-transport-3299.test.ts`
(byte-faithful reducer over synthetic porcelain `-z` records including quote-,
newline-, rename- and copy-bearing paths, plus full-pipeline composition on a
real scratch repository), `pr-standards-dispatch-guard-3307.test.ts`
(executed extracted run blocks with a call-recording `gh` stub, both
surfaces), `workflow-hardening.test.ts` (check-title bound, verbatim
concurrency expressions, permissions pin), and
`fragment-gate-workflow-contract.test.ts` (non-integer `changed_files` pin;
cleanup-arm mapping tests kept green).
