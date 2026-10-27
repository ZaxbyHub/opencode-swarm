# Shell write-detector: launcher prefixes, quoted payloads, canonical spellings, and cd/pipe/Windows evasions closed

## What

The shell write-scope gate classifies a dozen previously-admitted evasion
shapes identically to their canonical forms (#3474, #3475). Every change is
additive detection (fail-closed); the only newly-admitted shapes are the
correctly-tracked ones below.

- Launcher prefixes no longer hide builtin writes: `command rmdir ../x`,
  `builtin rmdir ../x`, `exec rmdir ../x`, and `timeout 5 rmdir ../x` are
  detected and scope-checked like their unprefixed spellings, and
  `command rm -rf ../x` now reaches the destructive-command layer's
  recursive-delete check like its unprefixed spelling. `command -v` /
  `-V` are query forms and stay admitted.
- Single-quoted `sh -c 'rmdir ../x'` / `bash -c '...'` payloads unwrap like
  double-quoted ones, including payloads that contain the other quote kind.
- Versioned and path-qualified spellings of the write-vector sets classify
  canonically: `/usr/bin/curl -o`, `curl8.5 -o`, `/usr/bin/sed -i`,
  `/usr/bin/tar -xzf`, `bzip2.5 -d`, `/usr/bin/cp` (three-tier version
  lookup — canonical `bzip2` stays itself).
- `cd a && cd b && …` chains track every `cd` (`;`-chains already did): the
  final tracked directory resolves redirect targets AND eval working
  directories, so `cd src && cd .. && echo x > escape.txt` and
  `cd src && cd .. && python -c …` now block for a src/-scoped coder.
  `||` chains keep their previous (conservative) tracking.
- Windows-grammar interpreter evals: `C:\Python311\python.exe -c "…"` (and
  the forward-slash spelling) classify as `interpreter_eval` under both cmd
  and PowerShell grammars, with the raw-word operator so a spelling both
  grammars see keeps its tracked context. A backslash-only spelling
  authorizes against the command's starting directory (the workspace root —
  outside every proper declared scope).
- Inline-literal pipe sources feeding a bare (or `-`-flag) interpreter
  classify as eval: `echo 'open("../x","w")' | python` and
  `printf '…' | python -` block for scoped coders. Dynamic producers
  (`grep … | python`) and every script-path form (`cat f.py | python`,
  `python f.py`, `python -m …`, `python - < f.py`) keep the #1901/#1902
  carve-out (maintainer ruling on #3474).
- Mid-word `#` operands no longer truncate: `cp src/x.txt
  src/x.txt#../../../zz` resolves the FULL operand (bash-parser's
  quote-removal stage used to stop the word at the `#`), so the in-scope
  prefix can no longer mask an out-of-scope target. Word-start `#` comments
  are unaffected.
- A leading-`=` `rmdir` operand loses the bare-`rmdir` exemption on every
  host (zsh `=`-expansion resolves the word to a PATH location the static
  containment check never saw; decision on #3475).

## Why

Every one of these shapes was an execution-verified fail-open of the write
guard: a coder scoped to `src/` could write outside the scope (and sometimes
outside the workspace) by spelling the write differently. The detector's
own residuals — read-only classification, the `#1901` script-path carve-out,
and the bare-`rmdir` exemption's plain-line contract are unchanged
(`command -v` queries, `timeout 5 make test`, `cat script.py | python`,
in-workspace plain `rmdir`, and the destructive-command layer's original
analysis are all pinned by new suites). The exemption itself narrowed in
one disclosed way: a leading-`=` operand loses it (above). Repeated
Windows-grammar interpreter evals are now each retained with an occurrence
suffix instead of collapsing into one row (matching the POSIX behavior).

## Migration

None. `touch` and `mkdir` remain undetected write commands (parity with the
pre-fix behavior for both their plain and prefixed spellings); making them
write-vector commands would change the bare-`rmdir` exemption's documented
`mkdir x && rmdir x` example and is out of scope.
