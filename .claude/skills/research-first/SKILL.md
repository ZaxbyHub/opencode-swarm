---
name: research-first
description: >
  Apply when planning fixes, investigating tech debt, architecting solutions, or
  diagnosing unknown issues that may involve external frameworks, dependencies,
  or platform behavior. Search online for current documentation and
  state-of-the-art approaches before tracing through code.
context: fork
agent: Explore
---

## Research Before Planning Protocol

This skill body runs in an isolated Explore context: it has no conversation
history and cannot spawn further sub-agents. Work from the task statement it
receives, run searches and reads directly, and return a compact findings
report.

Scope guard — research the outside world only when the problem involves it:
- If the question involves external frameworks, dependencies, platform or
  toolchain behavior, or a suspected upstream bug: research online first.
- If the question is purely repo-local (project conventions, invariants,
  existing code structure), skip web research; the answer lives in the
  repository (AGENTS.md, docs/, and the source itself).
- If WebSearch/WebFetch are unavailable in this environment, state that
  explicitly and proceed with code tracing rather than stalling.

When researching:

1. Search current official documentation to confirm the behavior is NOT
   intended and NOT already fixed in a newer release
2. Search for state-of-the-art solutions, known community workarounds, and
   recent discussion of this problem type
3. Run multiple searches across distinct sources (official docs, issue
   trackers, release notes) rather than trusting the first hit
4. Report all findings — with URLs — before any code tracing begins

Then trace each problem end-to-end through the actual source code.
Do not stop until ≥95% confident in the root cause for every issue being
investigated, and mark anything below that threshold as UNVERIFIED with what
evidence is missing.
