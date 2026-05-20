# Shell Write-Interception and Regression Suite

## What changed
- Added POSIX shell write detection via bash-parser AST analysis for redirects, here-docs, builtins (cp, mv, sed -i), interpreter eval, network downloaders, archive extraction, and git destructive operations
- Added Windows shell write detection via regex heuristics for PowerShell (Out-File, Set-Content) and cmd.exe (copy, move, echo >)
- Implemented scope path resolution with subshell cd tracking and fail-closed behavior for dynamic/unresolvable paths
- Added interactive/session tool denial (watch, screen, tmux, Start-Process) regardless of declared scope
- Added cross-process scope persistence with TTL expiry and symlink guards (O_NOFOLLOW)
- Added 348 regression tests across 4 test files covering all write categories, scope enforcement, and architect prompt rules
- Fixed interactive session bypass for 'bash' shell type in guardrails.ts

## Why
This closes the tool-layer write interception gap identified in #519. Prior to this change, the swarm plugin relied solely on scope declarations and syscall-layer protections, which did not intercept shell-based write operations before execution. The new static analysis catches writes in bash/shell tool invocations and enforces declared scope boundaries.

## Migration
No migration required. The feature is backward-compatible: when no scope is declared, all writes are allowed (existing behavior). When scope is declared, writes outside scope are now blocked with descriptive error messages.

## Known caveats
- Windows shell detection uses regex heuristics rather than AST parsing (PowerShell/cmd.exe lack lightweight JS parsers)
- Indirect writes via invoked binaries (gcc, db tools) without shell redirects are not detected
- Non-bash POSIX shells (zsh, fish) may have parsing edge cases with bash-parser
- cmd.exe interactive tools (cmd /k) are not explicitly blocked
