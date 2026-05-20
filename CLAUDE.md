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
