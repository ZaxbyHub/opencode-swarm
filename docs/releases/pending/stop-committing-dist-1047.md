# Stop committing generated `dist/` (#1047)

## What changed

`dist/` is generated build output and is no longer tracked in git. Feature PRs no
longer carry regenerated bundle churn, which was the dominant source of cross-PR
conflicts and stale-`dist-check` failures (a version bump or another PR landing
invalidated every other PR's committed `dist/`).

- `.gitignore` now ignores the whole `dist/` directory (the previous partial ignores
  of `dist/build/`, `dist/quality/`, `dist/sbom/`, and `dist/tools/*.d.ts` are
  subsumed). The unrelated `dist-build-test/` entry is kept.
- All tracked `dist/` files were removed from the index (`git rm -r --cached dist`);
  the working copy is untouched and still built locally by `bun run build`.
- The `dist-check` CI job (which diffed committed `dist/` against a fresh build) is
  removed, and `dist-check` is dropped from `smoke`'s `needs`.
- The `unit` CI job now runs `bun run build` before its tests, because
  `tests/unit/build/*` load the built bundle and there is no longer a committed
  `dist/` to read. `package-check` and `smoke` already built first.
- `package-check` (`npm pack` + tarball completeness + temp-project install + Node
  import + CLI smoke) is now the authoritative proof that the published artifact is
  correct. Release/publish already builds `dist/` from source.
- Contributor/agent guidance updated across the `commit-pr`, `writing-tests`,
  `running-tests`, `ci-fix-monitor`, and `git-revert-safety` skills, `AGENTS.md`,
  `contributing.md`, and the `ci-fixer` agent: do not stage `dist/`; treat
  `package-check` failures as source/build/manifest issues, not generated-file drift.

## Why

`dist/` is the npm distribution artifact, and the project is installed only from npm
(not from a GitHub checkout), so committing the build output bought nothing but merge
pain. Building in CI and validating the packed artifact gives stronger guarantees
without the churn. This is PR 3 of the CI/release simplification plan, after package
validation (PR 1) and merge-queue support (#1046 / PR 2).

## Migration / follow-up

- Contributors/agents: stop committing `dist/`. Run `bun run build` locally when you
  need the bundle; run `bun run package:smoke` when you touch the package surface or
  build behavior.
- Admin (GitHub settings, not a file change): remove `dist-check` from the `main`
  branch-protection / merge-queue **required status checks** — the job no longer
  exists, so requiring it would hang the merge queue.

## Caveats

- `tests/unit/turbo/lean/runtime-conformance.test.ts` reads the built bundle but is
  not wired into any CI job; run `bun run build` before `bun test` locally or it will
  report the bundle as missing.
- GitHub source archives (tarballs of the git repo) no longer contain built output;
  this is intentional and acceptable because npm is the supported install channel.
