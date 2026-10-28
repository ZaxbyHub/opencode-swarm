# Coders can remove an empty directory outside their declared scope

## What

The shell write-scope gate no longer blocks a bare `rmdir <dir>` just because
the directory is outside the coder's declared scope, as long as the directory
is inside the workspace.

- Admitted: `rmdir <dir>` with no options and exactly one literal, unquoted
  operand whose location, with every symlink or junction in its parent chain
  resolved, is strictly inside the session workspace, when the command runs
  under a POSIX shell (the `bash` tool, or the `shell` tool on a non-Windows
  host). The target must not exist yet or must be a real directory.
- The exemption applies only to a plain command line, judged on the
  command text after the gate's existing `eval` / `sh -c` unwrapping.
  Launcher prefixes (`command`, `builtin`, `exec`, `timeout DURATION`, `stdbuf`) are unwrapped before that judgement, and a single-quoted `sh -c` / `bash -c` payload unwraps like a double-quoted one, so `command rmdir ../outside` and `sh -c 'rmdir ../outside'` get the ordinary declared-scope check (#3474/#3475). An operand beginning with `=` also loses the exemption (zsh `=`-expansion makes the static literal unsound there). That
  text may hold only letters, digits, spaces, newlines and the characters
  `_ . / - = & | ; < >`, and every command in it must be one of `rmdir`,
  `mkdir`, `echo`, `true`, `false` or `test`. None of these commands can
  change the shell's working directory, and without `$`, quotes,
  backslashes, backticks, parentheses, braces, brackets or `#` nothing in
  that text can expand, be evaluated, be quoted, define a function or start
  a comment, so `rmdir` runs in the directory the gate checks and removes
  exactly the operand the gate checks. `&&` / `||` / `;` lists, pipelines,
  redirections such as `2>/dev/null`, `FOO=1 rmdir x` prefixes and `if` and
  loop bodies are fine:
  `rmdir .scratch-a/tmp1`, `rmdir dir/`, `rmdir ./dir`, `rmdir a && rmdir b`,
  `mkdir x && rmdir x`, `rmdir a 2>/dev/null || true`,
  `rmdir a && echo done` and `FOO=1 rmdir a` keep the exemption, and each
  `rmdir` of a distinct operand is judged separately.
- Every other line gives every `rmdir` in it the ordinary declared-scope
  check. That includes any text with a character outside the set above:
  `rmdir "dir"`, `rmdir a && echo "done"`, `echo $HOME; rmdir a`,
  `[ -d src ] && rmdir a`, subshells and brace groups (`(rmdir a)`,
  `{ rmdir a; }`), `case`, `$(...)`, backticks, any `#` (`rmdir d#/x`
  removes the one directory `d#/x` in bash, and `rmdir a # note` loses the
  exemption too), and paths containing `~ + , : @ %`. An interior tab is
  refused outright as unsafe command text, and an interior carriage return
  is never exempt either. It also includes any other
  command in the line: `cd`, `pushd`, `popd`, function
  definitions, `source` and `.`, `trap`, `alias`,
  an upper-case `RMDIR`, and every other command
  (`ls d && rmdir d`, `cd build && rmdir tmp`). A line with a
  here-document normally loses the exemption too, because the gate reads
  the body and delimiter lines as commands that must also be on the list
  (a body on a plain line cannot expand anything). This closes code that
  bash evaluates at run time, such as the bash 5.3 current-shell
  substitutions `${ cd ..; }` and `${| cd ..; }`, including a quoted one
  that arithmetic (`$((x))`) or a `test -v` / `[ -v` subscript evaluates.
- Unchanged (still blocked as before): `rmdir -p`, any other option
  (`--ignore-fail-on-non-empty`, `--`), several operands, globs, brace
  expansion, variables or command substitution in the operand, targets
  outside the workspace, symlink escapes, the workspace root itself, every
  recursive form (`rm -rf`, `rmdir /s`, `rd /s`), a target that exists as a
  file or symlink, and any `rmdir` run by a Windows executor (a
  `powershell -Command` / `pwsh -c` / `cmd /c` wrapper, a PowerShell-shaped
  command, or the `shell` tool on Windows). In PowerShell `rmdir` is an
  alias of `Remove-Item`, which also deletes files.
- Never exempt (the ordinary declared-scope check applies):
  - a sequence that names the same operand more than once, for example
    `rmdir a; cd ../other && rmdir a` or `rmdir a; rmdir -p a`, because the
    gate cannot tell those writes apart;
  - an operand with a `..` path segment (`link/../x`), even on a plain
    line;
  - repository control state: a target under the workspace's `.git` or
    `.swarm` directory; the exemption never applies there for any role.
- File-authority checks still apply to the target and are unchanged; only
  the declared-scope membership check is skipped. Default-protected prefixes such as `.github/workflows`,
  `docs/releases` and `node_modules` are not separately protected for a bare
  `rmdir` (issue #3450 scopes the exemption to the whole workspace), so a
  coder whose declared scope excludes them can now remove an empty
  directory there. The target's parent directory must already exist when
  the gate runs: `mkdir x && rmdir x` keeps the exemption (the parent is the
  workspace root), but `mkdir -p d/e && rmdir d/e` in one command still gets
  the ordinary scope check because `d` does not exist yet.
- `/swarm guardrail explain` has no tool or platform flag and evaluates the
  command as the `shell` tool, so on a Windows host it conservatively reports
  `block` for a bare `rmdir` that the live `bash` tool admits. The
  `scope_validate` MCP advisory does not apply the exemption at all and also
  stays conservative.

## Why

`rmdir(2)` refuses to remove a non-empty directory (ENOTEMPTY), so a bare
`rmdir` cannot destroy file data. Blocking it protected nothing, but it left
agent-created empty scratch directories behind and forced a human to clean
them up. The gate does not check whether the directory is empty first: that
check would race with the command (TOCTOU). The kernel's refusal is the
authoritative check.

## Migration

None.
