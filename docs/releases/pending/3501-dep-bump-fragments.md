---
issue: 3501
---

# Dependency-bump channel: release-fragment support for user-visible bumps

## What

The channel's first source-affecting dispatch (PR #3582, the zod 4.6.7 bump) passed every in-workflow gate but failed the quality job's pending-fragment gate in CI: `package.json` and `src/` pins are user-visible surfaces, and that gate has no bot-author exemption. The bot commit cannot carry a hand-written fragment (every-commit bot provenance forbids human commits on the branch), so the channel now writes its own.

`.github/workflows/dependency-bump.yml` gains an optional `issue` dispatch input; when set, the workflow writes `docs/releases/pending/dep-bump-<sanitized-pkg>-<version>.md` (frontmatter `issue:` linked, What section naming the bump and the pin-spec provenance; slug sanitized so scoped package names cannot inject a path separator), and both complete-diff allowlist gates expect the written file. The frozen C7 suite pins the input, the numeric validation, the write step's ordering before both gates, and the per-gate expectation.

## Why

Without this, every user-visible channel dispatch (any bump touching `package.json`, i.e. all of them) is undeliverable: the fragment gate fails CI and the bot cannot add the fragment itself. The zod (#3501) and fast-check (#3285) dispatches now carry their release notes through the same bot commit.
