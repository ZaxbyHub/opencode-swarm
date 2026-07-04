# Skill updates: session-retrospective guidance to execute, running-tests, writing-tests

## What changed

- `.opencode/skills/execute/SKILL.md`: Added step 5b-bis "Coder output verification" — guidance to verify coder actually produced changes via `diff` rather than accepting self-report alone. Addresses a recurring coder instability failure mode where coder reports DONE without having produced any diff.

- `.opencode/skills/running-tests/SKILL.md`: Added `bun test --exec bash` caveat to the Common PowerShell pitfalls section — this command fails on Windows hosts with ENOENT.

- `.opencode/skills/writing-tests/SKILL.md`: Added step 6 to the "Before Submitting" section recommending `biome check --write` scoped to touched test files only, to catch formatting issues before they reach CI.

## Why

Captured from the session-level retrospective. Three concrete cross-session failure modes with proven fixes now encoded in the relevant skills.

## Migration

No migration required — additive documentation changes to existing skill files; no runtime code or schema changed.

## Breaking changes

None.
