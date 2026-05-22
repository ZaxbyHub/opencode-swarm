# Skill Description-Aware Propagation

## What changed

- Skill indexes now include each skill's frontmatter name, description, and repo-relative path, so architects and subagents can choose relevant skills from descriptions instead of bare filenames.
- `SKILLS:` parsing now accepts multi-line catalog entries such as `file:.claude/skills/writing-tests/SKILL.md - Guidelines for writing tests` and records only the file reference in usage logs.
- Skill discovery normalizes paths to forward-slash repo-relative references on Windows.
- Agent prompts now tell subagents to read skill descriptions first and load the applicable full skill bodies on demand.
- Architect prompt guidance now explicitly checks project contract files such as `AGENTS.md` before delegation and passes relevant MUST/NEVER rules to the receiving agent.

## Why

Issue #957 reported that subagents often received only a skill link, or no useful skill context, so smaller models missed task-specific conventions like project testing rules. Description-aware catalogs make the relevant skill easier to route and let agents avoid loading unrelated skill bodies.

## Migration steps

None. Existing one-line `SKILLS: file:...` delegations continue to work.

## Known caveats

The skill propagation gate remains warn-only unless the caller wires enforce mode programmatically.
