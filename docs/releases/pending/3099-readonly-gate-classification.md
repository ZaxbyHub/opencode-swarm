# Guardrails: classify shell commands by content, not by the tool that carried them

Closes #3099.

## The security fix

The shell-write guard decided which grammar to parse a command with by looking
at the **tool** name, not the **command**. The `bash` tool was hardcoded to the
POSIX detector, so a PowerShell command never reached the Windows detector.

That produced two defects from one line of code:

- **A false positive.** `bash-parser` cannot parse a PowerShell script block, so
  a read-only pipeline like `Get-Content a.md | Where-Object { $_.Length -gt 5 }`
  was rejected with `BLOCKED: bash write detection failed to parse command` —
  a message that is simply false for valid PowerShell.
- **An unscoped-write bypass**, which is the more serious half and was not in
  the original report. PowerShell write cmdlets report zero writes to the POSIX
  detector, the guard returns early on `!analysis.hasWrites`, and the declared
  scope check never runs. With a declared scope of `src/`, these were all
  admitted: `Set-Content`, `Out-File`, `Add-Content`, `Copy-Item`, `New-Item`,
  and their pipeline forms — through the `bash` tool, and three of them through
  the `shell` tool as well.

The fix **unions** the detectors rather than switching between them: the POSIX
detector always runs, and the Windows detector runs additionally when the
executor context declares Windows. When both grammars report the same
construct, the reading of the grammar matching the DECLARED executor context
wins — an explicit `cmd /c` (with any cmd.exe switches) or `powershell
-Command` wrapper declares the executor outright; otherwise a clean POSIX
parse keeps the POSIX reading on both tools (the `bash` tool always runs a
POSIX shell, and the `shell` tool keeps the POSIX reading of a cleanly parsed
command too), while the other grammar still contributes every construct the
winning reading does not report. When no wrapper declares the executor and
the two grammars resolve the same construct to DIFFERENT paths, both readings
are kept and the scope check fails closed on whichever resolves outside the
declared scope. Lexical resemblance alone never discards a reading.

These semantics were re-derived under an adversarial post-publication review
(`#3145`): three bypass families the first cut left open — newline/CR
statement separators after a read-only pipeline, cmd.exe switch forms before
`/c`, and mixed-separator path traversal on the `shell` tool — are closed, and
the closure is pinned by regression rows.

## Also fixed

- **Writes hidden in control-flow bodies.** `cp` inside an `if`, `while`,
  `until`, `for`, `case` or function body was never visited by the AST walkers
  and reported no write at all. The walkers now recurse, while keeping each
  compound node's own redirections visible so `if …; fi > OUT` keeps reporting.
- **`New-Item` had no matcher at all**, so it was admitted on both tools. It now
  has a dedicated one that composes `-Path` and `-Name` rather than resolving an
  in-scope decoy.
- **A read-only allowlist** so a positively-classified read-only PowerShell
  pipeline is a read rather than a parse failure. Fail-closed is unchanged and
  now deny-by-default: a script-block body is admitted only when every token is
  positively a `$_`/`$this` property chain, a comparison operator, a literal or
  a comma — any unrecognized identifier, method call, type literal, assignment
  or sub-expression fails the body and the command stays blocked, as does any
  command containing a second statement after a newline or carriage return
  (statement separators that a brace pipeline previously hid from the parse
  backstop). Write mechanisms the detectors cannot see
  (`[System.IO.File]::WriteAllText`, `mkdir`, `tar`, `chmod`, `$_.Delete()`…)
  therefore keep failing closed. PowerShell names match case-insensitively.
- **Switch-tolerant cmd.exe wrapper recognition.** `cmd /d /s /c copy a b`,
  `cmd /q /c …`, `cmd /v:on /c …` declare the cmd executor and reach the
  copy/move matchers exactly like bare `cmd /c copy a b`; the wrapper strips
  (`dcUnwrapWrappers`, the cmd/PowerShell detectors, the destructive-command
  walker) unwrap the switch forms too, and `powershell -NoProfile -Command
  "…"` unwraps like bare `powershell -Command "…"`.
- **Enumerated read-only tool methods.** The PR-review gate required a `method`
  argument to be literally `GET` or `HEAD`, so a tool that takes enumerated
  *operation* names — `get_check_runs`, `get_reviews`, `get_review_comments`,
  `get_comments` — was admitted by name and then made unusable. Tools that
  declare a read vocabulary now accept it; undeclared tools keep the
  GET/HEAD-only default.
- **A quoted regex operand.** `git grep -nE "a|b"` was rejected because the only
  admitted literal pipe was inside a double-quoted `gh api --jq` value. A
  double-quoted extended-regex pattern operand of `git grep` is now admitted;
  nothing else widens.
- **`gh` readiness at PR-workflow activation.** `gh` availability was only ever
  resolved lazily, when a tool that needed it ran. Activation now publishes a
  workflow-scoped readiness advisory, reusing the existing `gh-not-found`
  guidance. Detection is fail-open and never gates activation.

## Rider not implemented

The issue's second rider (point the PR-review skill at the paged lane-output
retrieval) does not reproduce as a defect: the skill already names
`retrieve_lane_output` where lanes are dispatched, and the real inline preview
cap is 20 000 characters rather than 2 000, so the requested one-line addition
would only restate an instruction the skill already carries. A skill-text edit
would additionally require a swarm-contract digest re-stamp and mirror
reconciliation, which does not belong in a guardrail PR; the pointer remains a
one-line follow-up for the skill's own maintenance path. No change was made
for it.
