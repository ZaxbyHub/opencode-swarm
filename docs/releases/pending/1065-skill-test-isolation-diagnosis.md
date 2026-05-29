# `docs(skills)`: test isolation failure diagnosis protocol

## Summary

- Added **"Diagnosing Test Isolation Failures"** section to `.opencode/skills/writing-tests/SKILL.md` — a 6-step protocol for identifying mock pollution vs test logic bugs when tests pass individually but fail together
- Added **"Anchored Content Assertions"** subsection to `.opencode/skills/writing-tests/SKILL.md` — guidance on position-aware `toContain()` checks that fail when structured sections (critic outcome mappings, classification lists) are removed, not just when words disappear from prose
- Added **vi.mock() closure capture pitfall** to `.opencode/skills/generated/mock-to-internals-migration/SKILL.md` Common mistakes table — documents that reassigning `mockFn.mockImplementation(newFn)` in test body does NOT update hoisted closures

## User-facing changes

None — documentation-only change to skill files. No runtime behavior changed.

## Migration notes

None required.

## Discovery context

These patterns were discovered during swarm PR review of #1064, where `semantic-diff-injection.test.ts` used `vi.mock()` + `delete require.cache` in `beforeEach`, causing 26 test regressions in `ast-diff.test.ts` when run together via Bun's shared-process hoist-time closure capture behavior.
