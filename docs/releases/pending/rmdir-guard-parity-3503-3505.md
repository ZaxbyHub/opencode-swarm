# rmdir guard parity: every operand scope-checked, classifier matches real cmd.exe switches

## What

Closes #3503 and #3505 (collated) — two rmdir-family guard defects where a
surface modeled shell arguments by approximation instead of the real
operand grammar.

Shell write-scope gate (#3503, fail-open):
- The builtin-write detector reported only ONE operand of a multi-operand
  `rmdir`/`truncate` — the LAST non-flag word (FIRST for truncate via the
  AST branch) — so an out-of-scope operand placed before an in-scope last
  operand escaped the coder's declared-scope gate entirely
  (`rmdir outside-oos src/share/ok` was admitted while real bash removes
  both directories). The process-substitution fallback
  (`true >(rmdir outside-oos src/ok)`) had the same last-token-only escape
  and its finding suppressed the parse-error rejection for the whole line.
- Both paths now report EVERY written operand (rmdir removes and truncate
  truncates each operand); cp/mv/install/ln keep destination-only
  reporting (only the last operand is the written file), and the
  #3456 bare-single-rmdir empty-directory exemption is unchanged.

Shared command classifier (#3505, over-blocking):
- The `windows-recursive-delete` rule matched any `/s`-shaped TEXT after
  the verb — including `/x` segments inside path tokens — so legal
  nested-path deletes (`rmdir src/share/opencode2`, `rmdir /tmp/Scratch`,
  `del src/s/q/f.txt`) classified `destructive`, and both policy consumers
  denied them: Full-Auto returned `deny` and `scope_validate` failed
  `DESTRUCTIVE_COMMAND`, while the guardrail gate family already admitted
  the same shapes.
- The rule now uses the same executed-ground-truth cmd.exe grammar as the
  destructive guard (new shared helper `dcHasCmdDeleteSwitch` in
  `src/hooks/guardrails/cmd-delete-grammar.ts`): a `/`-led token is a
  switch only when its post-slash text forms a VALID cluster (every
  slash-separated segment 1-2 ASCII letters) and is not fully quoted. The
  true-positive floor (`/s`, `/S`, `/s /q`, `/s/q`, `/sq`, `/qs`,
  `rd.exe /s`, bare `/q`, glued `rd zzz/s`, `rd 'zzz/s'`) stays
  destructive; fully quoted switch-looking tokens (`rd "/s" x`) stop
  matching (a quoted token is a PATH per cmd.exe) — the widening disclosed
  in #3505's Out-of-scope note.

## Why

A write-detector miss is a fail-open: role, scope, protected-path and
root-escape checks are skipped for every unreported operand. A classifier
false positive is a workflow wedge that contradicts the gate family on the
same command. Both defects were probe-verified at the affected commits
(#3499 trace family); both now have durable regression suites
(`guardrails-shell-write-rmdir-multi-operand.test.ts`,
`command-classifier-floor-3505.test.ts`, extended
`command-classifier.test.ts`).

## Issue closure

- Closes #3503
- Closes #3505

Note: cmd.exe-style quiet-flag spellings inside bash commands
(`rmdir /q src/x`) are multi-operand POSIX forms — the `/q` token is an
ordinary path operand for bash, so it is now scope-checked like every other
operand (previously only the last operand was). Windows quiet-flag
tolerance, if ever wanted, is a design change in the #3491/#3088 detector
program, not this fix.

Feedback round (PR #3512 review): the token-aware switch matcher splits on
unquoted cmd delimiters `( ) < > | &` in addition to whitespace and `,;=` —
a delimiter glued to the switch (`(rd x /s)`, `rd x /s>nul`, block-wrapped
`if exist x (rd x /S)`) still reaches the switch at execution, so these
forms stay classified destructive for both policy consumers (Full-Auto and
`scope_validate` with `shell=cmd`), matching the pre-token-aware behavior.
The multi-operand detector loops also honor the `--` end-of-options
convention (a dash-named operand after `--` is a path), and adversarially
large operand lists no longer rely on the JS engine's spread-arity limit.
