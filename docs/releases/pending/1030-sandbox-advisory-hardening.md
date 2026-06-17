# Sandbox fix-forward: advisory hardening (#1030)

Addresses six advisory findings from the PR #1015 council review:

- **macOS SBPL comment (MEDIUM):** Updated the `sandbox-exec-executor` module docstring and
  inline comment to accurately describe the profile scope. The profile uses `(allow default)`
  which permits non-file operations (network, IPC, process creation, sysctl reads); only
  file-writes outside the declared scope paths are denied. The previous comment misleadingly
  said "deny-by-default policy".

- **Windows cmd /c wrapping (MEDIUM):** `WindowsSandboxExecutor.wrapCommand()` now detects
  PowerShell-native cmdlets (e.g. `Remove-Item`, `Copy-Item`, `Get-ChildItem`, etc.) and
  invokes them directly via `Invoke-Expression` instead of wrapping them with `cmd /c`. This
  fixes broken sandbox execution for PS-native commands while preserving `cmd /c` wrapping
  for standard shell commands.

- **Linux bwrap capability hardening (LOW):** Added `--cap-drop ALL` to the bwrap invocation
  in `BubblewrapSandboxExecutor`. This drops all Linux capabilities inside the user namespace
  as a defense-in-depth measure, even though `--unshare-user` already limits most privileges.

- **Linux edge-cases dead code removed (LOW):** `src/sandbox/linux/edge-cases.ts` exported
  eight detection functions that were never called by any production code. The module and its
  tests have been removed to eliminate dead code and test theater.

- **Windows PATH hardcoded (LOW):** Replaced the hardcoded `C:\Windows\System32;C:\Windows`
  PATH string in `WindowsSandboxExecutor` with a runtime lookup via `process.env.SystemRoot`,
  falling back to `C:\Windows` when the variable is not set. This ensures the sandbox PATH
  is correct on non-standard Windows installations (e.g. `D:\Windows`).
