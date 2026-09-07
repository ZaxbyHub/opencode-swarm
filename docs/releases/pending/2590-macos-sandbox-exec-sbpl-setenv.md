Fix: macOS sandbox-exec profiles unparseable — executor silently disabled (#2590)

## Changes

- **macOS sandboxing works again (opt-in `guardrails.sandbox_macos_enabled`).**
  `sandbox-exec` rejected every generated SBPL profile because `setenv`/`unsetenv`
  are not Sandbox Profile Language operations — the parser reports
  `unbound variable: setenv` (exit 65). Because the availability probe embedded the
  same invalid pair, the probe failed on every macOS host and the whole
  sandbox-exec executor silently fell back to unsandboxed tool-layer enforcement.
  The env directives are gone from both the probe and production profiles, and the
  DYLD_* unset / PATH-pin hardening is now applied inside the wrapped command (the
  inner shell runs it before the user command) — the only place it can work, since
  SBPL cannot mutate a process's environment.

## Also fixed

- The declared env hardening is effective for the first time. Commands that need
  non-system `PATH` entries (Homebrew, version managers) must extend `PATH`
  themselves when the macOS sandbox is enabled — see the updated
  `docs/configuration.md` macOS sandbox section.

## Impact

- macOS only. The gate (`guardrails.sandbox_macos_enabled`) still defaults to
  `false`; users who enabled it previously got a dead executor with a warn log —
  they now get a working file-write sandbox whose profile parses cleanly.
