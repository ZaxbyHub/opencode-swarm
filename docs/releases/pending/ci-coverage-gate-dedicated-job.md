# CI: Move coverage gate to a dedicated job to stop double-running the unit suite

## What changed

The merge-queue coverage gate no longer runs as an extra step inside the `unit (ubuntu-latest, 1)` shard. It now runs in its own `coverage` job.

- **No more double-run.** Previously, on every non-release `merge_group` run, ubuntu shard 1 executed the entire unit suite twice: once as its sharded test run, then again as a full-suite `bun --smol test --coverage` for the gate. That cell measured ~30–35 min against the `unit` job's 40-min timeout and intermittently timed out, cancelling the run and re-blocking the merge queue (e.g. PR #1573 hit the 40-min wall). The full-suite coverage measurement now lives in the dedicated `coverage` job with its own 45-min timeout, and the `unit` ubuntu-1 cell drops to the ~3–6 min of its sibling shards. The 45-min cap clears the ~34-min worst-observed standalone run (coverage measurement alone has hit 30.6 min) with ~11 min of slow-runner/cache-miss headroom, while `quality` (~5–10 min) + 45 = 55 stays under the merge queue's 60-min end-to-end window.
- **Gate semantics unchanged.** The threshold (41.48% line coverage), the parse of the `All files` row, the pass/fail behavior, and the `coverage-report` artifact upload are relocated verbatim. The `coverage` job runs only on `merge_group` (skipped + reported success on `pull_request`, same pattern as `integration`/`smoke`) and is skipped for release-please branches.
- **Required check (added post-merge).** Nothing in the workflow `needs: coverage`, so the gate's blocking power comes solely from the branch ruleset's required-status-check list. `coverage` must be added there *after* this merges to `main` (see Migration steps) — adding it earlier would block every other open PR, whose merge group built from `main` would not yet produce a `coverage` check.
- **Dropped dead instrumentation.** The sharded `Run unit tests` step previously passed `--coverage` per file; that per-file coverage was overwritten on each invocation and never aggregated or read. It is removed, which lightens every unit cell on every OS.

## Why

The double-run was a latent flake: a normal PR's `merge_group` run could exceed the `unit` job's 40-min timeout purely because of the in-job coverage measurement, cancelling the run and blocking the queue. Isolating the inherently long (~26–31 min) full-suite coverage run in its own job removes that structural double-run and sizes the job's timeout above the observed worst case with margin, so a normal merge-queue run is very unlikely to hit a job timeout because of the coverage gate — while keeping the sharded unit cells fast. (This is not an absolute guarantee against a pathologically slow runner; see the timeout note under Known caveats.)

## Migration steps

None for local workflows. **Post-merge:** a repository maintainer must add `coverage` to the `main` branch ruleset's required status checks so the gate keeps blocking the merge queue. This must happen *after* this PR merges (so `main`'s CI defines the `coverage` job) — not before, or other open PRs would be blocked on a check their merge groups cannot produce.

## Known caveats

- This change only affects `merge_group` events. PR CI is ubuntu-only and skips the coverage gate, so the new `coverage` job's real behavior — and its effect on queue timing — can only be fully validated at merge-queue time, after merge. This mirrors the validation limitation noted for PR #1570 and PR #1578.
- The 45-min timeout on `coverage` is sized to the ~29–34 min standalone run (setup/build + full-suite coverage; it does not run the sharded suite, and the coverage measurement alone has been observed at 30.6 min) with ~11 min of headroom, and kept under the merge queue's 60-min end-to-end window after `quality` (~10 + 45 = 55). The worst-observed run leaves real but finite headroom: a runner substantially slower than anything observed could still approach the cap. If the suite grows substantially, that timeout (not the `unit` job's) is the value to revisit.
