# Automatic Skill Context Enrichment (issue #901)

## What changed
- **Auto-populated skill index**: `skillPropagationGateBefore` now auto-populates `.swarm/context.md` with a `## Available Skills` section at session start, listing all project skills sorted by relevance score with usage counts and compliance rates.
- **Visible warnings**: When the architect delegates to a skill-capable agent (coder, reviewer, test_engineer, etc.) without providing a `SKILLS:` field while skills exist, a visible warning is now injected into the architect's prompt via `pendingAdvisoryMessages`.
- **Configurable enforce mode**: A new `enforce` configuration toggle on `SkillPropagationConfig` can block delegations that are missing the `SKILLS:` field when skills exist in the project. Default remains warn-only.
- **SKILLS_USED_BY_CODER validation**: When delegating to a reviewer after a coder task, the gate verifies that `SKILLS_USED_BY_CODER:` is present and surfaces a warning if missing (never blocks).
- **Scoring budget safeguard**: Relevance scoring is skipped when a session exceeds 500 skill-usage entries, falling back to alphabetical ordering to prevent unbounded file reads.
- **Graceful degradation**: Zero installed skills = zero friction — no warnings, no blocks, no auto-population.

## Why
Issue #901 reported that skills were rarely or inconsistently passed to sub-agents during delegation. The architect skipped skill discovery because it was expensive (many manual `search` tool calls) and unenforced. This fix makes skill context available without manual discovery and provides visible feedback when it's missing.

## Migration steps
None — the enforce mode defaults to warn-only (no behavioral change for existing projects).

## Known caveats
- `update_task_status` may be blocked for individual tasks due to a per-session state machine issue in the delegation gate (tool call prompts not reaching `messagesTransform` hook). This affects task status tracking in the plan UI but does not affect functionality.
- Enforce mode is currently not wired to the project config (`opencode.json`) — it requires programmatic configuration. This will be addressed in a follow-up.
