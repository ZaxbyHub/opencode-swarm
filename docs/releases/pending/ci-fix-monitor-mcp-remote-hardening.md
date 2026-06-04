# ci-fix-monitor skill: remote MCP hardening and .agents/ adapter

## What changed

- Added **Environment note** section to `.opencode/skills/generated/ci-fix-monitor/SKILL.md`
  with an MCP tool equivalents table mapping `gh` CLI commands to their
  `mcp__github__` counterparts (`pull_request_read`, `get_job_logs`,
  `update_pull_request`), plus a ToolSearch caveat noting that MCP tool
  names are runtime-injected and should be verified before first use.

- Expanded the **dist-check** classification into two sub-cases:
  - **source-change**: source was modified but `dist/` not rebuilt — standard
    `bun run build` + commit path.
  - **version-drift only**: branch is behind main after a release commit; CI's
    merge-commit checkout embeds main's newer version in a fresh build while the
    committed `dist/` has the old version. Fix: `git fetch origin main &&
    git rebase origin/main && bun run build && git push --force-with-lease`.
    Includes rebase conflict-abort instruction (`git rebase --abort` + escalate
    to user) and a `node --input-type=module` smoke test before committing.

- Added **Step 4 subsections** for `integration` (pre-existing-check criteria
  before treating a failure as PR-introduced) and `security` (credential vs.
  SAST escalation paths; explicit no-suppress-without-user-approval note).

- Added **stall-detection fallback** to Step 5: if no CI event arrives after
  subscribing to PR activity, re-fetch check status via `get_check_runs` and
  report the stall to the user rather than waiting indefinitely.

- Created **`.agents/skills/ci-fix-monitor/SKILL.md`**: thin Codex adapter
  following the repo's `.agents/` pattern, delegating to the `.opencode/`
  canonical file and adding Codex-specific execution notes (MCP tools,
  two-case dist-check, biome scope rule, force-push after rebase, also-load
  list: `commit-pr`, `engineering-conventions`, `running-tests`).

## Why

The original `ci-fix-monitor` skill was written for desktop Claude Code with the
`gh` CLI. Applying it in remote/web execution environments failed silently
because the equivalent MCP tools have different names and calling conventions.
The version-drift pattern was discovered during PR #1102 and documented
post-merge. The adversarial review of the skill drafts found additional gaps:
missing smoke test on the rebase path, no rebase conflict escape, and
under-specified integration/security failure types.

## Migration

No migration required. Skill-only changes with no runtime impact.

## Known caveats

None.
