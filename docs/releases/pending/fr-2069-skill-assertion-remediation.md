## Skill-assertion drift detector false-positive remediation

Closes #2069.

### What changed
- FR-001: Negated assertions (.not.toContain, .not.toMatch) are now skipped
- FR-002: toMatch(/regex/) assertions evaluated as compiled regex patterns via new RegExp(source, flags).test(skillContent) instead of literal substring includes(). Malformed regexes produce assertionKind malformed-regex.
- FR-003: Detector skips its own tests/unit/scripts/ directory and filters string-literal content
- FR-004: Attribution requires the exact assertion line to chain off a confirmed skill variable (no +/-2 window)
- FR-005: Four regression fixtures added (negation, regex, self-exclusion, attribution)
- FR-006: Skill-assertion findings emit at notice severity (non-blocking). SKILL_ASSERTIONS_STRICT=1 for opt-in hard-fail.

### Why
The detector emitted 68 false-positive findings (zero genuine) on PR #2065, training reviewers to ignore its signal.

### Migration
No migration required. Set SKILL_ASSERTIONS_STRICT=1 to restore hard-fail behavior.
