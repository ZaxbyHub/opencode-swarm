# CI: Migrate pinned GitHub Actions to Node.js 24 (Issue #1074)

## What changed

- **Repinned all Node.js 20 GitHub Actions to Node.js 24 release commits**, ahead of the
  GitHub runner cutoff (Node.js 24 forced from 2026-06-02; Node.js 20 support ends
  2026-09-16). Each new pin was verified against the GitHub API to resolve to the stated
  tag and a `runs.using: node24` runtime.
  - `actions/checkout` → `v5.0.1` (`93cb6efe…`)
  - `oven-sh/setup-bun` → `v2.2.0` (`0c5077e5…`)
  - `actions/cache` → `v5.0.5` (`27d5ce7f…`)
  - `actions/setup-node` → `v5.0.0` (`a0853c24…`)
  - `googleapis/release-please-action` → `v5.0.0` (`45996ed1…`)
  - `actions/github-script` → `v8` (`ed597411…`)
- Updated the `actions/checkout` SHA-pinning examples in `contributing.md` and
  `.opencode/contributing/SKILL.md` to match.

## Why

Steps pinned to Node.js 20 action builds emit deprecation annotations now and will fail
after the cutoff. `checkout`, `cache`, and `setup-node` have no Node.js 24 build in their
prior major, so a major version bump was required; the lowest Node.js 24 major was chosen
to minimize behavioral change. All runners are GitHub-hosted `*-latest`, satisfying the
runner ≥ v2.327.1 minimum that `checkout@v5`/`cache@v5` require.

## Migration

No migration required. `setup-node@v5`'s opt-in package-manager auto-cache does not engage
(no `packageManager` field in `package.json`; only `bun.lock` present; no `cache:` inputs).

## Breaking changes

None for this repository. The upstream major bumps (`checkout`, `cache`, `setup-node`,
`release-please-action`, `github-script`) carry no input/output changes that this repo's
workflows depend on.

## Known caveats

- `shivammathur/setup-php` was already on Node.js 24 (pinned to `2.37.0`), so it was left
  unchanged despite being listed in the issue.
- `concurrency.cancel-in-progress: false` in `ci.yml` is preserved.
