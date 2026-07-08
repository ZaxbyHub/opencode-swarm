# QA gate docs claim drift

- Updated the public planning and LLM briefing docs to use the current 15-step QA gate count, including the `test-drift` check required by the execute protocol.
- Added a `docs-claim` detector to `bun run drift:check` so numeric QA-gate claims are compared against the importable `QA_GATE_PIPELINE_STEPS` registry.
- Added test coverage tying the docs-visible registry back to the runtime-loaded execute skill.

Migration: none.

Breaking changes: none.

Caveat: the count covers the docs-visible required or conditional QA gate sequence. Advisory `todo-scan` remains documented in the execute protocol but is not counted as a blocking public gate.
