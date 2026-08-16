# Normalized knowledge outcome and source semantics

## What

- Defines one typed terminal contract — `ReceiptOutcome`
  (`applied | ignored | contradicted | violated | n_a`) and the canonical
  `source` taxonomy (`delegate`, `reviewer`, `architect`, `architect_marker`,
  `test_engineer`, `phase_override`, gate escape-hatch sources, `manual`,
  `migration`, `unknown`) — declared once in
  `src/hooks/knowledge-receipt-ledger.ts` and consumed by the validator,
  collectors, gates, rollups, scoring, curation, and diagnostics.
- Stamps `source: 'delegate'` on every new delegate terminal in both the
  authoritative V2 ledger and the diagnostic event dual-writes (previously
  only silent unacknowledged events carried it; explicit terminals recorded
  an agent name or nothing).
- Migrates architect and spec-writer prompt guidance (plus the coder,
  reviewer, and test-engineer receipt-tool guidance) so a directive that
  does not apply is answered with reasoned `KNOWLEDGE_N_A` (neutral) instead
  of `KNOWLEDGE_IGNORED` (negative). `IGNORED` is reserved for
  applicable-but-deliberately-not-followed and keeps its policy consequences.
- Adds a reasoned `n_a` items array to the `knowledge_receipt` tool and
  removes `not_relevant` from its ignore-reason enum, so filing a
  non-applicable entry no longer requires the negative `ignored` channel.
- The `KNOWLEDGE_ENFORCE_GATE_DENY` message now lists the accepted
  `KNOWLEDGE_N_A` marker form (the gate already honored it mechanically).
- `knowledge_receipt_transition` telemetry gains `receiptSemantics`
  (currently `2`), versioning the outcome/source meaning contract
  independently of the journal `schemaVersion` format gate.

## Why

The same outcome word meant different things per producer: prompts steered
mere irrelevance into `IGNORED` while scoring, ranking, and curation treated
`ignored` as negative, so routine non-applicability damaged knowledge
ranking, promotion, demotion, and skill generation. Delegate terminal
emissions omitted `source: 'delegate'`, blocking source-aware rollups and
policy. The vocabulary was declared piecemeal with divergent members.

`n_a` clears only the acknowledgement/applicability obligation: it never
proves application, never produces promotion evidence, and never satisfies
high-risk acceptance alone. Delegate self-report remains non-independent —
enforced by the promotion gate, which counts only evidence whose receipt
source is present and not `delegate` toward
`promotion_min_terminal_applications` when that gate is active;
reviewer adjudication and deterministic test/evidence keep their distinct
verification roles. Terminal `source` values are normalized to the canonical
taxonomy at every ledger commit boundary; out-of-taxonomy or legacy agent-name
sources (e.g. pre-#2032 `'coder'` strings) persist as the honest `unknown`
class — never a hard reject, and never inferred to a canonical class.

## Migration

No manual action is required and no data is rewritten. Historical
`IGNORED` records (including any with `reason: not_relevant`) keep the
meanings they were written with and still count as they always did. Legacy
records with an absent source stay typed `unknown` — never coerced to
`delegate`, `ignored`, or zero. One documented asymmetry is preserved by
design: the legacy `knowledge-application.jsonl` audit log has no `n_a`
result value and stores it as `acknowledged`; the V2 ledger and the
diagnostic event log store `n_a` verbatim. Agents still sending
`ignored` with `reason: not_relevant` to the `knowledge_receipt` tool now
get a loud schema rejection steering them to the `n_a` array — that is the
intended atomic migration, not an error state.
