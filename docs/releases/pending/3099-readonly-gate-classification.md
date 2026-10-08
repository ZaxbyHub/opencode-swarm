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
executor context declares Windows. Nothing can lose a detection it has today.
When both grammars report the same construct, the reading of the grammar
matching the DECLARED executor context wins — an explicit `cmd /c` or
`powershell -Command` wrapper declares the executor outright; a
PowerShell-shaped body cannot execute under POSIX at all; otherwise the tool's
own executor decides (the `bash` tool runs a POSIX shell, so POSIX re-reads of
`src\out.txt` as `srcout.txt` stay authoritative there, while `cmd /c` keeps
its Windows reading). Lexical resemblance alone never discards a reading.

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
  or sub-expression fails the body and the command stays blocked. Write
  mechanisms the detectors cannot see (`[System.IO.File]::WriteAllText`,
  `mkdir`, `tar`, `chmod`, `$_.Delete()`…) therefore keep failing closed.
  PowerShell names match case-insensitively.
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
retrieval) does not reproduce: the skill already names `retrieve_lane_output`,
the real inline preview cap is 20 000 characters rather than 2 000, and the
skill sits at exactly its progressive-disclosure ratchet baseline, so the
requested one-line addition would break that ratchet in order to restate an
instruction the skill already carries. No change was made for it.
