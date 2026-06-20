# Sandbox advisory hardening (#1399)

Addresses five of six advisory findings from the PR #1015 council review. Finding 3 (Windows native AppContainer/Restricted Token) is tracked separately.

## Changes

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

## Security hardening (added in same PR)

During review of the original Windows PS-native handling change, a command-injection vulnerability was identified in the `Invoke-Expression` execution path. The original `psStringEscape` function only escaped `` ` $ " ``, which left the path vulnerable to statement separator (`;`), call operator (`&`), pipeline (`|`), subexpression (`( )`), and variable reference (`$`) injection. This has been fixed in the same PR by:

- Restricting the `isPowerShellNativeCommand` whitelist to filesystem-only cmdlets (Remove-Item, Copy-Item, Get-ChildItem, etc.) plus their common aliases
- Adding a new `isSafePsCommandBody` validation that rejects any command body containing `;`, `&`, `|`, backtick, `$`, parentheses, or newlines
- Throwing `SandboxError` with code `UNSAFE_PS_COMMAND` when validation fails

## Pre-existing issues (advisory for follow-up)

The following issues were identified during review but pre-existed the PR and are out of scope. They are tracked for follow-up:

- **`cmd /c` path cmd.exe metacharacter bypass:** The `cmd /c "${escapedCommand}"` path in `WindowsSandboxExecutor.wrapCommand()` does not escape cmd.exe metacharacters (`&`, `|`, `%VAR%`, `^`, `>`, `<`). `psStringEscape` only protects against PS string escaping. A follow-up should add a separate `cmdStringEscape` for the `cmd /c` branch.
- **macOS SBPL `(allow default)` first-match issue:** The macOS `sandbox-exec` profile starts with `(allow default)` which, under SBPL first-match semantics, makes the subsequent `(deny file-write*)` rules unreachable. The file-write containment does not actually work as the docstring describes. A follow-up should reorder the profile to deny first, then allow.
