# Mandatory PR Publication Protocol

These instructions apply to Copilot coding agents, Copilot custom agents, and any AI agent assigned to a GitHub issue in this repository.

Before committing, pushing, opening a pull request, updating a pull request body, marking a pull request ready, or claiming CI/merge readiness, you MUST load and follow these, in precedence order (highest authority first):

1. `AGENTS.md`
2. `docs/engineering-invariants.md`
3. `.claude/skills/commit-pr/SKILL.md` — the single source of truth for publication
4. `.agents/skills/commit-pr/SKILL.md` — execution adapter (routes to #3)
5. `.github/skills/commit-pr/SKILL.md` — Copilot discovery shim (routes to #3)

The `commit-pr` skill is the only approved publication workflow.

> The requirements summarized below are a high-visibility **mirror** of `.claude/skills/commit-pr/SKILL.md` and are **subordinate** to it. If anything here ever differs from that skill, the skill wins — update this file to match rather than following the stale copy.

Do not run `git push`, `gh pr create`, `gh pr edit`, or `gh pr ready` until the `commit-pr` checklist is satisfied.

## PR title requirements

Every non-release-bot PR title MUST exactly match:

`<type>(<scope>): <description>`

Allowed types: `feat`, `fix`, `perf`, `revert`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`.

The description must be lowercase and must not end with a period. CI runs `action-semantic-pull-request` (the `check-title` job) and will fail malformed titles.

## PR body requirements

Every PR body MUST include these sections, in this order:

1. `## Summary`
2. `## Invariant audit`
3. `## Test plan`

When the PR resolves an issue, the body's first line MUST be `Closes #<issue-number>`.

The `## Invariant audit` section must follow the template in `.claude/skills/commit-pr/SKILL.md` (Step -1), listing each touched/not-touched invariant with concrete evidence.

The test plan must list the exact commands run and their result. Do not claim validation passed unless commands were actually run or remote CI completed successfully.

## Validation requirements

Before opening or updating a PR, run the validation required by `.claude/skills/commit-pr/SKILL.md` (Step 3).

At minimum, do not publish without documenting:

- build result (including `git diff --exit-code -- dist/`)
- typecheck result
- formatting/lint result (`bunx biome ci .`)
- relevant unit tests
- broader integration/security/smoke validation when required by the touched invariants
- any pre-existing failure proof from a clean `origin/main` worktree

If validation cannot be run because of environment limitations, the PR body must say so explicitly under `## Test plan` and explain what remains unvalidated.

## Release fragment requirement

Any PR that ships a user-visible change MUST add a pending release fragment at `docs/releases/pending/<unique-slug>.md`. Do not hand-edit `package.json` version, `CHANGELOG.md`, or `.release-please-manifest.json`. The `pr-standards` check enforces this.

## Issue comment requirement

If the PR closes an issue, post an issue comment containing:

- the PR link
- what changed
- how to use it
- migration steps or `No migration required`

## Hard stop

If the PR title, body, release fragment, invariant audit, issue comment, or validation evidence cannot be produced, do not open or mark the PR ready.

---

# Repository QA Standards

These standards apply to all Copilot interactions including code generation and PR review.

## Security
- Never hardcode secrets, tokens, API keys, or connection strings — use environment variables or a vault.
- All user input must be validated and sanitised before use.
- SQL and database queries must use parameterised statements, never string interpolation.
- No sensitive data (PII, tokens, passwords) in logs at any level.
- Public endpoints must include authentication checks and input validation.

## Reliability
- All async operations must have proper error handling (try/catch or .catch()).
- Network calls must include timeout and retry logic.
- Resource cleanup must be handled in finally blocks or equivalent.
- Avoid swallowing exceptions silently — log at minimum.

## Maintainability
- Functions must do one thing and stay under 50 lines where practical.
- No commented-out dead code — use version control instead.
- Variable and function names must be descriptive and follow project conventions.
- Avoid magic numbers and strings — use named constants.

## Performance
- Avoid unnecessary allocations in hot paths.
- Database queries must avoid N+1 patterns and use appropriate indexes.
- Large data sets must use streaming or pagination rather than loading entirely into memory.

## Testing
- All new public methods must have at least one unit test.
- Integration tests must clean up after themselves.
- Test files must be co-located with source using the pattern `<filename>.test.<ext>`.

## Code Style
- Prefer explicit types over `any` or implicit inference where possible.
- Limit line length to 120 characters.
- Use consistent indentation (spaces, not tabs) per the project's `.editorconfig`.
