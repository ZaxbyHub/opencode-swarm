# `ci`: improve dist-check recovery docs, add cross-contamination check

## Summary

- Updated `.opencode/skills/writing-tests/SKILL.md`: Added `path.resolve()` mock-key guidance for cross-platform test patterns; fixed vitest-compat reference to use `mock()` (bun:test) instead of `vi.fn()`
- Updated `.agents/skills/subprocess-safety/SKILL.md`: Added `execFile` callback vs `execFileSync` stdio distinction; corrected `execFile` return type to document `ChildProcess` reference and `proc.kill()` applicability
- Added `scripts/check-cross-contamination.sh`: CI gate that detects mock.module/vi.mock() pollution across paired test files that pass individually but fail together
- Updated `.github/workflows/ci.yml`: Added cross-contamination check step to CI pipeline

## User-facing changes

None — CI changes and skill documentation updates only.

## Migration notes

None required.
