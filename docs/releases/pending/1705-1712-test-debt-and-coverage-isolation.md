Fixed the deterministic unit-test quarantine backlog and hardened merge-queue coverage measurement:

- Removed every active entry from the repo-wide quarantine list after making the affected tests pass unquarantined.
- Hardened mock- and state-sensitive test clusters with restorable `_internals` seams, isolated environment state, and deterministic temp-root handling.
- Fixed Windows coverage-run stability for subprocess timeouts, real-git fixtures, command-availability probes, and Go impact-analysis module caching.
- Switched merge-queue coverage to Bun isolation so file-scoped mocks cannot contaminate later test files.
