# Claude Code Swarm Mode

> **For this repository, [AGENTS.md](./AGENTS.md) is the root engineering contract. Read it before any code change.** The long-form rationale and historical failure map live in [`docs/engineering-invariants.md`](./docs/engineering-invariants.md). When swarm mode is enabled, `AGENTS.md` still applies; swarm-mode instructions add workflow structure, not exceptions to the engineering invariants.

Normal behavior is the default.

If `.claude/session/swarm-mode.md` exists, swarm mode is enabled for the current session and you must read that file before starting complex work.

When swarm mode is enabled:
- Quality is the only success metric.
- There is no time pressure.
- Do not compress a workflow just because the task is large.
- Prefer parallel subagents for disjoint investigation and review work.
- Keep implementation, validation, and final judgment in separate contexts when possible.
- Explorer-style work is for breadth and candidate generation.
- Reviewer-style work is for validation of candidate findings or implementation quality.
- Critic-style work is for final challenge of reviewer-confirmed findings or high-impact implementation conclusions.
- Do not let the same context both invent and approve a finding when a separate verification pass is possible.
- No approval without positive evidence of what was checked.
- No high-severity finding without exact evidence and, when relevant, runtime-aware verification.
- Preserve Claude Code speed by parallelizing broadly and reserving the deepest validation for high-risk or ambiguous work.
- Across many different repositories, explore local patterns first rather than assuming one project's conventions apply to another.

If `.claude/session/swarm-mode.md` does not exist, behave normally.

## Permanent project directives (do not override)

These directives were explicitly requested by the project owner and persist across all
sessions, contributors, and agents. They are not workflow preferences — they are
correctness gates.

1. **We never defer work.** Optional or background-flavored work is never silently dropped
   onto a fire-and-forget microtask, a "later" todo, or an untracked follow-up. If a result
   is needed by a downstream step, test, or user, the work is done as real, reachable,
   verifiable work — either awaited in-band or scheduled through a real durable task that
   is tracked to completion. "Defer" is never a synonym for "skip." A deferred task whose
   output is consumed must be observable and verifiable.

2. **We never ship unwired code.** Every new tool, transition, status, hook, command,
   agent-map entry, or new code path is wired end-to-end before a change is considered
   complete: export → plugin registration → tool/agent map entry → help/docs surface →
   test coverage. Dead exports, orphan transitions, unregistered tools, status enums with
   no producer/consumer, and untested branches count as unwired code and are blockers —
   not polish items for a later PR.
