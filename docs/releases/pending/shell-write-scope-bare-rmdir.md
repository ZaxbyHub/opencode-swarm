# Coders can remove an empty directory outside their declared scope

## What

The shell write-scope gate no longer blocks a bare `rmdir <dir>` just because
the directory is outside the coder's declared scope, as long as the directory
is inside the workspace.

- Admitted: `rmdir <dir>` with no options and exactly one literal operand
  whose location, with every symlink or junction in its parent chain
  resolved, is strictly inside the session workspace. Each `rmdir` in a
  `&&` / `;` sequence is judged separately.
- Unchanged (still blocked as before): `rmdir -p`, any other option
  (`--ignore-fail-on-non-empty`, `--`), several operands, globs, brace
  expansion, variables or command substitution, targets outside the
  workspace (including after a `cd`), symlink escapes, the workspace root
  itself, and every recursive form (`rm -rf`, `rmdir /s`, `rd /s`).
- File-authority and protected-path checks still apply to the target; only
  the declared-scope membership check is skipped.
- `/swarm guardrail explain` reports the same decision as the live gate.

## Why

`rmdir(2)` refuses to remove a non-empty directory (ENOTEMPTY), so a bare
`rmdir` cannot destroy file data. Blocking it protected nothing, but it left
agent-created empty scratch directories behind and forced a human to clean
them up. The gate does not check whether the directory is empty first: that
check would race with the command (TOCTOU). The kernel's refusal is the
authoritative check.

## Migration

None.
