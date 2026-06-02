# Deep-Dive Audit Remediation (Issue #1095)

## What changed

- **Removed redundant test**: Deleted `verify-six-tools-registration.test.ts` — full coverage exists elsewhere via `tool-registration-conformance.test.ts` and `constants.test.ts` parity checks.
- **Trimmed deprecated command aliases**: Removed 5 deprecated entries (`config-doctor`, `doctor`, `plan`, `evidence-summary`, `list-agents`) from `SWARM_COMMAND_TOOL_COMMANDS` enum in `tool-policy.ts`. Human-only commands preserved for error messaging.
- **Added `knowledge_recall` to test_engineer tool map**: Test engineers can now recall knowledge entries for context-aware test generation. Only the read-only `knowledge_recall` was added (not `knowledge_add`).
- **Clarified architect prompt for spec_writer delegation**: Updated prompt text at `architect.ts:496` to explicitly state the architect lacks the `spec_write` tool and must delegate to the `spec_writer` agent.
- **Extracted phase-complete gates into separate modules**: Split the 2392-line `phase-complete.ts` monolith into 7 independent gate modules under `src/tools/phase-complete/gates/` following the `pre-check-batch.ts` pattern. Each gate (completion-verify, drift, hallucination, mutation, phase-council, architecture-supervisor, final-council) is now a pure function accepting `GateContext` and returning `GateResult`.
- **Consolidated path validation in `update-task-status`**: Replaced inline null-byte, Windows device path, and path traversal checks with a single `resolveWorkingDirectory()` call, eliminating duplicate validation logic.
- **Added output size bounding to `phase-complete`**: Introduced `MAX_OUTPUT_BYTES = 512KB` with truncation marker following the `test-runner.ts` and `lint.ts` pattern, preventing unbounded JSON output from extremely large phase results.

## Why

Addressed 9 of 10 findings from a deep-dive audit of the tool wiring system. The monolithic `phase-complete.ts` was difficult to maintain and test; gate extraction improves modularity and reduces blast radius of future changes.

## Migration

No migration required. All changes are internal refactoring with no public API changes.

## Breaking changes

- Removed 5 deprecated command aliases from the `SWARM_COMMAND_TOOL_COMMANDS` enum. Any code directly matching these aliases will need to use the canonical names instead. This was already documented as deprecated behavior.

## Known caveats

- 1 of 10 deep-dive findings (DD-010/DD-018/DD-020) was explicitly deferred as out of scope for this PR.
- Some gate module imports use `.js` extensions for ESM compatibility with `moduleResolution=bundler`, while a few other imports in the same files omit the extension. Both forms resolve correctly with the project's tsconfig.
