# Coders can remove an empty directory outside their declared scope

## What

The shell write-scope gate no longer blocks a bare `rmdir <dir>` just because
the directory is outside the coder's declared scope, as long as the directory
is inside the workspace.

- Admitted: `rmdir <dir>` with no options and exactly one literal operand
  whose location, with every symlink or junction in its parent chain
  resolved, is strictly inside the session workspace, when the command runs
  under a POSIX shell (the `bash` tool, or the `shell` tool on a non-Windows
  host). The target must not exist yet or must be a real directory. Each
  `rmdir` in a `&&` / `;` sequence is judged separately.
- Unchanged (still blocked as before): `rmdir -p`, any other option
  (`--ignore-fail-on-non-empty`, `--`), several operands, globs, brace
  expansion, variables or command substitution, targets outside the
  workspace (including after a `cd`), symlink escapes, the workspace root
  itself, every recursive form (`rm -rf`, `rmdir /s`, `rd /s`), a target
  that exists as a file or symlink, and any `rmdir` run by a Windows
  executor (a `powershell -Command` / `pwsh -c` / `cmd /c` wrapper, a
  PowerShell-shaped command, or the `shell` tool on Windows). In PowerShell
  `rmdir` is an alias of `Remove-Item`, which also deletes files.
- File-authority and protected-path checks still apply to the target; only
  the declared-scope membership check is skipped.
- `/swarm guardrail explain` reports the same decision as the live gate
  (it evaluates the command as the `shell` tool).

## Why

`rmdir(2)` refuses to remove a non-empty directory (ENOTEMPTY), so a bare
`rmdir` cannot destroy file data. Blocking it protected nothing, but it left
agent-created empty scratch directories behind and forced a human to clean
them up. The gate does not check whether the directory is empty first: that
check would race with the command (TOCTOU). The kernel's refusal is the
authoritative check.

## Migration

None.
