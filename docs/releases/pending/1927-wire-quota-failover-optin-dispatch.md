# Model quota/rate-limit failover for the opt-in curator and skill-improver dispatch sites

## What

Extends model quota/rate-limit failover (the #1896/#1901/#1905 class) to the two
remaining opt-in LLM dispatch sites that previously called `client.session.prompt`
directly with no failover:

- The curator LLM delegate (`createCuratorLLMDelegate`) — used by phase curation,
  post-mortems, retrospective lesson enrichment, the knowledge/phase-monitor
  hooks, and memory consolidation.
- The skill-improver LLM delegate (`createSkillImproverLLMDelegate`) — used by
  session reflection and the skill-improvement service.

On a transient/quota dispatch error, each site now advances through its configured
`fallback_models` chain (re-prompting with a per-call `model` override) instead of
failing the opt-in feature outright. The curator inherits the explorer chain when
it declares none — now including `curator_consolidation`, whose model already
defaulted to explorer's but whose fallback chain did not, so consolidation-mode
dispatch previously had no failover. A `telemetry.modelFallback` event is emitted
on each failover for observability.

## Why

A role whose model exhausted its quota mid-run failed the opt-in feature — the
same incident class #1905 closed for the production dispatch sites and explicitly
deferred for these opt-in sites with a commitment to file the follow-up (#1927).
The `curator_consolidation` inheritance gap meant one curator mode silently had no
failover even after wiring.

## Migration

No breaking changes. The delegate signatures and their `undefined`-when-no-client
contract are unchanged; the existing `CURATOR_LLM_TIMEOUT` /
`SKILL_IMPROVER_LLM_TIMEOUT` timeout and cancellation semantics are preserved
(abort is classified as a permanent error and still maps to the sentinel). With no
`fallback_models` configured, behavior is identical to before (the primary error
surfaces and the caller degrades as it did previously).

## Caveats

- A new coherence guardrail (`tests/unit/hooks/dispatch-fallback-coverage.test.ts`)
  fails CI if a future production `client.session.prompt` dispatch site is added
  without model failover and without an explicit, reasoned allowlist entry. The
  two issue-declared out-of-scope sites (`evaluation/model-dispatcher.ts`,
  same-model-retry-only for benchmark attribution; `mutation/generator.ts`,
  `agent: undefined` with graceful `return []`) are allowlisted.
