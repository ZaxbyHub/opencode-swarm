# Enable GitHub merge queue support (#1046)

## What changed

Required CI workflows now also trigger on `merge_group`, so GitHub's merge queue can
run them against the queued change on top of the latest `main` (and any earlier
queued PRs) before merging:

- `ci.yml` (`quality`, `unit`, `integration`, `dist-check`, `package-check`,
  `security`, `php-validation`, `rust-sandbox-runner`, `smoke`) now triggers on both
  `pull_request` and `merge_group: [checks_requested]`.
- `pr-standards.yml` (`check-title`, `pr-standards`) also triggers on `merge_group`,
  but every step is guarded with `if: github.event_name == 'pull_request'`. A merge
  group has no PR title/body to validate, so those steps are skipped and the jobs
  report success — the PR already satisfied them before being queued. This keeps the
  required checks from getting stuck in the queue.

Guidance updated so agents stop rebasing solely for freshness:

- `.claude/skills/commit-pr/SKILL.md` gained a "Merge queue (current-base
  validation)" note in Step 7.
- `.claude/skills/swarm-pr-feedback/SKILL.md` notes that a green PR should be queued
  rather than force-pushed merely because `main` advanced.

## Why

When several PRs are ready at once, merging one makes the rest stale, forcing a
manual rebase/rebuild/re-run loop. The merge queue performs final current-base
validation automatically. This is PR 2 of the CI/release simplification plan and a
precondition for removing committed `dist/` (#1047).

## Migration / follow-up

No code/runtime migration. The workflow triggers are dormant until a repo admin
enables the merge queue. To finish enabling it, an admin must update the `main`
branch protection / ruleset:

- Require a pull request before merging.
- Require status checks (prefer GitHub Actions as the check source). Use the **exact
  check names GitHub emits** — matrix jobs report one check per matrix leg, not an
  aggregate, so require each leg by name or the queue will wait forever for a check
  that never reports:
  - `quality`, `integration`, `dist-check`, `package-check`, `security`,
    `php-validation`, `rust-sandbox-runner`, `check-title`, `pr-standards`
  - `unit (ubuntu-latest)`, `unit (macos-latest)`, `unit (windows-latest)`
  - `smoke (ubuntu-latest)`, `smoke (macos-latest)`, `smoke (windows-latest)`
- **Require merge queue.**
- Keep linear history / conversation resolution if desired.
- Do not require manual branch freshness — let the merge queue do final current-base
  validation.

## Caveats

- Until the queue is enabled, these `merge_group` triggers never fire, so PR behavior
  is unchanged.
- `dist-check` still runs in the queue for now; it is removed by #1047 (PR 3).
