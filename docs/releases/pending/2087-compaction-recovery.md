---
title: Make compaction and phase recovery fail safely
type: fixed
issue: 2087
---

- Prevented session compaction from prompting tool calls during OpenCode's tool-disabled summary turn. Swarm state is now injected as one escaped, bounded, summary-only facts block without changing the host prompt.
- Added durable, plan- and phase-bound proof for successful docs participation, including trusted background completions, so phase completion can recover after a restart without inferring docs from unrelated QA evidence.
- Added actionable missing-role recovery guidance and clarified that `require_docs` belongs to `phase_complete` configuration rather than the QA gate profile.
- Made initial QA gate selections honor explicit `false` values and made `critic_pre_plan` enforcement use the effective persisted policy while preserving fail-closed recovery and ratchet-only overrides.
