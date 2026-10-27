---
issue: 3343, 3346, 3347, 3323
---

## Shell write-guard: interpreter spelling detection, host-reported shell grammar, and scope-gated eval routing

### Detection (#3343)

Inline-code interpreters are now classified as `interpreter_eval` writes
across the spelling families that evaded detection before: versioned
binaries (`python3.11`, `ruby3.2`, `node22.0.0`), forward-slash path-qualified
invocations (`/usr/bin/python3`, `C:/Python311/python.exe`), and
`env`/`command`/`exec`-wrapped forms — including wrapper CHAINS
(`command env python -c …`), `env` flags whether argument-less (`-i`) or
arg-taking (`-u NAME`, `-C dir`, `-S "opts"`), and `VAR=VALUE` assignments.
Previously any of these spellings evaded detection entirely, so the eval ran
completely unguarded. Known edges (each filed as a collated follow-up item): a backslash
path-qualified interpreter (`C:\Python311\python.exe -c …`) under a
Windows-grammar host still evades the interpreter tables (item 3); GNU
`env -S "python -c …"` (the command line INSIDE the -S split-string) is
consumed as a flag argument and not re-split (item 4 — the options-usage
form `env -S "-i" python -c …` IS classified); process-modifier wrappers
outside the env/command/exec family (`timeout 5 python -c …`, `stdbuf`,
`setsid`, `xargs`, `ionice`, `chrt`) are not unwrapped by the spelling
normalizer (item 5 — a distinct wrapper-inventory surface, final-critic r7);
and a stdin-delivered interpreter program (`echo CODE | python`, `python -`)
carries no eval flag and is not classified (item 6 — the pipe form admits
while the heredoc twin fails closed only by the parse gate; a distinct
delivery-mechanism surface, final-critic r7). This change's claims are bound
to the SPELLING axis of #3343 (versioned/path-qualified/env-command-exec
wrapped inline-code flags, including GNU/BSD getopt spellings of those
wrappers' flags).
Non-eval invocations (`python3.11 -m pytest`, `--version`, script paths)
remain unclassified, preserving the #1901 `-m` carve-out.

### Host-reported shell grammar (#3346)

The OpenCode 2 host reports the shell a `shell`-tool command actually
executes through the plugin `shell.create.before` hook (resolved once per
host process via the host's ShellSelect: user-configured shell, else
`$SHELL`, else on Windows pwsh → powershell → Git Bash → cmd). The write
gate and `/swarm guardrail explain` now key cmd/PowerShell grammar
inheritance on that authoritative report: a Windows host whose `shell` tool
runs Git Bash no longer misreads POSIX commands as `cmd.exe` (the #3323
false-positive class), and a PowerShell-executing host is covered on any
platform. Before the first host report (the first `shell` invocation of a
host session), the platform-keyed interim from #3326 applies — never wider
than the previous behavior. The v1 host (whose terminal tool is `bash`) is
unchanged.

### Scope-gated eval routing (#3347, and #3323 item 3)

Inspectable inline evals (`python -c`, `node -e`, …) no longer blanket-block
every role. They now route through the same universal-deny, file-authority,
and declared-scope checks as any other write, with the eval's **tracked
working directory** (following `cd` in the compound command) as the target:

- read-only roles (explorer, sme, …) are rejected by the file-authority
  check naming the role;
- agents with a declared scope: an eval whose working directory is inside
  the scope is admitted (`cd src && python -c …` for a `src/`-scoped coder);
  outside it, rejected with the declared-scope error;
- scope-less write-capable roles (architect, reviewer) KEEP the fail-closed
  eval block — the config-zone eval guard and #3347's own eval-block pins
  stay green. Whether orchestrator roles should also be unlocked is the
  open maintainer decision recorded on #3347 (its AC4);
- opaque eval classes (PowerShell `-EncodedCommand`, nested script blocks,
  dynamic `&`/IEX invocation) and dynamic redirect targets (`> $VAR`,
  `> $(cmd)`) keep their hard blocks;
- every same-interpreter occurrence in a compound survives deduplication and
  is judged at its own working directory, so
  `cd src && python -c A; cd .. && python -c B` still rejects on B.

`scope_validate` consequently changes verdicts by design: a non-canonical
inline eval that previously passed as an undetected write is now detected
and routed.

Known limitation: the second `cd` of a single `cd a && cd b && …` chain is
not tracked by the pre-existing command walker (semicolon-separated cds
track correctly) — pre-existing, disclosed, and out of this change's scope.
