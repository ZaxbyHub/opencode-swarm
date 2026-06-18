# Council Gate Overhaul

## Breaking Changes
- `council_general_review` QA gate removed. General Council is now an early workflow option in MODE: BRAINSTORM and MODE: PLAN before `save_plan`, not a QA gate.
- `council_mode` behavior changed: now replaces per-task Stage B (reviewer + test_engineer) with the full 5-member council. Previously was additive at the phase level.

## New Features
- `phase_council` QA gate: full 5-member council reviews all work in a phase holistically at phase_complete time.
- General Council advisory input offered as Phase 1b in MODE: BRAINSTORM and before `save_plan` in MODE: PLAN when council.general.enabled is true.
- QA gate selection section unified: gates, parallel coders, commit frequency, and auto_proceed presented together.

## Clarifications
- `final_council` explicitly documented as using the full 5-member council, not the General Council.
- Three council modes clearly distinguished: council_mode (per-task), phase_council (per-phase), final_council (per-project).

## Migration Notes
- Supersedes the `council_general_review` gate introduced in v7.0.0 and the council additive semantics from v7.3.1. Old profiles with `council_mode: true` are automatically migrated to include `phase_council: true` to preserve the previous phase-level council behavior.
