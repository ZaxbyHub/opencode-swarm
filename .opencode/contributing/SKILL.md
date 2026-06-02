---
name: contributing
description: >
  End-to-end PR workflow for opencode-swarm. Covers branch setup, conventional
  commits, mandatory release notes, 5-tier CI checks, and PR submission format.
  Load this skill before creating branches, commits, or pull requests.
---

# Contributing to opencode-swarm

## 1. Branch Setup

```bash
git checkout main && git pull origin main
git checkout -b <type>/<short-description>
bun install --frozen-lockfile
```

Branch naming: `<type>/<short-description>` (e.g. `feat/add-retry-backoff`, `fix/plan-sync-race`).

## 2. Commit Message Format (Conventional Commits)

Every commit MUST follow: `<type>(<optional scope>): <description>`

Rules:
- Description lowercase, no trailing period
- Scope optional but encouraged

| Type | Changelog section | Version bump |
|------|-------------------|-------------|
| `feat` | Features | minor |
| `fix` | Bug Fixes | patch |
| `perf` | Performance | patch |
| `revert` | Reverts | patch |
| `docs` | Documentation | none |
| `chore` | — | none |
| `refactor` | — | none |
| `test` | — | none |
| `ci` | — | none |
| `build` | — | none |

Breaking changes: add `BREAKING CHANGE: <description>` footer or `!` suffix on type (e.g. `feat!:`). Triggers major bump.

Valid examples:
- `feat(architect): add retry backoff to SME delegation`
- `fix(circuit-breaker): prevent race condition on concurrent invocations`
- `refactor(swarm): extract phase orchestration into dedicated module`

Invalid (rejected by CI):
- `WIP`, `fix stuff`, `Update README`, `feat: Add feature.` (trailing period), `Feat:` (uppercase)

## 3. Release Notes (MANDATORY — every user-visible PR, no exceptions)

⛔ Do NOT compute the next version. ⛔ Do NOT create `docs/releases/vX.Y.Z.md`. ⛔ Do NOT write to a shared `docs/releases/unreleased.md`. release-please owns the version; the release workflow aggregates fragments at release time.

1. Choose a short, kebab-case slug describing your change. Pick one unlikely to collide with concurrent PRs.
2. Create `docs/releases/pending/<your-slug>.md`.

Include:
- What changed (grouped by theme)
- Why (bug report, feature request, hardening)
- Migration steps (if any)
- Breaking changes (if any)
- Known caveats

Use a descriptive heading (`# <topic>`), not a version prefix. Even one-line changes need a fragment explaining why it matters. Aggregation is done by `scripts/release-notes-fragments.mjs` via `.github/workflows/release-and-publish.yml` — each PR owning its own unique file is what eliminates the merge-conflict hotspot.

## 4. Run All Checks Locally (5 tiers, all must pass)

```bash
# Tier 1: Quality
bun run typecheck
bunx biome ci .

# Tier 2: Unit tests
bun test tests/unit --timeout 120000

# Tier 3: Integration tests
bun test tests/integration ./test --timeout 120000

# Tier 4: Security & adversarial
bun test tests/security --timeout 120000
bun test tests/adversarial --timeout 120000

# Tier 5: Build + smoke
bun run build
bun test tests/smoke --timeout 120000
```

**`dist-check` CI failures:** If `dist-check` fails, the committed `dist/` does not match what `bun run build` produces locally. This usually means the `dist/` was not rebuilt after source TypeScript changes. Fix: `bunx bun@1.3.13 run build` (CI uses Bun 1.3.13 — using a different local version produces different empty-if-branch formatting that fails the diff check). Commit the rebuilt `dist/` and push.

If a pre-existing unrelated failure exists, note it in the PR description but do NOT skip other tiers.

## 5. Push and Open PR

```bash
git push -u origin <branch-name>
```

PR title MUST be a valid conventional commit: `<type>(<scope>): <description>`

PR body template:
```
## Summary
- Bullet 1
- Bullet 2

## Test plan
- [ ] Tier 1 quality checks pass
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Security/adversarial tests pass
- [ ] Build + smoke tests pass
```

## 6. Do NOT Manually Edit These Files

release-please manages these automatically:
- `package.json` version field
- `CHANGELOG.md`
- `.release-please-manifest.json`

Never replace the release PR body, create tags/releases manually, or edit these files.

## 7. CI Checks (all must be green)

| Check | Validates |
|-------|-----------|
| `quality` | TypeScript compiles, Biome lint + format clean |
| `unit` (Ubuntu, macOS, Windows) | Unit tests pass cross-platform |
| `integration` (Ubuntu) | Integration tests pass |
| `security` (Ubuntu) | Security & adversarial tests pass |
| `smoke` (Ubuntu, macOS, Windows) | Package builds & smoke tests pass |
| `pr-standards` | PR title is valid conventional commit |
| `check-duplicates` | PR title not duplicate of open PR |

## 8. GitHub Actions SHA Pinning

All `uses:` in `.github/workflows/` must be pinned to full 40-char SHA with version comment:
```yaml
- uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1
```

Find SHA: `gh api repos/{owner}/{repo}/git/ref/tags/{tag} --jq '.object.sha'`

## PR Checklist

- [ ] Branch created from latest `main`
- [ ] Every commit follows `<type>(<scope>): <description>`
- [ ] PR title follows same format
- [ ] No manual edits to `package.json` version, `CHANGELOG.md`, or `.release-please-manifest.json`
- [ ] `docs/releases/pending/<unique-slug>.md` exists with release notes (NOT a `docs/releases/vX.Y.Z.md` file)
- [ ] New tests in correct `tests/` subdirectory
- [ ] Tests updated for any changed behavior
- [ ] If modifying workflows, all `uses:` are SHA-pinned
- [ ] All 5 CI tiers pass locally
- [ ] PR description includes summary and test plan
