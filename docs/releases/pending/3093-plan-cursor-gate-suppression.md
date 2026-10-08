---
issue: 3093
---

### Plan-cursor and parallel pre-check injection now suppressed during active PR_REVIEW gates

Sessions with an active `PR_REVIEW` workflow gate no longer receive `[SWARM PLAN CURSOR]`
blocks or the adjacent `[SWARM HINT] Parallel pre-check …` guidance from unrelated plans.
The system-enhancer composition now reads the durable PR-workflow gate state once per
composed turn and suppresses both plan-execution directives on both context paths while
the gate's mode is `PR_REVIEW` (#3093). The gate read is durable-authoritative per turn,
so suppression is not sticky: when the gate clears (complete or abort), cursor emission
resumes on the next turn. `PR_FEEDBACK` gates and gate-free sessions are unchanged
(byte-identical cursor emission), the command banner and delegation steering channels
are untouched (owned by the follow-up gate-aware injection policy), and the cursor
builder in `extractors.ts` stays free of gate reads. Two new suites pin the contract: a
behavioral matrix (both paths, both modes, clear-and-resume) and a source-scan ratchet
guarding the fix shape.
