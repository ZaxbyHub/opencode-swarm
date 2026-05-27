# Architecture Supervision — Opt-in Phase Gate (Chunk D)

## What changed

- **New phase-complete gate** (`src/tools/phase-complete.ts`): when
  `architectural_supervision.enabled` and `mode: 'gate'`, `phase_complete` now reads the
  architecture-supervisor sidecar (`.swarm/evidence/{phase}/architecture-supervisor.json`)
  and blocks completion on a missing/invalid/future/stale verdict, a phase mismatch, a
  REJECT verdict, or — when `allow_concerns_to_complete` is false — a CONCERNS verdict.
  Mirrors the existing phase-council gate (24h freshness window, fail-closed on error).
  Advisory mode (the default) bypasses the gate entirely.

## Why

Fourth step of issue #893: lets teams optionally make the architecture supervisor a hard
quality gate, not just an advisory reviewer.

## How to use

Set `architectural_supervision: { enabled: true, mode: 'gate' }`. Then at phase
completion, dispatch `critic_architecture_supervisor`, persist its verdict with
`write_architecture_supervisor_evidence`, and `phase_complete` will enforce it. Keep
`mode: 'advisory'` (default) for non-blocking behavior.

## Migration

No migration required; gate mode is strictly opt-in and off by default.

Refs: #893
