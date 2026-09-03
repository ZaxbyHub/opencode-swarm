# Make receipt-less gate-evidence repair recoverable

## What changed

- `repair_gate_evidence` now refuses new receipt-less reconstruction when no
  authoritative gate requirements can be recovered, leaving the original
  evidence and session state unchanged.
- Receipt-backed legacy `requirements_reconstruction` wedges and the exact
  sentinel-only, gate-proof-free reset emitted by the historical repair flow
  (with its source digest and older optional source generation) can recover
  through the same registered tool. Recovery preserves receipt-backed
  real gates, treats marker-tainted receipts as uncertain, clears stale proof,
  and requires a fresh coder mutation settlement and QA sequence. Every other
  receipt-less marker artifact is refused atomically as ambiguous.
- A fresh accepted mutation retires only the obsolete internal marker before
  emitting requirements receipts, while every real gate remains append-only.
- Completion errors now identify this legacy wedge and name its supported
  recovery sequence.
- Coder-settlement replay now restores a missing accepted-mutation requirements
  receipt before committing the WAL, closing the crash window between evidence
  publication and receipt publication without duplicating no-mutation receipts.
  Evidence repair detects this receipt-only crash state and refuses to demote
  the already-clean evidence while settlement replay remains authoritative.

## Why

Older receipt-less repairs stored an internal reconstruction marker as though it
were a real QA gate. No agent could satisfy it, and append-only gate expansion
copied it into later evidence generations and requirements receipts, permanently
blocking otherwise valid completion.

## Migration

No manual file editing is required. If completion reports a legacy receipt-less
gate-repair marker, run `repair_gate_evidence` for that task, delegate coder for
a fresh accepted mutation, and rerun Stage A and the
required Stage B gates.
