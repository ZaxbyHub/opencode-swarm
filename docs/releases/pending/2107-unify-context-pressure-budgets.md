---
title: 'Unify context pressure, injection budgets, and summary continuity'
issue: 2107
---

# Unify context pressure, injection budgets, and summary continuity (issue #2107)

Guardrail remediation 11/12. Closes #1616, #1617, and #1649; references #1619
(evidence posted there; closed as not-a-defect — fresh-output re-injection is
required and this PR implements same-surface idempotency only).

## One canonical token estimator (closes #1616)

Every char→token (and token→char) conversion now routes through one module:
`estimateTokens` / `estimateTokensFromCharCount` / `estimateCharsForTokens` in
`src/hooks/utils.ts` (0.33 tok/char heuristic; provider-reported usage stays
authoritative). Replaced independent/divergent ratios in: injection-budget
(×0.33 copy), context-budget-service (÷3.5 — the user-facing budget report
previously disagreed ~15% with injection admission on the same text), capsule
persistence (÷4), run-memory, knowledge-injector, context-usage, repo-graph
query (÷3.5), skill-improver and the skill-improve tool (÷4), and extractors
(×4 inverse). A new Check 7 in `scripts/check-invariants.ts` hard-fails on any
NEW inline char/token formula, with a justified allowlist (the binary
serialization-size heuristic in context-usage). Numeric behavior shifts on the
former ÷3.5/÷4 paths are intended corrections of underestimates; affected test
pins were migrated with explicit migration notes.

## Per-session/per-turn producer ledger (closes #1617)

The FR-002 "unified budget" stateful ledger — which shipped with zero
production callers — is replaced by a real producer ledger. The
system-enhancer begins it exactly once per request composition; context
capsules and memory recall CLAIM from it and feed the GRANTED amount into
their existing packers (`max_capsule_tokens`, `recall.injection.tokenBudget`);
the advisory queue, the swarm-command banner, and the context-budget warning
record their emissions as fixed/base content. Requested/granted/emitted/
truncated reconcile per producer; state is FIFO-bounded (256 sessions) and
reset on `experimental.session.compacting`. When the ledger is absent
(native-agent turn, first turn, hook disabled) capsule/memory fail open to
their local caps and log that the unified hard ceiling was unavailable —
exactly #1617's contract. Hook composition order (advisory drain < memory <
knowledge < consolidation < final accounting; system-enhancer < capsule) is
pinned by `tests/unit/hooks/hook-composition-order.test.ts`.

## Truthful final pressure reporting (issue #2107 §3)

A new final context-accounting step runs after consolidation in
`messages.transform`. It measures the actual final model-visible surface
exactly once — `output.messages` via provider-preferring usage, PLUS the
system chain's `output.system` bytes from ledger emissions (messages-surface
producers are attribution-only, never double-counted) — against the same
model limit physical pruning resolves (`model_limits` overrides → live
`model.limit.context` → static table → 128K floor). The snapshot lands in
`swarmState.finalPromptPressureBySession` (bounded, per-session) and `/swarm
status` renders it as **Prompt pressure (final)**. The legacy
`[SWARM INJECTION FOOTPRINT]` signal is still reported but explicitly labeled
as an intermediate per-turn injection measurement, not window usage. The
compaction tiers and the one-shot CONTEXT PRESSURE advisory now read the
final-pressure percentage (falling back to the footprint pct before the
accounting step has run). The warning the step emits is bounded, advisory-only
("this message removed no content"), once per session per band, and its own
token cost is recorded into the ledger and the total — it cannot escape
accounting.

## Accurate compaction language (issue #2107 §4)

Compaction tiers now say `[CONTEXT COMPACTION ADVISORY — …]` /
"Estimated prompt pressure is ~N% of the model window. Consider compacting
now (advisory — nothing has been compacted yet)." They never claim a
compaction was initiated or completed; only the physical pruning in
`context-budget.ts` removes content, and it already records exactly what was
pruned/masked. `experimental.session.compacting` advances the accounting
generation so post-compaction requests never ride stale per-turn claims.

## Head+tail summaries (issue #2107 §5)

Tool-output summaries keep a bounded head AND tail: leading non-blank identity
lines plus trailing raw outcome lines (compiler/test/lint/security verdicts
live at the end of output and were previously discarded), with accurate
`[... N lines omitted ...]` markers, a per-line character cap for oversized
single lines, and codepoint-safe UTF-8 byte caps in `createSummary`
(multibyte content can no longer slip past the budget, and surrogate pairs
are never split). No lines are reordered within a segment and no outcome is
invented; full output remains retrievable via `/swarm retrieve`.

## Prompt guard completion (closes #1649)

A synthetic-`ProjectContext` end-to-end test now fails if any uppercase
`{{TOKEN}}` survives substitution in any built agent prompt (with quote/
backtick/`${}`-bearing values), and the four growth-encouraging prompt-length
lower-bound assertions were removed (each was strictly implied by a stronger
`toContain`/`toStartWith` on the same prompt, or replaced by a direct
100KB-injection assertion). The 160K architect ceiling (#2196) and all
hardening prose are unchanged.

## Safe idempotency (issue #2107 §7; references #1619)

Dedup remains same-surface only: a block is skipped only when its sentinel is
already in the CURRENT composed message array; a fresh next-turn surface
always receives the block again, and compaction re-injection continues to
work. No cross-turn hash suppression exists or was added.

## Rollback / migration notes

- All ledger state is ephemeral per-turn; no durable migration.
- `context_budget` config keys are unchanged (no user-facing `budget_tokens`
  key ever existed; the built-in 40K default was replaced by model-window
  resolution in an earlier release — no user-specified meaning changed).
- Rolling back cannot leave suppression state behind: the final-accounting
  warning band flags are in-memory per session, and no durable dedup state
  was introduced.
