---
issue: 2968
---

# Verification receipts substrate: portable, hash-backed gate records (#2968, Workstream J slot J22)

`/swarm receipt <task|phase> <id>` and the new `receipt` tool emit a portable
record of the durably recorded gate outcomes for a task or phase: bounded gate records
(id, outcome, responsible actor, evidence refs — digests only, never raw
command output), the snapshot hashes the gates were evaluated against
(plan-structure / policy / phase-evidence), and content-hashed artifact refs.
Receipts land under `.swarm/evidence/receipts/` as canonical JSON
(`format_version 1.0.0`, `receipt_hash` computed over the raw parsed object minus `receipt_hash` itself)
plus rendered Markdown; `--export` writes a self-contained PR-attachable
bundle (receipt + Markdown + byte-copies of every cited artifact) under
`.swarm/plan-export/receipt-<kind>-<id>-<shorthash>/`. `--verify` ships in
this same release (see the `swarm-receipt-verify` fragment).

Behind the scenes: a phase's bounded gate report is durably captured at the
successful commit boundary (content-addressed write-once, fail-open to phase
completion — a receipt failure never fails a phase whose gates passed), the
derived receipts subtree is excluded from the phase-evidence snapshot so
emitting receipts can never mutate the identity the gates enforce, and the
new durable stream is registered in the observability retention registry
(mixed privacy; newest-8 per unit; staged atomic export; exported plan-export
bundles are reaped at close, completing the row's keyspace-bound claim).

Documented limitations: hash-only integrity is spoofable by a determined
local actor or by a model willing to recompute every digest consistently
— receipts stop lazy falsification (persisted gate reports are RE-DERIVED
from their bytes at build and verify time, FB-004), and full integrity
against a recomputing forger needs an out-of-band capture-time anchor
(documented follow-up); receipts provide integrity against the model, not
the user's own machine; absent `command`/`exit_code`/`output_digest` fields mean no
durable producer recorded them (omitted, never reconstructed); path
normalization is byte-exact forward-slashing without case-folding; there is
no historical backfill — phases completed before this feature have no
captured report and emit a clear error.
