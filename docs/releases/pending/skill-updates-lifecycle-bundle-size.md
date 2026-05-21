## Skill Documentation Updates

### What Changed
- **writing-tests skill**: Added "Lifecycle Hook Placement (bun:test)" subsection documenting critical behavior where `afterEach` called inside `test()` registers on the enclosing `describe` block, not the current test. Includes correct and incorrect code patterns with explanations.
- **ci-failure-resolver skill**: Added "Protocol: BUNDLE SIZE REGRESSION" section with step-by-step diagnosis and remediation for CI smoke test failures caused by bundle size limits. Documents `--minify`, tree-shaking, and lazy-loading as remediation options.
- **ci-failure-resolver skill**: Duplicated from external `~/.claude/skills/` into project repo (`.claude/skills/ci-failure-resolver/`) for swarm-managed updates.

### Why
These updates capture hard-won knowledge from PR #940:
1. Test lifecycle bug: `afterEach` placed inside `test()` bodies caused state bleed between tests because bun:test registers the hook on the `describe` scope
2. Bundle size regression: Adding `bash-parser` dependency pushed CLI bundle from ~1.2MB to ~2.2MB, exceeding the 2MB smoke test limit. The `--minify` flag reduced it to ~1.3MB.

### Migration
No migration required. These are documentation-only skill updates.

### Known Caveats
- The `ci-failure-resolver` skill now exists in two locations: the external `~/.claude/skills/` directory and the project repo. Future updates should be made to the project copy.
