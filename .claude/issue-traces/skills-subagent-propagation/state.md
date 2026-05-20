# State: Skills & agents.md not passed to subagents

## Current Phase
Phase 4: Implementation

## Completed Gates
- [x] Intake — issue normalized
- [x] Reproduction — confirmed via prompt analysis
- [x] Root cause — localized to architect prompt + subagent prompt INPUT FORMAT sections
- [x] Fix plan written
- [x] Self-critic review
- [x] User implementation approval

## Root Cause (one-line)
The architect prompt has no instructions to discover project skills or pass skill content to subagents; the delegation format has no SKILLS field; and subagent prompts have no instructions to apply received skill context.

## Active Fix Candidate
Add a `## SKILLS PROPAGATION` section to the architect prompt, a `SKILLS:` field to the delegation format, and `SKILLS:` handling in coder/reviewer/test_engineer/sme prompts.

## Files to Change
- src/agents/architect.ts — SKILLS PROPAGATION section + delegation format SKILLS field
- src/agents/coder.ts — SKILLS field in INPUT FORMAT
- src/agents/reviewer.ts — SKILLS field in INPUT FORMAT
- src/agents/test-engineer.ts — SKILLS field in INPUT FORMAT
- src/agents/sme.ts — SKILLS field in INPUT FORMAT (optional, low risk)

## Next Action
Implement the changes
