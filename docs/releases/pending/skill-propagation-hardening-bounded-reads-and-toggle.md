# Skill propagation hardening: bounded reads, log compaction, and config toggle

## What changed

- Hardened `readSkillUsageEntriesTail` to clamp caller-provided `maxBytes` to the bounded tail budget (`MAX_TAIL_BYTES`).
- Added size-based best-effort compaction trigger in `appendSkillUsageEntry`: when `.swarm/skill-usage.jsonl` grows beyond 1MB, it now runs `pruneSkillUsageLog(..., 500)`.
- Clarified the scoring skip message in `skill-propagation-gate.ts` to explicitly state the limit applies to the bounded tail window.
- Added a new `skillPropagation` config schema section with `enabled` (default `true`) and wired `src/index.ts` to honor it for both:
  - task-time skill propagation gate, and
  - chat transform compliance scan.

## Why

- Prevents future callers from accidentally bypassing bounded tail-read guarantees.
- Adds automatic compaction for long-lived repositories where skill usage logs can grow indefinitely.
- Avoids misleading operator logs by clarifying that the entry count check is windowed.
- Makes skill propagation behavior configurable instead of hardcoded on.

## Migration / compatibility

- Backward compatible: default behavior remains enabled.
- To disable skill propagation:

```json
{
  "skillPropagation": {
    "enabled": false
  }
}
```

## Caveats

- Compaction is best-effort and runs opportunistically on append after the 1MB threshold is crossed.
