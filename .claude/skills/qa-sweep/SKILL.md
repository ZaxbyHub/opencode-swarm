---
name: qa-sweep
description: >
  Apply when implementing features, fixing bugs, debugging errors, investigating failures,
  tracing root causes, reviewing tech debt, tracing issues, planning fixes, or completing
  any task. Enforces parallel sub-agent implementation, independent adversarial review,
  and a 95% confidence gate before stopping.
effort: high
---

## QA & Independent Review Protocol

Follow this protocol on every implementation, fix, debugging, or review task.

### Phase 1 — Parallel Implementation
- Use parallel sub-agents to speed up independent units of work wherever possible.
- Each sub-agent must read relevant source code end-to-end before making changes.
- Reference official documentation to verify whether any behavior is intended before treating it as a bug.
- Do not trust assumptions — prove every behavior against actual code.

### Phase 2 — Independent Adversarial Review (Mandatory)
After implementation, spawn a FRESH sub-agent that has not participated in any prior work. Give it this directive verbatim:
> "Assume all work done by the implementing agent is incorrect until you can prove otherwise with
> absolute evidence from the actual code. The implementing agent makes frequent mistakes and tends
> to miss edge cases. Do not trust any claim without tracing it yourself. Review every change,
> test, and edge case end-to-end through the real source."

The review agent must:
- Independently trace each change end-to-end through the codebase
- Search for related issues and regressions the implementing agent may have introduced
- Verify documented behavior vs. actual code behavior
- Surface every edge case not explicitly covered

**Timing requirement:** Phase 2 must complete and all confirmed findings must be addressed **before the commit you intend as the final substantive push**. Do not defer this to "after CI passes" — CI passing on a buggy commit does not retroactively make the review optional. For high-risk work (security, isolation, IPC contracts, auth, payments), this is a hard gate with no exceptions.

### Phase 3 — Completeness Verification
Spawn a SECOND independent agent to verify original planned work vs. delivered work:
> "Assume nothing was completed correctly or fully. Map every originally planned item to actual
> code changes and verify each one independently. Do not trust the implementing agent's report."

### Stop Condition
Do NOT stop until ≥95% confident that:
- All issues, related issues, and edge cases are covered
- All review agent findings have been addressed
- Delivered work matches the original plan completely

If below 95%, state what remains and continue working.
