# critic_pre_plan mechanical-gate deadlock: escape hatch + robust approval recording

## What

Closes an unrecoverable deadlock in the `critic_pre_plan` mechanical gate
(issue #2012; introduced in `fix(gates): mechanize plan critic and FR coverage`,
PR #1706). When the critic returned APPROVED but the mechanical snapshot
recorder failed to persist the approval — because of a verdict-format
mismatch, a dispatch-signal miss, or a plan.json read race — the gate
permanently blocked ALL coder delegations. `critic_pre_plan` defaults to
`true`; before the initial-selection fix in #2087, it could not be disabled via
`set_qa_gates`, so there was no recovery: re-running the critic produced the
same mismatch, and
the only documented escape was abandoning the session (the reporter's "the
reset"). This was the same deadlock-pattern class already fixed for the
PR_REVIEW gate (#1898) and the knowledge gate.

Four compounding faults are fixed:

1. **No escape hatch.** The gate (`assertPlanCriticApprovedForExecution`)
   threw `PLAN_CRITIC_GATE_VIOLATION` on every coder delegation with no tool
   or command path to record a manual approval. This adds:
   - a `forceRecordPlanCriticApproval` hook (`src/hooks/delegation-gate.ts`)
     that writes a `plan_critic_gate` approval snapshot (the value the scoped
     loader accepts) tagged with a distinct `method: "manual_override"`
     audit marker, gated on an active architect session;
   - an `approve_plan_critic` tool (architect-callable, registered through
     the full metadata/manifest/index/controller chain);
   - a `/swarm approve-plan-critic` restricted command (human-only escape
     hatch; the agent cannot run it via `swarm_command`).
   Both paths funnel into the same hook. The command path sets
   `user_confirmed: true`; the tool path sets `user_confirmed: false`, so a
   self-approve is visible in the audit trail. A best-effort
   `plan_critic_gate_manual_approval` event is appended to
   `.swarm/events.jsonl`.

2. **Fragile verdict parsing.** `extractPlanCriticVerdict` required a literal
   `VERDICT: APPROVED` line and silently dropped every other shape, including
   `**VERDICT**: APPROVED`, `## Verdict` headings, and bare trailing tokens.
   Broadened to accept these, with false-positive guards: the bare-line
   fallback is restricted to the final ≤6 lines, excludes lines containing a
   `|` separator (the rubric template enumeration), and skips fenced code
   blocks.

3. **Fragile dispatch detection.** `PLAN_CRITIC_TASK_SIGNALS` had 7
   hand-curated substrings; realistic architect phrasings like "evaluate this
   plan" or "pre-implementation review" matched none, silently dropping the
   snapshot. Broadened with high-recall signals (safe: the caller already
   narrows to `subagent_type === "critic"`).

4. **Plan-read race.** `recordPlanCriticApprovalSnapshotIfApplicable` bailed
   silently if `loadPlanJsonOnly` returned null at the instant the critic
   dispatch returned. Added a bounded retry (≤2 attempts, ~150 ms apart) so a
   dispatch that landed just before a concurrent `save_plan` flush still
   records. The warning on persistent failure now names the
   `approve_plan_critic` recovery path.

The three `PLAN_CRITIC_GATE_VIOLATION` error messages now name both recovery
paths (`approve_plan_critic` tool and `/swarm approve-plan-critic` command).

## Why

Per-task commits (the reporter's trigger) is a correlate chosen in the same
architect dialogue as the QA gates, not a distinct code path — the gate and
the writer have zero commit-mode branching. The deadlock is generic: any
plan where the critic approval snapshot fails to record wedges the session.
The fix makes recording robust (faults 2–4) and adds recovery (fault 1)
following the established PR_REVIEW #1898 escape-hatch pattern.

## Impact

- A wedged `critic_pre_plan` session now has a documented, audited recovery
  that does not require abandoning the plan.
- Legitimate critic APPROVED verdicts are captured across a wider range of
  output formats and dispatch phrasings, reducing how often the escape hatch
  is needed.
- The `method: "manual_override"` + `user_confirmed` audit markers let a
  reviewer distinguish a mechanical critic approval from a manual override
  and a human-initiated override from an agent self-approve.
