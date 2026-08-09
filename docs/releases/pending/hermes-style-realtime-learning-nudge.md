# Real-time learning nudge

## What changed

- Architect sessions now receive a cadence-bounded `[SWARM LEARNING NUDGE]` during longer work loops.
- The nudge prompts the architect to capture durable procedural lessons with `knowledge_add` while context is still fresh.
- The nudge now routes broader evidence-level learning to the existing curator phase/postmortem system instead of introducing a parallel learning reviewer.
- The cadence is configurable under `knowledge.realtime_learning_nudge`.

## Why

Hermes-style learning works by reviewing recent work while the context is still
available. opencode-swarm now gets that in-session prompt without bypassing its
existing validation, reinforcement, quarantine, skill proposal, and activation
gates.

## Migration steps

None. The nudge is enabled by default when knowledge is enabled, and can be
disabled with `knowledge.realtime_learning_nudge.enabled = false`.

> **Superseded in this same release by the learning data plane (issue #1821).**
> The nudge described above is prompt-only: it asks the architect to remember to
> call `knowledge_add`. Issue #1821 replaces that with a session-keyed queue that
> actually validates and admits candidates mid-session. When
> `learning.realtime_admission.enabled` is `true` (the default), the nudge is
> suppressed and the admission loop does the work instead.
>
> This note exists so the two fragments do not contradict each other in the same
> release. To keep the nudge behavior described above, set
> `learning.realtime_admission.supersede_nudge = false`.

## Known caveats

- The nudge does not auto-edit active skills.
- `skill_improve` remains quota-bounded and proposal/draft gated.
