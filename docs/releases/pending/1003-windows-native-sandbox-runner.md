# Windows Native Sandbox Runner

## What

Introduces `swarm-sandbox-runner`, a native Rust executable that provides real
OS-level process sandboxing on Windows via AppContainer (preferred) or restricted
token + Job Object (fallback). The runner is invoked as a bounded subprocess by
the plugin, replacing the PowerShell-only environment scrubbing approach.

New components:
- `runners/swarm-sandbox-runner/` — Rust crate with dual-mode sandbox
- `src/sandbox/win32/runner-client.ts` — TypeScript IPC client
- `src/sandbox/win32/native-sandbox-executor.ts` — new executor (runner-first, PowerShell-fallback)
- `binaries/win32-{x64,arm64}/` — precompiled signed binaries (committed)

## Why

The previous Windows sandbox (`restricted-token-executor.ts`) only performed
environment variable scrubbing — no true process isolation, no Job Object
containment, no filesystem ACL enforcement, no network lockdown. This was
flagged as MAJOR DRIFT in the v6.28.2 retrospective.

The native runner provides:
- **AppContainer** isolation (capability SID, implicit-deny filesystem)
- **Restricted token** fallback (DISABLE_MAX_PRIVILEGE, removed dangerous SIDs)
- **Job Object** containment (KILL_ON_JOB_CLOSE, memory cap, active process cap)
- **Temp directory size cap** (250ms polling, kill on exceed)
- **Wall-clock timeout** enforcement
- **Path stub injection** (ssh/curl/wget blocked)
- **Private desktop** (UI spoofing defense)
- **NDJSON event stream** for structured observability

## Migration

No breaking changes for existing users:
- Plugin init remains bounded and fail-open per Invariant 1
- If the runner binary is missing, the executor degrades to `windowsSandbox: weak`
  (PowerShell wrapper), exactly as before
- The `SandboxExecutor` interface is preserved
- Existing tests continue to pass

New public surface:
- `executor.strength` — `'strong'` | `'weak'` | `'none'`
- `executor.hasNativeRunner` — boolean
- `executor.probeResult` — capability matrix from the runner

## Caveats

- The runner binary must be present in `binaries/win32-{arch}/` for strong sandbox
- AppContainer requires Windows 10 1703+ (Build 15063); older Windows falls back
  to restricted token mode
- `CreateProcessAsUserW` may require `SeAssignPrimaryTokenPrivilege` on some
  enterprise-locked systems; the runner detects this and degrades gracefully
- The temp watcher polls at 250ms intervals, so brief quota spikes under ~250ms
  may not be caught
