# Issue #1746 Phase 3: Diff-Aware Placeholder Scan + Set-Dispatch Attribution

## Overview

Phase 3 of issue #1746 completed two complementary features: a diff-aware placeholder scan that gates PRs only on new placeholder patterns, and structured per-task verdict parsing for set-dispatch reviewer/test_engineer coverage.

## What changed

### FR-006: Diff-Aware Placeholder Scan

The `placeholder_scan` tool now accepts an `added_lines` parameter that restricts findings to lines added in the PR. Pre-existing placeholders on unchanged lines no longer gate the PR.

**What was added**:

- `added_lines?: Record<string, Set<number>>` — maps file paths to sets of line numbers that were added in this PR. When provided, the scanner ignores any finding on a line not in the set.
- `sentinel_allowlist?: string[]` — values that suppress findings when found as substrings in the excerpt (substring match). Unlike the file-level `FILE_ALLOWLIST`, this filters individual findings by value. Intended for intentional sentinel markers like `SC-PLACEHOLDER`.

**Behavioral notes**:

- Pre-existing placeholders on unchanged lines no longer gate PRs — only patterns on PR-added lines are reported.
- Intentional sentinels are excluded by value (substring match against the finding excerpt). If `SC-PLACEHOLDER` appears anywhere in the finding excerpt, the finding is suppressed.
- When `added_lines` is omitted, the scanner falls back to reporting all findings (backward compatible).
- When `sentinel_allowlist` is omitted, all findings are reported (backward compatible).

**Example**:
```typescript
// Only scan line 2 (the added line); line 1 is pre-existing and ignored
const addedLines: Record<string, Set<number>> = {
  'src/example.ts': new Set([2]),
};
const result = await placeholderScan({
  changed_files: ['src/example.ts'],
  added_lines: addedLines,
  sentinel_allowlist: ['SC-PLACEHOLDER'], // suppress intentional markers
}, workingDir);
// Line 1 findings are suppressed (not in added_lines)
// Findings containing "SC-PLACEHOLDER" are suppressed (substring match on excerpt)
```

**Why it matters**: Legacy codebases often contain TODO/FIXME comments. Without diff-awareness, every PR would be blocked by pre-existing placeholders. The sentinel allowlist lets teams mark intentional placeholders (e.g., `// TODO: SC-PLACEHOLDER implement later`) without disabling the scan entirely.

### FR-007: Set-Dispatch Per-Task Attribution

Reviewer and test_engineer agents now emit structured per-task verdict lines when covering multiple tasks in a single dispatch (set-dispatch). The delegation gate parses these verdicts and attributes each task independently, preventing over-attribution.

**Structured verdict formats**:

```
[REVIEWED] | task-<task-id> | APPROVED | <optional note>
[REVIEWED] | <task-id> | REJECTED | <optional note>
[TESTED] | task-<task-id> | PASS | <optional note>
[TESTED] | <task-id> | FAIL | <optional note>
[TESTED] | <task-id> | SKIPPED | <optional note>
```

**Behavioral notes**:

- The tag is case-insensitive (`[REVIEWED]`, `[reviewed]`, `[Reviewed]` all work).
- Task IDs support arbitrary depth (`task-2.1`, `task-2.1.3.4.5`).
- Invalid task ID formats are silently ignored.
- When output contains no parseable verdict lines, the system falls back to single-task attribution (current task only).
- Each task advances independently in the workflow state machine based on its own verdict.

**Example output**:
```
[REVIEWED] | task-2.1 | APPROVED | No issues found in src/foo.ts
[REVIEWED] | task-2.2 | APPROVED | Minor suggestion only
[REVIEWED] | task-2.3 | REJECTED | Critical bug at line 88
```

**Why it matters**: In high-throughput workflows, a single reviewer or test_engineer dispatch may cover multiple tasks. Without structured verdict lines, the system would either over-attribute (record the agent on every task) or under-attribute (record on none). The verdict format enables precise per-task evidence.

## Files changed

- `src/tools/placeholder-scan.ts` — added `added_lines` diff-aware filtering and `sentinel_allowlist` by-value suppression
- `src/agents/reviewer.ts` — updated system prompt to emit structured `[REVIEWED] | task-<id> | <verdict>` verdict lines for set-dispatch
- `src/agents/test-engineer.ts` — updated system prompt to emit structured `[TESTED] | task-<id> | <verdict>` verdict lines for set-dispatch
- `src/hooks/delegation-gate.ts` — added `parsePerTaskVerdicts()` and per-task attribution logic in `recordStageBCompletion`
- `tests/unit/tools/placeholder-scan.test.ts` — added tests for diff-aware filtering and sentinel allowlist
- `tests/unit/hooks/delegation-gate.set-dispatch.test.ts` — new test file for FR-007 SC-022/SC-023/SC-024

## Testing

- **FR-006**: 6 new tests covering `added_lines` filtering, sentinel allowlist matching, and backward compatibility
- **FR-007**: 10+ new tests covering verdict parsing, multi-task attribution, and fallback behavior
- All tests pass: see CI output
