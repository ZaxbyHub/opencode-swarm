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

## Known caveats

- The nudge does not auto-edit active skills.
- `skill_improve` remains quota-bounded and proposal/draft gated.
