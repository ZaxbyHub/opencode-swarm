# PR workflow checkout and coverage deadlock fixes

## What

- PR feedback now prefers an exact local tracking checkout. When intake is
  already detached at the authoritative full PR head SHA, the controller
  attaches one unambiguous exact local/remote tracking ref under a project-wide
  mutation lock, while ambiguity, mismatched upstreams, linked worktree
  ownership, and persistence failures remain fail-closed and retryable.
- PR review trigger receipts now distinguish applicable `MATCHED` families
  from provenance-free `NOT_TRIGGERED` families. Only matched families launch
  micro lanes; strict schema-v2 counts and provenance are shared by dispatch,
  persistence, and gate readers. The first micro dispatch freezes the exact
  ledger (classifications and evidence) across every later micro dispatch; the
  final receipt re-validates per-family classifications against the frozen
  ledger but does not require byte-identical evidence, while legacy
  v1/unversioned reads remain preserved.
- Candidate ingestion and workflow coverage now share one semantic row
  contract for exact marker headers and fields, fenced-content isolation,
  severity/confidence enums, escaped pipes, base and micro CLEAN attestations,
  and lane ownership. Malformed artifacts produce batch/lane/output/row/field
  diagnostics instead of silently losing coverage.
- Explorer prompts always receive the controller output contract even when the
  caller casually mentions `[CANDIDATE]`, and header-only base CLEAN output is
  no longer treated as attested.

## Why

Detached feedback intake could not safely transition to a tracking checkout,
and structurally pipe-shaped but semantically invalid candidate rows could make
review coverage appear missing without explaining the malformed field. The
old all-matched trigger model also launched irrelevant micro work and could not
represent an evaluated-but-inapplicable family.

## Migration

New trigger receipts use schema version 2. Producers must send exactly eleven
rows, keep `unclassified-risk` matched, add source batch/lane provenance only
to `MATCHED` rows, and omit provenance entirely from `NOT_TRIGGERED` rows.
Historical all-matched receipts remain readable.

Candidate confidence is now the documented `LOW | MEDIUM | HIGH` enum (not a
numeric score), and both base and micro lanes must emit a populated `[CLEAN] |
workflow_lane | coverage_scope | evidence` row when they find no candidates.

## Caveats

Feedback attachment intentionally refuses to choose among multiple exact refs
or replace an existing mismatched upstream. Resolve that ambiguity explicitly,
then retry the first bind; no workflow state is published before validation.
