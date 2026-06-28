feat(architect): async-by-default, complexity-scaled codebase reality check

What changed:
- The CODEBASE REALITY CHECK (pre-phase-briefing protocol) now runs as
  asynchronous, fanned-out Explorer lanes by default instead of a single
  blocking explorer pass. The Architect dispatches the lanes with
  `dispatch_lanes_async`, records the `batch_id`, and continues non-dependent
  work (retro/user_directives digestion, spec/plan internal-consistency review,
  governance/QA-gate config checks, plan-skeleton prep) while they run.
- The number of lanes scales to the size of the referenced surface — 1 lane for
  a trivial single-area surface, 2-4 for a typical multi-area phase, more up to
  the 8-lane dispatch cap for a large surface — rather than a fixed count. This
  avoids both the over-spawn (token waste) and under-spawn (coverage gap)
  failure modes.
- Before dispatch, the Architect partitions every referenced item (file,
  module, function, API, config surface, behavioral assumption) into
  non-overlapping lane assignments whose union covers every reference. Disjoint
  boundaries prevent duplicated work; full-union coverage prevents gaps.
- The blocking gate is preserved and strengthened, not removed: no spec
  finalization, plan generation, plan ingestion, `declare_scope`, or
  implementation-agent dispatch may begin until all lanes are settled
  (`collect_lane_results` reports `all_settled`) AND the report is finalized.
  Missing/failed/timed-out lanes are explicit coverage gaps (BLOCKED /
  SKIPPED_WITH_REASON), never a silent pass. Async dispatch changes when the
  Architect waits, never whether the gate holds.
- The architect-prompt PRE-PHASE BRIEFING hard constraint was broadened from
  "before starting or resuming phase implementation" to also cover spec
  finalization, plan generation, plan ingestion, and `declare_scope`, so the
  stub-level gate matches the skill-level gate the reality check has always
  implied (it fires before SPECIFY/PLAN, not only before coding).

Why:
- The reality check sat on the critical path as a blocking single-explorer call,
  even though the Architect has legitimate non-dependent work to do while it
  runs and the async lane infrastructure (`dispatch_lanes_async` /
  `collect_lane_results` with a settlement boundary) already exists. Splitting
  the surface into narrower, disjoint lanes also lets each Explorer verify its
  references at full depth, which is what the section already asked for.

Scope: documentation/skill + architect-prompt guidance change. Files:
`.opencode/skills/pre-phase-briefing/SKILL.md`,
`.claude/skills/pre-phase-briefing/SKILL.md` (mirror),
`src/agents/architect.ts` (PRE-PHASE BRIEFING hard constraint),
`docs/architecture.md` (reality-check summary), plus new contract assertions in
`tests/unit/agents/architect-pre-phase-briefing.test.ts`.

Migration: none. The report format, status vocabulary
(NOT STARTED | PARTIALLY DONE | ALREADY COMPLETE | ASSUMPTION INCORRECT), the
SPECIFY/PLAN/external-import trigger points, and the greenfield exemption are
unchanged. No tool-layer changes — the async lane tools already exist.

Caveats: this is architect-prompt guidance, so adherence is probabilistic on
weaker models. The gate wording was written to be unmistakable
(dispatch-and-keep-busy, never fire-and-forget; hard join on `all_settled`) to
minimize the risk of an LLM proceeding before lanes settle.
