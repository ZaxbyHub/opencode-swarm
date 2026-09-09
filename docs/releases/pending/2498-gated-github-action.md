# Gated GitHub Action (issue #2498, source #1224 phase 2)

Publishes the gated implementation pipeline Action wrapping the advisory CI surface from #2497:

- `.github/workflows/swarm-implement.yml` — issue-label (`swarm:implement`) and `workflow_dispatch` triggers, least-privilege permissions (`contents`/`issues`/`pull-requests` only), per-issue concurrency group with `cancel-in-progress`, job-level `timeout-minutes`, fork-safe posture (no `pull_request`/`pull_request_target`; the label gate is the only write-path entry), and a `!cancelled()` reporting step that surfaces Full-Auto oversight pauses.
- `scripts/swarm-implement-pipeline.sh` — the runner driver: issue ref as the first positional argument, pure `branch <N>` derivation (`swarm/implement-<N>`), host-driven phases with a bounded transient-retry budget, `swarm ci` evaluation with exit-code-true propagation, `OVERSIGHT_PAUSE:` + dedicated exit code 10 for oversight denials (never retried past), violations surfaced to the run summary with `gh pr create` gated on the evaluation exit, and a `SWARM_PIPELINE_DRY_RUN=1` seam for offline evidence-bundle runs.
- Committed contract tests: fork secret-absence/security shape (`tests/security/swarm-implement-workflow-fork-safety.test.ts`) and driver behavior including idempotency, oversight pause, and the failed-gate publish gate (`tests/unit/scripts/swarm-implement-pipeline.test.ts`).
- `docs/ci.md` gains the Action usage section; README gains the Action surface row.

Known follow-up (out of scope here): the ci-workflow-security scanner's scope is hardcoded to `ci.yml`; widening it to scan all workflow files is a separate hardening change.
