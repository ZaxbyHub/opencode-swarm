---
title: Harden advertised contracts from the #2087 triage
type: fixed
issue: 2109
---

- The compaction summary turn no longer injects the ` ← CURRENT` task marker (an
  action affordance telling the model "do this next") into the tool-disabled summary
  context; pending work remains present as factual state, and a regression test drives
  a real plan with an in-progress task to assert the injected block is directive-free.
- The `phase_complete` missing-agent recovery guidance now also names the
  `phase_complete.policy: "warn"` config key as a last-resort remedy, and explains
  that an absent docs-participation receipt is recovered by a fresh docs dispatch
  that writes new durable completion proof.
- Documented that every QA-gate table entry — including `critic_pre_plan` — is a
  per-plan SQLite profile field configured via `set_qa_gates`/the gate-selection
  dialogue, not a key under the YAML `qa_gates` object (which is the unrelated
  guardrails config), and added a ratchet test proving `critic_pre_plan` cannot be
  silently turned off once enabled.
