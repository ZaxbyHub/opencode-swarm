# Cross-platform contributor CI gates

The six remaining contributor-facing quality gates now run through native Bun/TypeScript entry points, so Windows PowerShell users can execute the same checks as CI without installing or configuring Bash:

- `bun run check:mock-cleanup`
- `bun run check:invariants`
- `bun run check:cross-contamination`
- `bun run check:test-clock`
- `bun run check:test-tmpdir`
- `bun run check:bash-portability`

CI uses these commands directly on every supported runner. The historical `.sh` paths remain as zero-logic compatibility shims for existing automation, while the gate-portability guardrail now rejects policy logic added to any migrated shim. All six legacy portability exemptions were removed; only runner-internal CI infrastructure remains baselined.

No gate policy, threshold, or enforcement default changes as part of this migration. Existing local workflows may continue using the shell shims on Bash-capable systems, but the Bun commands are the portable preferred interface.
