---
issue: 2909
type: docs
---

## Summary

Closes discovery slot #2909 (ADR-0003 + hook inventory for the OpenCode 2 plugin API, 2909-adr0003-v2-hook-inventory): the slot's remaining acceptance evidence now lives in the repository.

- **Dual-host spike evidence** (`spikes/v2-dual-shape/`): live runs of the real dual-shape build on opencode 1.19.0 and @opencode/cli 2.0.29, with entrypoint attribution proven by ablation (wrapper packages exporting the pristine default minus exactly one key: v1 loads without `setup` and drops without `server`; v2 loads without `server` and shows its literal decode error without `setup`), registered-hook firing on both hosts, and a reproducible harness (`run-spike.mjs`, `node spikes/v2-dual-shape/run-spike.mjs --measure`). Not shipped in the npm package (`package.json#files` allowlist).
- **First-turn window measured** (ADR-0003 appendix): on a real v1 host the first turn arrives 2575–3612 ms before the deferred bundled-skill sync finishes copying, and the model stream starts inside that window — the compensating assumption recorded with the deferred sync is false. Remedy follow-up filed as #3364.
- **Invalidation re-check recorded** (ADR-0003 appendix, 2026-10-16): the migration page still publishes no V1 compatibility shim for V2; the ADR is not invalidated.
- **Inventory re-anchored** (`docs/host/v2-hook-inventory.md`): the v1 `output.system` string surface and the `event.agent` normalization contract now have rows, plus a complete AGENTS.md invariant-10 sentence coverage map (every sentence of both paragraphs, with the tests that pin each).
- **New CI guardrail** (`tests/unit/host/v2/hook-inventory-coverage-2909.test.ts`): the coverage census (every registered hook key, every v2 ctx registration surface, every invariant-10 sentence token) and the acceptance-evidence durability (spike markers, ADR appendices, fragment-or-consumed trail) are enforced in CI, so the slot's contract cannot silently rot.

## Caveats

- v2 first-turn timing is not machine-measurable through this harness (v2's `--print-logs` carries no session lifecycle lines at the default level and does not relay plugin stdout); the v1 legs are the measurement of record and v2 shares the same deferred-sync code path.
- The v2 spike invokes the npm platform binary directly because this machine's npm allow-scripts policy blocks the `.cmd` shim's postinstall; behavior-identical (the postinstall only copies that binary into place).
