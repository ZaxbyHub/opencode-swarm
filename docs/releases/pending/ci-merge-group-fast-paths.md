# CI: tighter release fast path and a docs-only fast path in the merge queue

## What

Two changes to how `ci.yml` treats merge-queue groups. A merge-queue group is cumulative: it carries every queued PR ahead of its head, and GitHub merges all of them when the group passes.

- **Release fast path now needs the release to be alone.** A group headed by a release-please merge used to skip every test job. If code PRs were queued ahead of the release in the same group, those PRs could merge on that skipped run. The release fast path now applies only when the group contains exactly one merge (the release itself, or its squash commit). A release batched with anything else runs the full suite. If the queue base cannot be read, the full suite runs.
- **The group boundary is the base branch, not the event's `base_sha`.** For an entry deeper in the queue, GitHub's `merge_group.base_sha` is the previous entry's temporary queue commit, which already contains every PR ahead of it. Both fast paths therefore measure the group from the merge-base of the group head and `origin/<base branch>`, so every queued PR that has not yet merged is counted.
- **New docs-only fast path.** When a group's entire change set (every queued PR it batches) touches nothing outside `docs/releases/`, the coverage, smoke, integration, memory-recall, package-check, security, PHP and Rust jobs report success without running. `quality` and the full three-OS unit matrix still run, and `unit-passed` still verifies every unit report without reading any detector output. This is aimed at the per-release `chore(release): materialize … fragment history` PRs, which change only `docs/releases/` but were rebuilding the whole matrix every time they passed through the queue.

The docs-only check fails closed: any git error, an empty change set, a path outside `docs/releases/` (including lookalikes such as `docs/releases-extra/` or `docs/releases.md`), or a rename into or out of that directory leaves it off.

## Why

The materialize PRs were among the largest consumers of the shared GitHub-hosted runner pool. Measured on two merge-queue CI runs, a full run cost about 420 runner-minutes, and the jobs the docs-only path now skips accounted for about 104 of them (roughly 25%). The release ride-along was a gap rather than an observed incident: a search of every merge-queue run GitHub still retains (since 2026-09-05) found six PRs batched with a release, and each had its own successful merge-queue test run before merging.

## Verification

- `tests/unit/scripts/ci/ci-merge-group-fast-paths.test.ts` extracts the real `detect-release` script from `ci.yml` and runs it with `bash -eo pipefail` against git fixture repositories shaped like merge-queue groups: a lone release (merge and squash) skips; a release batched behind a code PR does not, even when the event's `base_sha` points at the previous queue entry; PRs already merged to the base branch are not counted; a missing or malformed base branch ref turns both fast paths off; docs-only, mixed, lookalike-prefix, rename-out, rename-in, empty and git-failure groups each get the expected answer. Every guard was falsified by mutation, including trusting the event `base_sha`, falling back to the head's parent when the merge-base is unknown, and ignoring the base branch name.
- `tests/unit/scripts/ci/ci-merge-group-fast-paths-wiring.test.ts` pins which jobs skip and which never do, that the unit matrix stays three-OS, and that `unit-passed` reads no detector output.
- `docs/ci/required-check-evidence.json` carries the refreshed `ci.yml` hash; no required-check name changed.
