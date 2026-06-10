# Contributing to OpenCode Swarm

> **This file is the authoritative reference for any automated agent (LLM, Copilot, CI bot) or human contributor submitting a PR to this repository. Read it fully before making any commit.**
>
> **Required reading before code changes:**
> 1. [`AGENTS.md`](./AGENTS.md) — root engineering contract (12 non-negotiable invariants).
> 2. [`docs/engineering-invariants.md`](./docs/engineering-invariants.md) — long-form rationale and historical failure map (skim, deep-dive on touched invariants).
> 3. This file (`contributing.md`) — release-please workflow and CI pipeline.
> 4. The `writing-tests` skill — for any test changes (`.opencode/skills/writing-tests/SKILL.md` or `.claude/skills/writing-tests/SKILL.md`).
> 5. The `commit-pr` skill — before committing or opening a PR (`.claude/skills/commit-pr/SKILL.md`). It enforces the invariant audit gate.
>
> When this file conflicts with `AGENTS.md`, `AGENTS.md` wins.

---

## End-to-end PR workflow

This is the complete sequence for getting code from your branch to an npm release. Every step matters — skipping one breaks the pipeline downstream.

### 1. Set up your branch

```bash
git checkout main && git pull origin main
git checkout -b <type>/<short-description>   # e.g. feat/add-retry-backoff
bun install --frozen-lockfile
```

> **`dist/` is generated, not committed** (#1047). The plugin entry (`package.json#main`
> → `dist/index.js`) only exists after a build. `bun install` builds it automatically via
> the `prepare` script, so a fresh clone is runnable. If you load the plugin from this
> checkout and pull source changes **without** re-running `bun install`, refresh the bundle
> with `bun run build` (or `bun run dev`, which builds then launches OpenCode) before the
> plugin will load. The build is cross-platform (bun + tsc, no OS-specific steps).

### 2. Make your changes

- Write code, tests, and docs
- Follow the commit message format below for every commit
- Follow the test rules in `.opencode/skills/writing-tests/SKILL.md` (bun:test only, mock isolation, cross-platform paths)
- If you change behavior guarded by existing tests, **update those tests in the same PR**

### 3. Write a pending release-note fragment

**Every PR with a user-visible change MUST add a unique fragment at `docs/releases/pending/<descriptive-slug>.md`.** Do NOT compute the next version, do NOT create `docs/releases/vX.Y.Z.md`, and do NOT write to a shared `unreleased.md` — release-please picks the version and the release workflow aggregates pending fragments at release time. See the "Release notes" section below for what each fragment should contain.

### 4. Run all checks locally

```bash
# Tier 1 — quality (must pass before anything else)
bun run typecheck
bunx biome ci .

# Tier 2 — unit tests (all platforms in CI; run locally on yours)
# For directories with mock conflicts, use per-file loops:
for f in tests/unit/tools/*.test.ts; do bun --smol test "$f" --timeout 30000; done
# CI also isolates hook files per file because several hooks share mutable mocks:
for f in src/hooks/*.test.ts tests/unit/hooks/*.test.ts; do bun --smol test "$f" --timeout 30000; done
# For directories without known mock conflicts, batch is fine:
bun --smol test tests/unit/cli tests/unit/commands tests/unit/config --timeout 120000

# Tier 3 — integration tests
bun test tests/integration ./test --timeout 120000

# Tier 4 — security and adversarial tests
bun test tests/security --timeout 120000
bun test tests/adversarial --timeout 120000

# Tier 5 — build + smoke (smoke tests require a successful build first)
bun run build
bun test tests/smoke --timeout 120000
```

Fix any failures before proceeding. If a test failure is pre-existing and unrelated to your changes, note it in the PR description but do not skip the other tiers.

### 5. Push and open a PR

```bash
git push -u origin <branch-name>
gh pr create --title "<type>(<scope>): <description>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points explaining what and why>

## Test plan
- [ ] <what you tested>

EOF
)" --base main
```

The PR title **is** the squash merge commit message. It must follow the conventional commit format exactly (see below). The `pr-standards` CI check enforces this.

### 6. Wait for CI

All checks must be green before merging. See the "CI checks" section below for the full list.

### 7. Merge the PR

Use squash merge (GitHub default). The PR title becomes the commit message that release-please reads.

### 8. What happens automatically after merge

1. `release-please` runs and creates (or updates) a release PR (e.g. `chore(main): release 6.41.0`)
2. The `update-pr-notes` job prepends your `docs/releases/` file to the release PR body (preserving release-please markers — see "How releases work" below)
3. When someone merges the release PR, release-please creates a git tag + GitHub Release, and the `publish-npm` job publishes to npm automatically

**Do not manually create tags, releases, or run `npm publish`.** The pipeline handles everything.

---

## How releases work

This repository uses [release-please](https://github.com/googleapis/release-please) (`release-type: node`) to automate versioning, changelog generation, and npm publishing. The entire release pipeline is driven **exclusively by commit messages and PR titles**. There is no manual versioning step.

When a PR is merged to `main`:
1. `release-please` reads every commit message merged since the last release tag
2. It determines the next semver version bump based on conventional commit types
3. It creates or updates a "release PR" that bumps `package.json`, updates `CHANGELOG.md`, and updates `.release-please-manifest.json`
4. When that release PR is merged, it creates a git tag + GitHub Release and publishes to npm

**If your commit messages are malformed, release-please will either ignore your changes in the changelog or produce the wrong version bump.** There is no recovery path other than a follow-up fix commit.

### Critical: release-please PR body markers

release-please identifies its own PRs by parsing markers in the PR body (the `:robot: I have created a release` header and structured changelog). **Never replace the entire body of a release PR.** The `update-pr-notes` CI job aggregates pending release-note fragments from every PR referenced in the release-please PR body and inserts the combined content inside a stable `<!-- custom-release-notes:start -->` … `<!-- custom-release-notes:end -->` marker block — release-please's own markers must remain intact below it. Same flow runs against the GitHub Release body after a tag is cut via `update-release-notes`. The implementation is `scripts/release-notes-fragments.mjs`.

### What release-please manages automatically — do not touch manually

- `package.json` → `version` field
- `CHANGELOG.md`
- `.release-please-manifest.json`

If you manually edit any of these files in a PR, release-please will conflict with itself on the next run. Leave them alone.

---

## Commit message format (Conventional Commits)

Every commit **and every PR title** must follow this format exactly:

```
<type>(<optional scope>): <description>
```

- The description must be lowercase and not end with a period
- The type must be one of the allowed types below
- Scope is optional but encouraged for clarity

### Allowed types and their semver effect

| Type | Changelog section | Version bump |
|---|---|---|
| `feat` | Features | **minor** (e.g. 6.30.1 → 6.31.0) |
| `fix` | Bug Fixes | **patch** (e.g. 6.30.1 → 6.30.2) |
| `perf` | Performance Improvements | **patch** |
| `revert` | Reverts | **patch** |
| `docs` | Documentation | none (not included in changelog) |
| `chore` | — | none (not included in changelog) |
| `refactor` | — | none (not included in changelog) |
| `test` | — | none (not included in changelog) |
| `ci` | — | none (not included in changelog) |
| `build` | — | none (not included in changelog) |

> **Note:** Types that produce "none" version bump (`docs`, `chore`, `refactor`, `test`, `ci`, `build`) will not trigger a release on their own. If your PR only contains these types, release-please will not create a release PR until a bump-producing commit (`feat`, `fix`, `perf`, `revert`) is merged.

### Breaking changes → major bump

To trigger a **major** version bump (e.g. 6.30.1 → 7.0.0), add a footer to the commit body:

```
feat: redesign swarm orchestration API

BREAKING CHANGE: SwarmConfig.agents field renamed to SwarmConfig.workers
```

Or append `!` to the type:

```
feat!: redesign swarm orchestration API
```

### Valid examples

```
feat(architect): add retry backoff to SME delegation
fix(circuit-breaker): prevent race condition on concurrent invocations
perf(plan-sync): reduce lock contention in worker handoff
docs: update getting-started guide for bun 1.2
chore: bump @opencode-ai/sdk to 1.1.54
test(gate): add adversarial coverage for evidence summary init
ci: add tiered test pipeline and PR quality checks
refactor(swarm): extract phase orchestration into dedicated module
```

### Invalid examples (will be rejected by `pr-standards` CI check)

```
WIP
fix stuff
Update README
feat: Add new feature.        ← trailing period
Feat: new feature             ← uppercase type
feature: new thing            ← not an allowed type
```

---

## PR title requirement

The PR title is used by release-please as the squash merge commit message. **It must follow the same conventional commit format as individual commits.** The `pr-standards` CI check will block merging if the title is invalid.

Choose the type that matches the **primary change** in the PR:
- New capability → `feat`
- Bug fix or correctness fix → `fix`
- Mixed feat + fix → use `feat` (minor bump subsumes patch)

---

## What CI checks must pass before merging

All of these must be green. They run automatically on every PR.

| Check | What it validates |
|---|---|
| `quality` | TypeScript compiles (`tsc --noEmit`), Biome lint + format clean |
| `unit` (Ubuntu, macOS, Windows) | Unit tests pass on all platforms |
| `dist-check` | Committed `dist/` matches a fresh build |
| `package-check` | Package metadata and publishable artifact checks pass |
| `integration` (Ubuntu) | Integration tests pass (circuit breakers, gate workflows, state machines) |
| `security` (Ubuntu) | Security and adversarial tests pass |
| `php-validation` | PHP language/build fixtures and validation tests pass |
| `rust-sandbox-runner` | Rust sandbox runner builds and validates |
| `smoke` (Ubuntu, macOS, Windows) | Package builds successfully and smoke tests pass on all platforms |
| `pr-standards` | PR title is a valid conventional commit |
| `check-duplicates` | PR title does not match an already-open PR |

**Do not ask for a merge if any check is red.** Fix the issue first.

---

## Test rules

### Test framework

All tests use `bun:test`. Do not use Jest, Vitest, or any other framework. See `.opencode/skills/writing-tests/SKILL.md` for the full guide including mock isolation rules and cross-platform requirements.

### Test directory map

| Directory | Purpose |
|---|---|
| `tests/unit/` | Pure logic tests, no I/O, fast (<5s total) |
| `tests/integration/` | Multi-component tests, orchestration flows, state machine transitions |
| `tests/smoke/` | Post-build packaging verification — does the built artifact actually work? |
| `tests/security/` | Adversarial inputs, injection attempts, CI security invariants |
| `tests/adversarial/` | Extended adversarial scenarios for swarm-specific attack surfaces |
| `tests/architect/` | Architect agent behavior and identity tests |
| `test/` | Top-level standalone tests (adversarial plan write, reviewer tiers, agent tagging) |

### When you change behavior, update the tests

If your code change alters the behavior of an existing function (new error messages, stricter validation, changed defaults), **find and update every test that asserts the old behavior.** Do not leave tests failing for a follow-up PR. Common examples:

- Adding `.strict()` to a Zod schema → tests asserting unknown fields are accepted must flip to rejected
- Adding `.int()` validation → tests asserting floats are accepted must flip to rejected
- Changing error handling from silent skip to structured error → tests asserting no output must assert the error
- Adding a new default field to a config schema → tests using `toEqual({...})` on config objects must include the new field

---

## Release notes (mandatory — no exceptions)

**Every PR with a user-visible change MUST add a pending fragment at `docs/releases/pending/<descriptive-slug>.md`.** This is not optional. This is not conditional on "user-facing changes" being polished. If your PR is merged without it, release-please publishes a generic changelog with no explanation of what changed or how to migrate.

> **Do NOT** calculate the next version, create `docs/releases/vX.Y.Z.md`, or write to a shared `unreleased.md`. release-please picks the version. The release workflow (`scripts/release-notes-fragments.mjs`) gathers every pending fragment from every PR included in the release-please release PR and inserts the combined content into a stable marker block in the release PR / GitHub Release body. Each PR owning its own unique file is what makes the previous merge-conflict hotspot go away.

### Where to put the fragment

- Path: `docs/releases/pending/<descriptive-slug>.md`
- Slug: short, kebab-case, descriptive of THIS change. Examples:
  - `docs/releases/pending/guardrails-transient-node-errors.md`
  - `docs/releases/pending/spec-drift-self-ack-guardrail.md`
  - `docs/releases/pending/phase-complete-durable-gate-proof.md`
- Pick a slug nobody else is likely to pick. Concurrent PRs each adding a *different* file produce zero merge conflicts.

### What to include

The fragment is freeform markdown. Cover:
- **What changed** — summarize the changes grouped by theme
- **Why** — the motivation (bug report, feature request, hardening)
- **Migration steps** — if any API, config, or behavior changed
- **Breaking changes** — if any (should be rare)
- **Known caveats** — anything users should watch out for

Do not prefix the heading with a version (`# v7.21.4`) — release-please owns the version. A descriptive `# <topic>` is the canonical header. See `docs/releases/v6.35.0.md` for the prose style; ignore the version prefix in that historical file.

### What still happens automatically

After your PR merges, release-please opens or updates its release PR. CI runs `scripts/release-notes-fragments.mjs update-pr` to aggregate every pending fragment referenced by that release PR and inject it inside the `<!-- custom-release-notes:start --> … <!-- custom-release-notes:end -->` marker block (preserving release-please's own body markers). When the release PR merges and a tag is cut, `update-release` mirrors the same aggregation into the GitHub Release body. **Pending fragments are not deleted automatically.** They stay in `docs/releases/pending/` until a maintainer prunes them post-release.

---

## SHA pinning for GitHub Actions

If you add or modify a workflow file in `.github/workflows/`, every `uses:` reference to a third-party action must be pinned to a full 40-character commit SHA with the version as a comment. This is a hard requirement enforced by the security tests.

```yaml
# Correct
- uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1

# Wrong — will fail security tests
- uses: actions/checkout@v4
- uses: actions/checkout@main
```

To find the SHA for a given tag, run:
```bash
gh api repos/{owner}/{repo}/git/ref/tags/{tag} --jq '.object.sha'
```

---

## Common mistakes that break the release pipeline

| Mistake | Consequence | Prevention |
|---|---|---|
| Replacing release PR body | release-please can't parse its own PR → no tag, no release, no npm publish | Never `gh pr edit --body-file` on a release PR; use prepend only |
| Editing `package.json` version | Merge conflict with release-please on next run | Let release-please manage version fields |
| Editing `CHANGELOG.md` | Merge conflict with release-please on next run | Let release-please manage the changelog |
| Editing `.release-please-manifest.json` | release-please version tracking breaks | Let release-please manage the manifest |
| Using only `docs`/`chore`/`test`/`ci` commit types | No version bump triggered, release PR is never created | Include at least one `feat` or `fix` commit if you want a release |
| Creating tags or releases manually | `publish-npm` job doesn't trigger (gated on release-please output) | Let the pipeline create tags and releases |
| Missing `docs/releases/pending/<slug>.md` | GitHub Release has no useful description | Always add a unique pending fragment for your PR |
| Creating `docs/releases/v{VERSION}.md` in a feature/fix PR | Version prediction collides with release-please; merge conflict hotspot | Use `docs/releases/pending/<slug>.md` instead — release-please owns the version |
| Writing to a shared `docs/releases/unreleased.md` | Same merge-conflict hotspot, just relocated | Use a unique slug under `docs/releases/pending/` per PR |

---

## Summary checklist for any PR

- [ ] [`AGENTS.md`](./AGENTS.md) read; touched invariants identified
- [ ] PR body includes an `## Invariant audit` section in the format from `AGENTS.md` (when relevant invariants are touched)
- [ ] OpenCode `test_runner` was NOT used with `scope: 'all'` or broad `'graph'` / `'impact'` scope to validate this repo (use shell commands instead)
- [ ] If invariants 1, 2, or 3 (plugin init / runtime portability / subprocesses) are touched: ran `bun run build`, `node scripts/repro-704.mjs`, and `node --input-type=module -e "await import('./dist/index.js'); console.log('dist import OK')"` cleanly
- [ ] Branch created from latest `main`
- [ ] Every commit message follows `<type>(<scope>): <description>` format
- [ ] PR title follows the same format and matches the primary change
- [ ] No manual edits to `package.json` version, `CHANGELOG.md`, or `.release-please-manifest.json`
- [ ] `docs/releases/pending/<unique-slug>.md` exists with release notes (do NOT create `docs/releases/vX.Y.Z.md`)
- [ ] New tests are in the correct `tests/` subdirectory
- [ ] Tests updated for any changed behavior (defaults, validation, error messages)
- [ ] If adding/modifying a workflow, all `uses:` references are SHA-pinned
- [ ] All CI checks pass locally or remotely as appropriate (`typecheck`, `biome ci`, `unit`, `integration`, `security`, `dist-check`, `package-check`, `php-validation`, `rust-sandbox-runner`, `smoke`)
- [ ] PR description includes a summary and test plan
