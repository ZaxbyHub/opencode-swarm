---
name: skill-edit-validation
description: Content-assertion sweep after editing SKILL.md files. Triggered when a task changes skill or prompt content that tests assert against. Prevents stale-assertion CI failures.
---

# Skill Edit Validation

## Trigger
After editing ANY `.md` file under `.opencode/skills/`, `.claude/skills/`, or `.agents/skills/` that changes content wording (not just whitespace/formatting).

## Protocol
1. **Extract changed phrases:** Identify old wording vs new wording (e.g., "spec.md does NOT exist" changed to "NO effective spec exists")
2. **Targeted sweep:** For each OLD phrase, grep test files:
   ```
   rg "<old-phrase>" tests/ src/ --type ts -l
   ```
   Focus on: `*-audit*`, `*-security*`, `*-spec-gate*`, `*skill-mirror*`, `*soft-spec*`, `*prompt*`, `*workflow*`
3. **For each match:** Read the assertion context (surrounding 10 lines). Verify:
   - Does the assertion still hold against the new content?
   - Is it checking a substring containing the old phrase?
   - Is it checking for the ABSENCE of a word the new wording introduces? (e.g., `not.toContain('skip')` catches "this check is skipped")
4. **Update stale assertions in the same changeset.** Do NOT defer to CI.
5. **Preserve behavioral intent:** When updating, preserve what the assertion TESTS (e.g., "the plan skill has a spec-absent branch"), not just the string match.

## Constraint
Do NOT rubber-stamp brittle assertions. If an assertion tests implementation detail rather than behavioral intent, flag it for refactoring to a semantic check.

## Root cause
A skill-content test registry would auto-adjust (issue #1746 item 3). This playbook is the manual safety net.
