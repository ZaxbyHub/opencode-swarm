# ADR 0001: Defer Microsoft MXC as an optional sandbox backend

- **Status:** Deferred (re-evaluate on the triggers below)
- **Date:** 2026-09-03
- **Deciders:** opencode-swarm maintainers (workstream B, issue #2475)
- **Resolves:** #1148 (research track), as part of #2475 (obligation 6)

## Context

opencode-swarm enforces shell containment per-platform today: a Rust
`swarm-sandbox-runner` (AppContainer / restricted token) on Windows, seatbelt
(`sandbox-exec`) on macOS, and bubblewrap on Linux. Each backend is wired
directly, which is exactly where per-platform complexity accumulates.

Issue #1148 researched Microsoft MXC
([github.com/microsoft/mxc](https://github.com/microsoft/mxc)) as a local,
cross-platform, policy-driven alternative: TypeScript SDK (`@microsoft/mxc-sdk`,
ESM-only, Node >= 18), JSON policy configuration, filesystem/network policy,
one-shot and state-aware execution APIs, stable one-shot backends for Windows
(`processcontainer`) and Linux (`bubblewrap`, `lxc`).

The same research, verified against Microsoft's own documentation, found MXC is
**public preview / early integration code**; Microsoft states generated policies
may currently be overly permissive and that **MXC profiles should not yet be
treated as security boundaries**. The macOS `seatbelt` backend is listed among
experimental backends. MXC's versioning document also records an open question
where a caller passing `--experimental` can weaken the boundary.

## Decision

**Do not adopt, integrate, or prototype-wire MXC now. Defer, with explicit
re-evaluation triggers.**

Rationale: adopting a self-described non-security-boundary as a security
boundary would weaken the guarantees this workstream exists to ship. Our
existing per-platform backends are kernel-enforced (AppContainer/restricted
token, seatbelt, bubblewrap) and, as of #2475, actually reach users.

Non-goals carried forward from #1148:

- **MCP tool enforcement stays out of scope.** Guardrails wrap the `bash` and
  `shell` tool names (see the tool-name gating in
  `src/hooks/guardrails/tool-before.ts`); OpenCode triggering plugin hooks
  around MCP tools does not make arbitrary MCP tool execution uniformly
  sandboxable. Any future MCP sandboxing needs its own design.

## Re-evaluation triggers

Revisit this decision when ANY of the following holds:

1. Microsoft marks MXC profiles as a **security boundary** (not merely
   "preview isolation"), including the `--experimental` weakening question
   being resolved.
2. MXC reaches a stable schema GA (>= 1.0 semantics) with the documented
   stable schema authoritative for runtime security defaults.
3. The macOS backend is no longer experimental, OR we consciously accept
   Windows/Linux-only coverage for an optional MXC backend while keeping the
   native backends default.
4. MXC's Node/ESM floor and packaging (native binaries under `bin/`) meet our
   runtime-portability invariants (AGENTS.md invariant 2: Node-ESM-loadable,
   OpenCode Desktop Node sidecar compatible).

If triggered, prefer adoption as an **opt-in backend** behind a config flag
alongside the native executors, never a default, and it must pass the same
capability-probe/refusal contract the native backends satisfy
(probe handshake, visible downgrade, required-mode refusal).

## Consequences

- The per-platform backend complexity remains ours to maintain; the `SandboxExecutor`
  interface (`src/sandbox/executor.ts`) stays the seam where a future MXC
  backend would plug in.
- #1148 closes as researched-and-deferred by this ADR; no unwired integration
  code ships.
- Re-evaluation is event-driven (triggers above), not calendar-driven.
