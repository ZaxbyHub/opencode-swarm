# Shell write gate G3: launcher grammars, interpreter eval clusters, Windows/destructive spellings

## What

Final PR of the #3491/#3539 shell-write-evasion program (three dependency-grouped
PRs; this one closes both issues). Three workstreams on top of the G1/G2 branches:

**Launcher option grammar + fail-closed depth caps (#3491 W3 / RC-2b).** The
destructive arm's wrapper strip handled only BARE `sudo|time|nohup` and
`nice -n N`, so an option-bearing launcher left the option word in verb position
and the identical wrapped command ADMITTED (`sudo -u root rmdir ../x`,
`time -p rmdir ../x`, `nice -10 rmdir ../x` all ran uninspected). A per-manual
option table now walks each launcher's own grammar from a single source shared by
the destructive strip, the write-arm leaf walk, and the resolver walk:

- `sudo` per sudo(8): transparent argless execution options (-E -n -b -B -A -H
  -P -S -k) and arg-taking members (-u/-g/-p/-r/-t/-C/-T/-U plus -D/--chdir
  composing through the W2 quoted-subshell child-cwd transform and -R/--chroot);
  `-l` (with or without a command — it only lists) and the other query modes are
  benign; `-e/--edit` operands are EDIT TARGETS emitted as write-class
  `launcher_write` targets; `-i/-s` with no command opens an interactive root
  shell and DENIES; `-h` and any unknown option cluster ⇒ "every remaining word
  is a potential execution tail" ⇒ deny-on-uncertainty at the gate (benign when
  no tail remains).
- `time` by SPELLING: the bare word is the bash KEYWORD (only `-p`; ground
  truth bash 5.3.9 — an unrecognized dash word IS the timed command, so
  `time -v cmd` runs nothing); an absolute-path spelling selects the GNU binary
  grammar (-p/-v/-q/-h/-V/-i/-a, -f FORMAT, `--`), where `-o FILE` emits the
  timing-report destination as an ADDITIONAL write target (spaced, glued,
  `--output=`, and abbreviation forms).
- `nice` per GNU coreutils: `-n N`, attached `-N`, `--adjustment[=]N`, `--`;
  `nohup` is option-less (bare and `--` transparent); unknown options ⇒
  deny-on-uncertainty.
- Depth caps: the destructive string unwrap chain (fixed 5) and the write arm's
  hop cap (fixed 8) are now cursor-bounded loops with a paranoid absolute bound
  of 64, whose exceedance FAILS CLOSED through an additive channel —
  `dcUnwrapWrappersBounded().depthExceeded` and `WriteAnalysis.unwrapDepthExceeded`
  — consulted by the gate and the `/swarm guardrail explain` mirror BEFORE every
  no-write early return. `sudo`×6 and `command`×14 nesting now reach their verbs
  and deny.

**Interpreter eval clusters + deno (#3491 W7 / RC-3).** The eval matcher tested
whole tokens only, so getopt CLUSTERS never decomposed (`python -Bc`,
`perl -pe`, `ruby -ne`) and `deno` was absent from the interpreter table — those
spellings ran inline code without the `interpreter_eval` classification. Python,
perl, and ruby now have per-interpreter cluster grammars (python: `c` eval with
attached-tail/next-word arity, `-W/-X` arg-taking, `-m` still a module run;
perl per perlrun: `e/E` eval, `-i.bak`/`-0777` optional-attached arity — `-0`
consumes only its digit run, ground-truthed on perl 5.36; ruby: `e` eval while
`n/p` loop prefixes and `-E` encoding are not). Unknown cluster members are
benign no-run (every one of these interpreters rejects the whole invocation).
`deno` classifies eval ONLY at subcommand position (`deno eval`, `deno eval -p`,
after a bounded set of argument-less global flags; NO `--eval` alias exists);
`deno run script.ts` keeps the script-file carve-out, and the `deno run -`
stdin shape extends the pipe-stdin eval classifier.

**Windows/destructive spellings (#3539 W6 / RC-6/7/8).** Destructive verb
matching keyed on the exact bare token, so `\rm`, `"rm"`, and `/bin/rm` never
matched. Verb words at every dc verb position (the rm extractor, the PowerShell
extractor, and the gate-local rmdir/del/Remove-Item/git-worktree/rsync/mv/
move/ren/rm-.swarm/mklink/ln arms) now normalize through bash quote-removal plus
basename extraction ONLY for ABSOLUTE path-qualified spellings — win32 spellings
(drive letter or backslash) case-insensitive with an optional extension, POSIX
forward-slash absolutes case-SENSITIVE (`/bin/RM` stays unmatched), relative
`./rm`/`../rm` NOT normalized (project-local programs). The PowerShell parameter
walk is an INDEX-BASED scan (the old loop looked repeated `-Path` tokens up with
`indexOf`, binding every repeat to the first occurrence's value and dropping its
target) with colon-glued `-Param:Value` binding (`-Path:/etc` splits: the left
keeps value-taking semantics, the right IS the value; boolean switch values like
`-Recurse:$true` are not paths). The cmd.exe wrapper identity is
basename-normalized at the declaration, builtin-prefix, and strip predicates
shared by the gate, the detectors, and the explain mirror, so a path-qualified
`C:\Windows\System32\cmd.exe /c copy a ..\x` selects the win32 authority and its
out-of-scope write denies.

## Why

Issues #3491 and #3539 catalogued fail-open divergences between the static shell
model and real bash/PowerShell; every one covered here admitted an
out-of-scope/protected write or delete. All sixteen frozen reproduction checks
(C1–C16) now pass at this head: C3, C4, C6, C8, C10, C11 flipped RED→GREEN, C16
flipped ERROR→GREEN with the five shipped regression suites, and C1, C2, C5, C7,
C9, C12–C15 stay GREEN.

## Known edges

- Deny-on-uncertainty (W3) can false-positive exotic-but-benign launcher
  spellings (`sudo -h host cmd`-style undocumented forms); accepted deliberately
  (fail-closed default).
- Quoted/escaped `time` spellings (`\time`, `'time'`, `"time"`) suppress the
  bash keyword (ground truth: bash PATH-resolves a program instead), so the
  GNU-binary grammar governs them — `\time -o FILE cmd` emits the
  timing-report write target (review advisory 1).
- A trailing `.exe` is stripped from normalized rm-family verbs, so the bare
  `rm.exe` and the POSIX-absolute `/bin/rm.exe` match `rm` — Git Bash resolves
  them to the same program (ground truth); the POSIX strip is an over-match in
  the deny direction, deliberately accepted (review advisory 2). `/bin/RM`
  stays unmatched (POSIX case-sensitivity).
- Perl cluster forms (`perl -i -pe '…'`, `perl -ne`) now carry an
  `interpreter_eval` write alongside their in-place report, so they route like
  `python -c`: denied for a scope-less architect and for a scoped coder while
  the eval runs outside the declared scope (`cd src && …` admits). Previously
  allowed at the workspace root; re-pinned deliberately in the in-place suites.
- A deno global flag that takes an argument before the subcommand
  (`deno --config x eval CODE`) is not modeled; disclosed rather than guessed.
- nohup.out creation stays stdout-tty-gated and out of static reach — disclosed,
  not modeled.

## Test evidence

- New suites `tests/unit/hooks/guardrails-shell-write-interpreter-flags-3491.test.ts`
  (46 tests), `tests/unit/hooks/destructive-command-verb-and-ps-3539.test.ts`
  (50 tests), and the review-round sibling
  `guardrails-shell-write-launcher-depth-3491.test.ts` (13 tests: compound
  depth laundering, quoted time, explain parity); W3 legs added to
  `guardrails-shell-write-launcher-env-3491.test.ts` (80 tests total).
- Deliberate re-pins: `shell-write-detect-null-device.test.ts` (perl glued
  cluster evalToo rows), `guardrails-shell-write-inplace-unknown-option.test.ts`,
  `guardrails-shell-write-inplace-escapes.test.ts`,
  `guardrails-shell-write-inplace-operands.test.ts` (perl in-place cluster rows
  moved from allowed to eval-blocked).
