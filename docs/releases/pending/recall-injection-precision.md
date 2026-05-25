# Recall injection precision

## What changed

- Split manual memory recall from automatic prompt injection with a new internal recall mode and injection-specific defaults.
- Automatic injection now requires a real query signal by default and records skip reasons in the per-run memory log.
- Recall results now carry scoring signal diagnostics for text, tag, file, symbol, kind, and scope matches.

## Why

Automatic memory injection needs a stricter eligibility bar before persistent storage makes memory larger. Manual `swarm_memory_recall` remains permissive for debugging and inspection.

## Migration

No migration is required. Existing memory config continues to parse; use `memory.recall.injection.enabled=false` to keep memory tools available while disabling automatic prompt injection.

## Breaking changes

None.
