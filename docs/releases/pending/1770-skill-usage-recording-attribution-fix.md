# Skill-usage recording: fix attribution + observability + extract testable unit (#1770)

## What

Corrects the skill-usage recording defects behind audit PR 3/8 (#1770). The
issue's stated root cause (the skill-propagation gate recording usage *before*
the `SKILLS:` field is auto-injected) is **stale** — a post-injection recording
call has existed since v7.29.0 (`feat(skill-propagation): auto-inject skills`,
PR #987) and was present in v7.110.1 (the version the issue was filed against,
`git merge-base --is-ancestor`-verified). Two real defects remained in the
issue's scope checklist and are closed here:

- **Attribution** — the post-injection recorder wrote each injected skill with
  `agentName: String(input.agent)` (the **architect**/delegator) and a synthetic
  `taskID: 'injection'`. The three other recording sites use the **target
  subagent** + a real taskID. This broke the `SKILL_COMPLIANCE` round-trip
  (the compliance resolver only joined by coincidence via the `'injection'`
  sentinel) and inflated frequency + taskID-diversity scoring.
- **No real test coverage** — `skill-injection.test.ts` and
  `skill-injection-threshold.test.ts` re-implemented the injection logic in
  local `simulateSkillInjection*` helpers (comments: *"Replicates the injection
  logic from src/index.ts"*) and hardcoded the bug, so the real
  `appendSkillUsageEntry` call site had zero direct coverage — exactly why the
  attribution defect survived undetected.

## Changes

- **New `src/hooks/skill-injection.ts`** — extracts the ~95-line inline
  injection block from `src/index.ts` into a pure, exported
  `injectSkillsIntoDelegation(...)` function so the real recording path is
  testable. The function records each injected skill with the **target
  subagent** as `agentName` and a real `taskID` resolved via
  `extractTaskIdFromPrompt`, falling back to the literal `'auto-injected'`
  (NOT `'unknown'`) when the prompt carries no task marker — this preserves
  the compliance resolver's `resolvedTaskID !== 'unknown'` guard so the
  reviewer-verdict join keeps working for unmarked prompts.
- **Observability** — the function emits a `skill_injection_decision` event
  to `.swarm/events.jsonl` for BOTH the qualified-injection and the
  `SKILLS: none` branches, so a project whose skills all score below the 0.5
  threshold is now distinguishable from "the gate never ran" (the source of
  the issue author's "no events" observation). Usage entries are deliberately
  NOT written for the `SKILLS: none` branch: recording a phantom skillPath
  would corrupt per-skill scoring, and the absence of `skill-usage.jsonl`
  when no skill is injected is the correct semantic.
- **`src/index.ts`** — the 95-line inline block is replaced with a single
  call to `injectSkillsIntoDelegation(...)`, passing
  `parseDelegationArgs(input.args)?.targetAgent` (NOT `input.agent`) as the
  usage-entry agentName.
- **New `tests/unit/hooks/skill-injection-recording.test.ts`** — 30 tests
  exercising the REAL function with real `.swarm/skill-usage.jsonl` I/O,
  including the headline `SKILL_COMPLIANCE` round-trip
  (inject → reviewer verdict via `skillPropagationTransformScan` → joined
  compliance entry) and an explicit guard for the `'auto-injected'` taskID
  fallback case.
- **Removed** `tests/unit/hooks/skill-injection.test.ts` and
  `skill-injection-threshold.test.ts` — they tested a local re-implementation
  that hardcoded the bug. Their coverage (threshold boundary, top-5 cap,
  `SKILLS: none` fallback, skip-when-existing, error-non-blocking) is
  preserved and strengthened in the new file against the real code.

## Why

Without the attribution fix, reviewer `SKILL_COMPLIANCE` verdicts could never
be reliably joined back to the delegation that introduced the skill, so the
compliance-driven component of skill relevance scoring was effectively
un-attributable. The extraction makes the recording path testable at all —
the prior parallel-reimplementation tests would have continued to pass green
even as the real code drifted further.

## Notes

- Verified non-defects (correcting the issue's narrative): the transform
  scan's text-parts-only behavior is correct (reviewer verdicts are assistant
  message text, not tool args); the gate's internal explicit-SKILLS recording
  is intentional; the injected skill list is already captured in
  `background-delegations.jsonl`'s `prompt.text`.
- Out of scope (follow-ups): `SKILL_SEARCH_ROOTS` does not include
  `.agents/skills/` — projects with skills ONLY under that root still get no
  injection. That is a separate discovery issue; this repo has skills under
  `.opencode/skills/` and `.claude/skills/`, so the fix is effective here.
  A structured `injectedSkills` field on `BackgroundDelegationRecord` is
  deferred (the list is already queryable via `prompt.text`).

Closes #1770
