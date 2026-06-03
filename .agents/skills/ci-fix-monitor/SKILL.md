---
name: ci-fix-monitor
description: Codex adapter for monitoring and fixing CI failures on opencode-swarm PRs. Use when diagnosing failed checks, fixing dist-check mismatches (source rebuild or version-drift rebase), resolving quality/lint/format errors, or watching a PR until all checks are green.
---

# CI Fix Monitor

Read `.opencode/skills/generated/ci-fix-monitor/SKILL.md` for the full protocol.

Also load:

1. `.agents/skills/commit-pr/SKILL.md` before committing or pushing any fix
2. `.agents/skills/engineering-conventions/SKILL.md` if the fix touches source files beyond `dist/`
3. `.agents/skills/running-tests/SKILL.md` before running any test suite as part of a fix

Codex-specific execution notes:

- MCP tool names (`mcp__github__*`) are injected by the runtime harness and may differ across environments. Verify availability via `ToolSearch` before first use in a session.
- No `gh` CLI available. Use `mcp__github__pull_request_read` (method `get_check_runs`) to list check status and `mcp__github__get_job_logs` (with `return_content: true`) to fetch failure logs.
- For dist-check **source-change**: run `bun run build`, commit `dist/`, then push normally.
- For dist-check **version-drift** (branch behind main, only diff is a version string): `git fetch origin main && git rebase origin/main` (abort with `git rebase --abort` if conflicts occur and escalate to user), then `bun run build && node --input-type=module -e "await import('./dist/index.js'); console.log('dist import OK')" && git add dist/ && git commit` then `git push --force-with-lease origin <branch>`. Force-push is required and expected after rebase.
- For format violations: `bunx biome format --write <specific-file>` — do NOT run `biome format --write .` on the whole repo.
- After any source fix, run the focused test file (`bun test <file>`) before committing.
- Do not declare victory until ALL required checks show green; `skipped` is acceptable only if the same check was skipped on the base branch.
