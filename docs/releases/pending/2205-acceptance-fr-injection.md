# Delegation gate injects verbatim FR/SC requirement text into ACCEPTANCE

## What changed

The delegation gate now guarantees verbatim `FR-###`/`SC-###` requirement fidelity programmatically (issue #2205). When a coder/reviewer dispatch's ACCEPTANCE field does not already cover every spec requirement the plan task maps to (via `fr_refs`), the gate appends the exact requirement body from `.swarm/spec.md` — prefixed with its id, inside the ACCEPTANCE section — to the dispatched prompt **before** the downstream agent runs, mutating the tool-call arguments in place.

Consequences:

- The architect no longer needs to byte-for-byte copy requirement bodies into ACCEPTANCE. Listing the mapped ids (e.g. `ACCEPTANCE: FR-007, FR-012`) is sufficient; the architect/coder/reviewer prompt templates now say so. Pasting the full bodies yourself still works (no duplicate injection).
- Exception: phase-council and final-council dispatches (multi-task) are NOT covered by automatic injection — the gate only resolves a single task id, so it can't tell which task's spec text belongs to a multi-task dossier. Those prompt templates still require the architect to paste the verbatim FR/SC text by hand.
- Dispatches that previously failed with `ACCEPTANCE_FIELD_COVERAGE_MISMATCH` (id-only, paraphrased, partially-copied, or flattened acceptance text) now dispatch, with the verbatim text injected.
- `ACCEPTANCE_FIELD_REQUIRED` (empty/missing ACCEPTANCE line) is still enforced fail-closed.
- The `ACCEPTANCE_FIELD_COVERAGE_MISMATCH` error remains as defense-in-depth (built by the new exported `buildAcceptanceCoverageMismatchError`), though the gate-side injection makes it structurally unreachable in the normal flow.

## Why

LLMs are biased toward summarization; relying on the architect to copy requirement text byte-for-byte caused repeated `ACCEPTANCE_FIELD_COVERAGE_MISMATCH` blocks, wasted tokens, and stalled workflows. The framework already held all the data needed (task `fr_refs`, spec bodies) to guarantee fidelity itself.

## Migration

No migration required. Old-style prompts that paste verbatim bodies dispatch unchanged (injection is a no-op when every mapped id is already covered).
