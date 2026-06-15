# `feat(learning)`: auto-triage queues and success motif mining

## Summary

**Part 3 — Auto-triage the manual queues:**
- Added `/swarm knowledge unactionable` command to list the unactionable queue with pending/retire split
- Added `/swarm knowledge retry-hardening` command to reset `retire_candidate` flags for re-attempt
- Added learning queue counts (proposals, unactionable, insight-candidates) to `/swarm status`
- Added `insight-candidates.jsonl` FIFO cap at 500 entries using `transactFile` for atomic writes
- Added critic-gated `autoApplyProposals` in full-auto mode: LLM reviews each proposal, activates approved ones, deletes rejected ones, skips duplicates, batch-limited to 5

**Part 4 — Learn from success:**
- Added success motif mining: extracts recurring all-success tool sequences (≥3 steps, ≥2 tasks) from trajectories
- Mints `workflow`-type skill proposals with `skill_type: workflow` and `generated_by: macro_reflector_success` frontmatter
- Added `skill_type` support to `parseDraftFrontmatter` (skill-generator) and `parseSkillFrontmatter` (skill-scoring)
- Added workflow skill scoring boost (+0.1 additive, clamped to [0,1]) when `skill_type: workflow` and task context overlaps
- Wired success motif proposals into the skill-improver cadence

## User-facing changes

- `/swarm status` now shows learning queue depths when non-zero
- `/swarm knowledge unactionable` and `/swarm knowledge retry-hardening` are new commands
- Full-auto mode now auto-applies skill proposals via LLM critic gate
- Successful task patterns are now mined and proposed as workflow skills

## Migration notes

None required. All new functionality, no breaking changes.
