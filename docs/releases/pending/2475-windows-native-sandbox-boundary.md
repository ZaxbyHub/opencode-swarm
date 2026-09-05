# Ship and verify the Windows native sandbox boundary

## What

- The release pipeline now builds `swarm-sandbox-runner` for **both Windows
  architectures** (x64 on `windows-latest`, arm64 on `windows-11-arm`) and
  stages the executables into `binaries/win32-x64/` and
  `binaries/win32-arm64/` before `npm publish` — the package paths
  `findRunnerBinary()` discovers. Until now `binaries/` shipped only
  `.gitkeep` placeholders and the advertised native sandbox never reached
  users. The npm tarball grows by the two runner executables (roughly 1-3 MB
  each, release profile with strip+lto).
- `findRunnerBinary()` gained the packaged-layout candidate (one directory
  above the compiled `dist/index.js` bundle = package root). The historical
  candidates only resolved from the TypeScript source tree; from the installed
  package they pointed above the install root and could never find the shipped
  exe.
- `package:smoke` now validates the sandbox binary contract: the
  `binaries/win32-<arch>/` directories must always ship, and with
  `SWARM_PACKAGE_SMOKE_REQUIRE_BINARIES=1` (set by the release workflow) both
  runner executables must be present and plausibly sized — a release can no
  longer ship without them. Windows CI additionally builds the runner, stages
  it exactly as the release does, npm-packs, extracts, and executes the
  SHIPPED artifact's `--probe` from the packed layout (validating tarball
  inclusion, the discovery-path contract, and the probe protocol) on merge
  groups and on PRs that touch platform-sensitive paths.
- Sandbox environment hardening (`getEnvOverrides()`) is now wired for Windows
  and Linux, not just macOS (#2259):
  - the strong native-runner path carries null (unset) overrides in a new
    `env_unsets` policy field (removed from the allowlist), and the runner
    applies them after the allowlist copy and before its managed PATH/TEMP/TMP
    rewrites — so a nulled key is never inherited verbatim, the sandboxed
    stub-shadowed PATH keeps ordinary commands working, and LD_PRELOAD/DYLD_*
    are genuinely absent from the child environment;
  - the weak PowerShell wrapper applies per-call overrides BEFORE its own
    scoped TEMP/safe PATH assignments (matching the documented contract — the
    previous ordering would have stripped the scoped temp and broken multiline
    commands once wired);
  - Linux bubblewrap declares `{}` (bwrap enforces via CLI flags), so the
    unified wiring is a no-op there.
- Probe protocol handshake: the runner's `--probe` output now includes
  `runner_version` and `protocol_schema_version`; the TypeScript client
  refuses binaries reporting a different or missing protocol version (stale or
  PATH-shadowed foreign runners) and treats them as unavailable.
- Downgrades are now visible without `OPENCODE_SWARM_DEBUG`: a missing,
  corrupt, wrong-arch, or protocol-mismatched runner, the strong→weak
  PowerShell fallback, and advisory-mode unsandboxed execution all emit
  `criticalWarn` lines, and `/swarm diagnose` shows the downgrade reason on
  the sandbox health line.
- MXC resolution: ADR 0001 (`docs/decisions/0001-mxc-sandbox-backend.md`)
  defers Microsoft MXC as an optional backend with explicit re-evaluation
  triggers; MCP tool enforcement stays out of scope. Closes #1148 honestly as
  researched-and-deferred.

## Why

Issue #2475 (workstream B, PR 2 of 3): the plugin advertised a native Windows
sandbox that users never received — the release workflow had no cargo step,
the shipped binary layout was undiscoverable from the installed plugin, and
every downgrade was silent outside debug mode. "CI validates a binary users
never receive" was literally true.

## Migration

- No config changes required. Windows users gain the native sandbox on the
  next update; macOS/Linux behavior is unchanged except that executors now
  receive their declared env overrides.
- Projects pinning an old runner on PATH will see it refused with a visible
  protocol-mismatch warning — remove the stale binary or update it.
- The npm package size increases by the two runner executables.

## Caveats

- Compound or quoted Windows commands (`&`, `|`, `<`, `>`, `"`, `^`, `%` in
  the command string) take the PowerShell wrapper path (still fully wrapped —
  env-restricted, opaque Base64 transport) instead of the native runner's
  AppContainer / restricted-token boundary. The runner's cmd-transport
  currently carries the command as a raw `cmd /c` line without metacharacter
  escaping, so routing such commands to the runner would let a suffix execute
  outside the sandbox (`%VAR%` is expanded by cmd.exe even inside double
  quotes); carrying the command inside the policy JSON is the follow-up that
  restores strong confinement for compound commands.
- arm64 coverage depends on GitHub `windows-11-arm` hosted runner capacity
  (GA for public repos); a failed arch build blocks the release rather than
  shipping x64-only.
- The Rust-side gates (fmt/clippy/tests) remain merge-group CI; PR-level
  validation compiles and probes the runner via the new packed-artifact smoke
  steps.
- Runner-binary integrity rests on provenance (same-workflow artifacts, npm
  tarball) plus the versioned probe handshake — no hash/signature scheme
  (documented non-goal in ADR 0001).
