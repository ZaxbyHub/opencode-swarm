# Per-PR pending release-note fragments (conflict-free workflow)

## What changed

- **New contributor workflow**: PRs now add a unique fragment at
  `docs/releases/pending/<descriptive-slug>.md` instead of creating
  `docs/releases/v{NEXT_VERSION}.md`. Each PR owning its own unique file
  eliminates the previous merge-conflict hotspot where concurrent fix PRs
  all targeted the same next-version file.
- **New aggregation script** (`scripts/release-notes-fragments.mjs`,
  ~250 lines, pure Node built-ins + `gh` CLI, no npm deps):
  - `update-pr` mode — finds the open release-please PR (label
    `autorelease: pending`), extracts referenced source PR numbers from
    its body, verifies each is actually a PR (skips bare issue refs),
    gathers their `docs/releases/pending/*.md` files, concatenates them
    deterministically (sort: PR number ascending → file path ascending),
    and injects the combined text inside a stable
    `<!-- custom-release-notes:start --> … <!-- custom-release-notes:end -->`
    marker block in the release PR body. Idempotent (replace-in-place on
    re-run). Preserves all release-please robot/body markers.
  - `update-release` mode — same flow but operates on the GitHub
    Release body after a tag is cut, keyed by `$TAG_NAME`.
- **Workflow** (`.github/workflows/release-and-publish.yml`):
  - `update-pr-notes` job now runs
    `node scripts/release-notes-fragments.mjs update-pr` instead of
    parsing the version from the release PR title and looking up
    `docs/releases/v${VERSION}.md`.
  - `update-release-notes` job now runs
    `node scripts/release-notes-fragments.mjs update-release` instead
    of looking up `docs/releases/${TAG_NAME}.md`.
  - All existing action SHA pins unchanged. Permissions unchanged
    (`update-pr-notes` keeps `pull-requests: write` + `contents: read`;
    `update-release-notes` keeps `contents: write`).
- **Documentation updates** so every contributor-facing rule points at
  the new convention:
  - `contributing.md` — release-notes section, common-mistakes table,
    final checklist.
  - `.claude/skills/commit-pr/SKILL.md` — Step 3 rewrite + checklist.
  - `.opencode/contributing/SKILL.md` — same.
  - `.opencode/skills/generated/pr-review-fix/SKILL.md` — same.
  - `AGENTS.md` §12 release/cache hygiene.
  - `src/agents/docs.ts` — docs-agent system prompt updated.
- **Tests** (`tests/unit/scripts/release-notes-fragments.test.ts`,
  27 cases, `bun:test`, no `mock.module`, pure-function tests only):
  - PR-number extraction across all release-please syntaxes
    (`(#N)`, `[#N]`, `/pull/N`, bare `#N`).
  - De-duplication across syntaxes, first-seen ordering preserved.
  - Path filter keeps `docs/releases/pending/*.md`, ignores
    `docs/releases/v*.md` and unrelated paths, normalizes Windows
    backslashes.
  - Deterministic ordering: PR number ascending → path ascending.
  - Marker-block insert / idempotent replace / preserve release-please
    body markers / empty-input safety.

## Why

The previous workflow required every PR to predict the next semver
version and create `docs/releases/v{NEXT_VERSION}.md`. release-please
already owns the version decision, so the manual prediction was
duplicate work AND a hotspot for merge conflicts whenever two fix PRs
were in flight simultaneously. Refactoring to per-PR unique fragments
removes both problems without introducing a shared file (which would
just relocate the same conflict surface).

## Migration steps

- New PRs: do NOT compute `NEXT_VERSION`. Do NOT create
  `docs/releases/vX.Y.Z.md`. Add
  `docs/releases/pending/<descriptive-slug>.md` instead.
- Existing in-flight PRs that already added a `docs/releases/vX.Y.Z.md`
  file: move the content into
  `docs/releases/pending/<descriptive-slug>.md` and remove the
  versioned file from the PR. Historical versioned release docs on
  `main` are NOT touched.
- No changes required to `package.json`, `CHANGELOG.md`,
  `.release-please-manifest.json` — release-please continues to own
  those.

## Known caveats

- Pending fragments are NOT automatically deleted after release. A
  maintainer prunes `docs/releases/pending/` after a release ships
  (kept human-in-the-loop to avoid silently dropping notes).
- The aggregation runs only when a release PR exists (post-merge to
  `main`) or when a tag is cut. Local PR previews don't show the
  aggregated body — that's by design, since the aggregation depends
  on which PRs release-please actually bundles into the next release.
