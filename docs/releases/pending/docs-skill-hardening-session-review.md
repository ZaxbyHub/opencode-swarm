# Skill hardening: bot-finding verification, SAST baseline guidance, circular dependency warning

## What changed

- `.opencode/skills/swarm-pr-feedback/SKILL.md`: Added "Automated Security Finding Verification" section with 6 concrete heuristics for disproving bot security false positives against source code (RegExp.exec vs child_process.exec, schema validation, Object.assign mutation, path containment, value vs key validation, deduplication).

- `.opencode/skills/engineering-conventions/SKILL.md`: Added "SAST baseline capturing (differential scanning)" section with timing safety guard (never capture after code changes), `changed_files` parameter guidance, and differential scanning workflow.

- `.opencode/skills/generated/safe-rename/SKILL.md`: Added "Circular dependency warning: type extraction from sibling files" subsection with code example, `repo_map` verification steps, and real-world rationale from PR #1702.

## Why

Captured from session review learnings across PRs #1702 and #1704. Three concrete failure modes with proven fixes now encoded in the relevant skills to prevent recurrence.

## Migration

No migration required — additive documentation changes to existing skill files; no runtime code or schema changed.

## Breaking changes

None.
