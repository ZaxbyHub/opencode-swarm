# Issue #1234 WP7: Post-mortem agent (`curator_postmortem`)

## Overview

New `curator_postmortem` agent completes the curator cadence: `curator_init` (session start) -> `curator_phase` (phase end) -> `curator_postmortem` (project end). Read-only, optional, model-overridable — same roster pattern as the other curators.

## Agent registration

- `CuratorRole` type extended: `'curator_init' | 'curator_phase' | 'curator_postmortem'`
- `ROLE_CONFIG` entry with baked-in `CURATOR_POSTMORTEM_PROMPT`
- Registered in `ALL_SUBAGENT_NAMES`, tool map (`swarm_memory_recall`), default model (`gpt-5-nano`), fallback model, and agent factory
- Gated by `curator.postmortem_enabled` (default: true)

## Core logic (`src/hooks/curator-postmortem.ts`)

`runCuratorPostMortem(directory, options)` reads structured `.swarm/` evidence and produces `.swarm/post-mortem-{planId}.md`:

- **Knowledge metrics**: total entries, application/violation/ignored counts, never-applied entries, high-violation entries
- **Queue status**: pending proposals (insight-candidates, skill proposals) and unactionable quarantine counts
- **Retrospectives**: phase retrospective evidence summaries
- **Drift reports**: alignment status per phase
- **Curator digest**: running digest from curator_phase
- **LLM delegate**: optional — when available, sends assembled context to the `CURATOR_POSTMORTEM_PROMPT` for richer synthesis; falls back to data-only report on failure

## Triggers

1. **Automatic at project end**: `phase_complete` detects all phases complete and auto-fires
2. **`/swarm finalize` step**: runs during finalize after curation, before archive
3. **On demand**: `/swarm post-mortem [--force]`

## Idempotency and safety

- Dedup-protected: if report exists for the same plan ID, skips (unless `--force`)
- Fail-open: errors never block `phase_complete` or `finalize`
- Outputs route through existing gated paths only (no new ungated injection)
- Config-gated: `curator.postmortem_enabled: false` disables all behavior
