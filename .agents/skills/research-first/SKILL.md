---
name: research-first
description: Codex adapter for research-before-planning work. Use when a task depends on current external facts, unfamiliar libraries, APIs, standards, security advisories, release notes, product behavior, or repo behavior that must be verified before planning or implementation.
---

# Research First

Read `.claude/skills/research-first/SKILL.md` for the source protocol.

Codex-specific execution notes:

- For current or unstable external facts, browse or use primary sources and cite URLs.
- For repo facts, prefer `rg`, file reads, tests, and local source over memory.
- Separate verified facts from assumptions.
- Do not plan implementation until the relevant unknowns are resolved or explicitly marked as risks.

When research affects OpenAI product usage, use the `openai-docs` skill and official sources only.
