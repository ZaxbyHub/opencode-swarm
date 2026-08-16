# Architect prompt size ceiling (CI regression guard)

## What changed

- Added an exported `MAX_ARCHITECT_PROMPT_CHARS = 160_000` constant next to
  the `HARDENING BLOCK INVENTORY` comment in `src/agents/architect.ts`, with
  documentation of the measured baselines and the raise-with-justification
  policy.
- Added `tests/unit/agents/architect-prompt-budget.test.ts`, a CI regression
  suite asserting every reachable built-in architect prompt render stays
  under the ceiling: default factory render, maximal opt-in feature render
  (council + ui_review + design_docs + architectural_supervision +
  adversarial scope=all + memory + external skills + turbo + skills), the
  full `getAgentConfigs` pipeline (default and feature-heavy configs), a
  prefixed non-default swarm render, and the adversarial-scope variants
  (`security-only`, disabled).

## Why

Issue #1649: existing tests only assert lower bounds
(`toBeGreaterThan(100000)` in `tests/unit/agents/architect-adversarial.test.ts`,
`toBeGreaterThan(90000)` in `tests/unit/agents/critic.adversarial.test.ts`),
so the built-in architect prompt could grow indefinitely with no CI signal.
It in fact grew from ~104K chars when #1649 was filed (2026-07-02) to ~129K
default / ~149K with all opt-in features enabled at introduction of this
guard (~25% in six weeks). Bulk growth silently consumes model context
(~40K tokens at the ceiling) and cannot be caught in review of large
hardening additions. This is a test-only guard: no runtime prompt content,
substitution logic, or plugin behavior changed.

## Migration steps

None. This is additive test coverage plus an exported constant; no config,
CLI, or behavioral surface changed.

## Known caveats

- The ceiling applies only to built-in prompt renders. User-supplied
  `customPrompt`/`customAppendPrompt` values are intentionally exempt —
  `tests/unit/agents/architect-adversarial.test.ts` "Attack Vector 8"
  asserts 100KB user prompts are accepted without truncation.
- At introduction the heaviest legitimate render is ~149K chars; the 160K
  ceiling leaves ~7% headroom. Any PR whose prompt growth would cross the
  ceiling must either justify and raise the constant (updating the
  documented baseline) or trim hardening prose — deliberate bulk
  deletions of hardening text still require their own behaviorally
  evaluated change per #1649.
- The issue's second part (false `renderPrompt` "pinned call site" docstring)
  was already resolved by earlier work: `renderPrompt` no longer exists and
  `src/agents/template.ts` documents the actual substitution architecture,
  enforced by `tests/unit/agents/placeholder-safety-net.test.ts`. This
  change makes no further edits there.
