---
title: Close the deferred #2131 hardening items (C, D, E, F, G + residual B)
type: fixed
---

## fix(skills): feedback terminal model, trace gates, merge-sim safety, publication evidence, skill closure (follow-up to #2156)

Second child PR of tracking issue #2131. Closes criteria C, D, E, F, the residual
criterion-B obligations, and the drift items of G; the physical line-reduction of the
three oversized entry skills remains tracked on #2131 (now enforced one-way by a ratchet).

### PR-feedback terminal & history model (criterion C)
- **verified-no-change terminal**: a fully DISPROVED / PRE_EXISTING / NEEDS_MORE_EVIDENCE /
  NEEDS_USER_DECISION inventory now completes with ZERO commits — no more dead-end demanding
  an empty commit. HEAD must equal the intake head, the tree must be clean, and an audit
  event records the outcome.
- **rebind_pr_feedback_head** (new tool): controlled base-sync transition after
  merge/rebase/conflict repair. It moves the immutable intake head to a new verified PR
  head, preserves the immutable inventory, and invalidates Stage A, verification, and gate
  receipts so the full mechanical ladder re-runs on the new ancestry. Refuses no-op
  rebinds, armed gates, and in-flight lanes.
- **Typed proof kinds**: Stage A `feedback_targets` rows now carry `proof_kind`
  (defect | metadata | source-proof | conflict | ci | user-decision); the skill honestly
  describes the mapping as structural + typed, with Stage B owning causality.
- End-to-end tests for the no-change terminal (per classification), diverged/dirty
  refusals, receipt invalidation on rebind, and armed/no-op/checkout refusals.

### Issue-trace full-resolution composition (residual criterion B)
- The trace engine now mechanically composes the two remaining Full-Resolution Contract
  obligations before the commit-pr handoff: an issue-bound **implementation-review receipt**
  (fresh-context reviewer AND critic APPROVE; `record_implementation_review` tool) and a
  **recurrence-sweep receipt** (defect class, predicates, hit dispositions, guardrail proof,
  or the justified "no defect class" fast path; `record_recurrence_sweep` tool). Each
  missing gate emits a one-shot directive naming the tool; the handoff cannot fire without
  both receipts.

### Merge simulation & publication composition (criterion E)
- `ci-simulate` worktree cleanup is now **non-force**, **containment- and
  registration-verified**, and **fail-closed**: a blocked removal surfaces
  `WORKTREE CLEANUP BLOCKED` and fails the simulation instead of force-deleting.
- Base discovery resolves via origin/HEAD → init.defaultBranch → origin/main →
  origin/master **with existence verification** (fixes contributor forks with non-main
  defaults); nothing resolving fails closed with remediation guidance.
- The command registry entry no longer advertises unsupported `--base/--head` flags, a
  wrong worktree path, or an inflated validation suite.
- `ci-failure-batching` is now diagnosis/fix-planning only and composes **commit-pr**
  before any push; the `--force-with-lease` claim matches the actual guardrail (exempt,
  not blocked).

### Publication evidence & CI parity (criterion D)
- commit-pr Step 0 deletes **only the three exact publication-cache files** — never
  `.swarm/evidence/*.json` (task evidence, final-council, phase councils survive).
- New **versioned `publication-evidence.json`** receipt (schema_version, repository,
  HEAD sha, body sha256, validation commands, state, timestamp). The publication gate
  verifies it against the CURRENT git state and the EXACT body: stale HEAD or edited body
  is rejected (verified by adversarial dry-runs).
- commit-pr Tier 1 now teaches the **full blocking CI quality contract**; the parity test
  DERIVES the list from `.github/workflows/ci.yml`, so a new CI quality step fails the
  test until the skill teaches it.

### Packaged skill closure (criterion F)
- `orchestrating-subagents` and `durable-session-state` are now first-class bundled
  skills, so the bare dependencies in `swarm` / `swarm-ci-monitor` resolve for npm
  consumers.
- The runtime-closure test now validates bare backtick skill references and relative
  SKILL.md references inside every bundled skill — and caught **four latent unpackaged
  references** beyond the audit (reworded to non-loading mentions).

### Governance & drift (criterion G)
- `discover` records governance rules with provenance: source file, subtree scope,
  precedence, MUST/SHOULD strength, and conflict state — conflicting rules are surfaced,
  never flattened.
- CI adapter skills are capability-first (hardcoded MCP names marked example-shape only,
  resolved via ToolSearch by capability).
- `/swarm sdd status` prints the exact effective-spec path(s) and a derived
  allowed-mutations policy; `brainstorm` no longer shadows non-native specs.
- **Progressive-disclosure ratchet**: the three oversized entry skills are documented,
  tested one-way baselines with mandatory `references/` directories.

New tools: `rebind_pr_feedback_head`, `record_implementation_review`,
`record_recurrence_sweep`. The ordinary exactly-one-reviewed-commit publication path is
unchanged.
