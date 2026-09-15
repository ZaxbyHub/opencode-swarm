# Stable architect prompt-cache prefixes (#2759)

## What

- Moved session-bound architect enhancer guidance and the conditional `/swarm`
  command rule to a trailing, host-renderable user-role carrier.
- Preserved the byte-identical conversation prefix across architect turns while
  retaining the existing strict Qwen/Gemma system-rendering boundary.
- Added compaction-aware one-shot suppression so live-turn guidance is not copied
  into compaction summaries.

## Why

Per-step architect guidance was changing the host's cache-sensitive system tail,
which prevented prompt-cache reuse even when the conversation history was
unchanged. The new request-boundary staging follows OpenCode's actual
`messages.transform`-before-`system.transform` order and keeps dynamic guidance
renderable without polluting the stable prefix.

## How to use

No configuration or workflow changes are required.

## Migration notes

None required.
