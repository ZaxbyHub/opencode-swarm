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
  shell and DENIES; a command-less sudo with NO query/reset mode is the
  implied interactive root shell (parse_args.c ground truth) and denies
  like `-i`, while `sudo -k`/-v/-l stay benign (documented no-command
  no-ops); `-h` and any unknown option cluster ⇒ "every remaining word
  is a potential execution tail" ⇒ deny-on-uncertainty at the gate (benign when
  no tail remains — a shape that leaves no words to inspect, e.g. after the
  query/reset exclusions above).
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

**Feedback round (PR #3572 review N-items).** Nine review defects closed with
their pins in `guardrails-shell-write-3572-feedback-hardening.test.ts`
(34 tests) and the relocated `shell-write-detect-perl-cluster-n12.test.ts`:

- **N-01**: an accumulated sudo `-e`/`--edit` now survives the getopt `--`
  sentinel — `sudo -e -- FILE` was classified inner (no write target at all);
  the edit outcome is checked BEFORE the generic inner return.
- **N-02**: a GNU `time -o FILE` segment stays WHOLE on the strip side
  (unwrapping to the timed tail erased the cd-tracking context that resolves
  the -o target). The timed command is surfaced to the destructive arms by
  the new `dcLauncherTimedTail` helper: the gate AND the explain mirror push
  the timed tail as an occurrence with the SEGMENT's own directory context —
  `time` runs its command in the current shell, so `cd src && time -o r.txt
  rm -rf build` judges the in-scope delete like the bare twin, and
  `/usr/bin/time -o report rm -rf ../outside` still denies.
- **N-03**: keyword-suppression must be PROVEN by a defined raw spelling;
  when the leaf walk cannot supply one (dequoted chain words), the GNU
  grammar wins — deny-direction (an over-approximated launcher_write, never
  a lost one). The exact review trigger
  (`'time' -o src/report curl -o ../outside url`) now emits the escaping
  download.
- **N-29**: GNU env `-S/--split-string` re-parses its payload as a command
  line. The reconstructed argv (`env` + pre-flags + RE-SERIALIZED payload
  words — the bare-space join destroyed the `sh -c "script"` quote grouping)
  re-enters the FULL detector family (the string-level scanner's leaf gate
  missed the special-cased tee/dd/env verbs, so `env -S 'tee src/ok.txt'`
  was write-free); a payload whose analysis yields ONLY a null-path eval
  capability (`env -S 'sh -c "…"'` — the merge's union-back drops bare eval
  markers) converts to the unconditional dynamic refusal, while payload
  interpreters that carry their own writes (`env -S 'python -c …'`) keep
  bare-twin verdict parity through the normal eval scope check; nested `-S` (spaced or GLUED `--split-string=VALUE`), expansion-
  bearing payload words, and a second `-S` in the original argv emit the
  same refusal; the glued `--split-string=VALUE` spelling is recognized by
  the destructive strip too. Completion: the wrapper-prefixed tee branch
  starts at the RESOLVED leaf word (`env tee src/ok.txt` fabricated the verb
  word itself as an in-scope write target — the tee half of #3569's
  operand-window advisory; the chdir-wrapper direct-write modeling stays
  tracked there).
- **N-06**: `deno run` with argument-less flags between `run` and the stdin
  `-` keeps the stdin-eval shape — the write-capable allow-all form
  (`deno run -A -`) was inverted against the bare form.
- **N-13**: gate-level pin for the `perl -i.bak -ne` cluster eval; the
  deleted reference-suite rows are described truthfully (removed, re-pinned
  at the detector level — not "moved to a blocked set").
- **N-16**: `scope_validate` consults the launcher deny-on-uncertainty
  channel and the paranoid-bound depth flag like the live gate — for every
  shell grammar (the gate applies both channels before grammar dispatch).
- **N-25**: the launcher uncertainty channel sees through the transparent
  `env`/`command`/`builtin`/`exec` heads it strips elsewhere
  (`env -i sudo -i` denied like its bare twin), bounded by the shared
  paranoid unwrap bound.
- **N-26**: the launcher deny reason sanitizes the untrusted launcher word
  (control characters neutralized, length bounded).
- N-07 (follow-up to the round): a null-path supplementary write survives a
  declared-wrapper construct collision — the dropped dynamic refusals were
  fail-open (`cmd /k echo hi ; echo y > src/$(echo ../../esc)` admitted
  while the plain twin denied). Path-bearing duplicates still collapse.
- N-27 (follow-up): the explain mirror's PowerShell recurse arm matches the
  verb through `dcSegmentVerbMatch` exactly like the gate — the W6
  path-qualified case normalization (`/bin/RM -R …`) had split the surfaces.
- Re-pins: N-28 (`cmd /k` declaration intent), N-12 (perl cluster writes,
  relocated to a sibling file for the FR-006 ratchet), N-14 (the vacuous
  `/dynamic|BLOCKED/` assertions tightened), N-11 (the win32-only separator
  pin made platform-agnostic).

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
  the deny direction, deliberately accepted (review advisory 2). Verb
  basename extraction normalizes case in BOTH arms (executed ground truth,
  #3572 N-19): the write arm matches `/bin/MV`, `/bin/CP`, `/bin/LN`,
  `/bin/TOUCH`, `/bin/SED -i` (deny direction — an absolute path-qualified
  POSIX verb is treated as the resolved program), and `/bin/RM` never
  matches the write-arm verb table only because `rm` itself is not a
  write-arm verb (the destructive arms catch it case-insensitively); the
  POSIX-relative `./rm`/`../rm` stay project-local.
- Perl cluster forms (`perl -i -pe '…'`, `perl -ne`) now carry an
  `interpreter_eval` write alongside their in-place report, so they route like
  `python -c`: denied for a scope-less architect and for a scoped coder while
  the eval runs outside the declared scope (`cd src && …` admits). Previously
  allowed at the workspace root; re-pinned deliberately in the in-place suites.
- A deno global flag that takes an argument before the subcommand
  (`deno --config x eval CODE`) is not modeled; disclosed rather than guessed.
  (Closure round F-2 + round 2, wording corrected #3572 N-18:) a leading
  DASH-WORD RUN of argument-less global flags before the subcommand is
  TRANSPARENT — `eval` after it classifies `interpreter_eval`
  (`deno --no-prompt eval CODE`, `deno --no-prompt --unstable-kv eval CODE`,
  `deno --unstable-kv --no-check eval CODE`, mixing known and unknown
  argument-less flags; executed ground truth: `interpreter_eval` fires),
  not a W3 uncertainty denial. A NON-DASH word inside the run is a flag
  argument (`deno --config x eval CODE`), the subcommand position is
  unknowable, and the disclosed no-classification disposition stands. The
  same transparency governs the stdin run shape: `deno run -A -` (any
  argument-less flag run between `run` and the stdin `-`) classifies
  `deno [eval stdin]` (#3572 N-06 — the write-capable allow-all form was
  inverted against the bare form).
- (Closure round F-4:) `cmd /k` selects the win32 authority exactly like
  `cmd /c` (the payload executes; the shell merely stays open) — the strip
  prefix always modeled `/[ck]`, and the declaration/builtin-prefix
  predicates now match it too. BOTH slash spellings are covered: the MSYS
  double-slash form (`cmd //k`, `cmd //c`, and the switch run before them)
  selects the same authority — Git Bash translates `//k` to `/k` when
  spawning the native binary (executed ground truth).
- (Closure round, curl nuance:) the SPACED `curl -o src/{a,../esc} url`
  spelling emits one write target per branch — bash-true for the GLUED
  `-osrc/{a,../esc}` form (two `-o` flags, both written) and for
  sed/perl/awk `-i` operands (every expanded operand is edited); for the
  spaced curl form real curl treats the second branch as a URL, so the
  per-branch emission is the deliberately fail-closed direction.
  (Closure round 2:) wget's `-O` destination shares the same engine and the
  same spaced-form over-approx (the glued `-Osrc/{a,../esc}` is bash-true:
  two `-O` spellings, GNU getopt FILE-option semantics keep the LAST — the
  escaping branch can win; wget(1) doc-sourced, no wget binary on this
  host). scp's brace-shaped destination word — and ANY literal destination
  emission in the network-downloader family — passes a class-closing
  backstop: an UNQUOTED brace list that did not go through the W8 engine is
  refused as a dynamic write instead of emitted literally (a multi-source
  scp writes the escaping branch when it names an existing directory;
  `isDynamicPath` has no brace check — #3491's own root-cause line).
  (Closure round 3:) the launcher_write family joined the engine too —
  `sudo -e` edit targets and GNU `time -o` report paths (the last
  unbacked literal emitters) now expand per-branch, with the bare-keyword
  `time -o…{…}` spelling keeping its bash-true no-write pin.
  (Closure round 4 — the structural terminal rung:) the isDynamicPath
  brace chokepoint landed: ANY POSIX-detected write whose literal path
  still carries an unquoted brace-list region (archive-decompress, rsync,
  git checkout/restore, and every future emitter) is refused as a dynamic
  write at the detectPosixWrites pass — "zero unbacked literal destination
  emitters" now holds by construction in the POSIX grammar — scoped
  honestly (#3572 N-20): the construction covers emitters that reach the
  W8 engine or the isDynamicPath chokepoint. Known edge inside that bound
  (disclosed, deny-direction gap): a GLUED long-flag destination whose
  flag grammar no extractor walks is a KNOWN UNDETECTED site —
  `tar -x --file=src/{a,b}.tar` emits the literal (admitted when
  in-scope), `tar --file=…` at a non-extraction position is undetected
  entirely, and only the SHORT-flag extraction spelling
  (`tar -xf src/{a,b}.tar`) reaches the chokepoint refusal. POSIX-scoped
  with the Windows detectors carved out (a literal PowerShell/cmd `{a,b}`
  filename keeps its literal handling); a QUOTED brace word is exempt
  (the W8 engine's own raw-scan proves it would not expand). The refusal
  is WHOLESALE for non-engine'd brace destination words — a benign
  in-scope one (`gunzip -d src/{a,b}.gz`) also fails closed as dynamic —
  while engine'd sites keep their per-branch admits; and (final corner)
  a same-text QUOTED twin no longer exempts the unquoted word's write
  (`git checkout main -- src/{a,../esc} 'src/{a,../esc}'` denies).
- (Advisory, PARTIALLY closed by the feedback round:) the tee half of
  #3569's operand-window advisory is fixed — wrapper-prefixed tee
  (`env tee src/f`, `command tee src/f`) no longer fabricates the verb word
  itself as an in-scope write target (the tee branch starts at the resolved
  leaf word). The remaining #3569 scope — direct-write POSITIVE modeling
  through chdir wrappers (`sudo -D src tee a` writes src/a relative to the
  chdir) and the dd branch — stays tracked there.
- (Launcher nesting:) ONE launcher nesting GNU `time -o FILE cmd` is now
  modeled — sudo/nice/nohup exec the inner command directly (no shell), so
  a nested `time` word walks the GNU grammar and surfaces `-o`
  (delta-critic round; `sudo time -o ../../esc true` denies,
  `sudo time -o src/ok.txt true` admits). A command-less sudo with no
  query/reset mode is the IMPLIED INTERACTIVE ROOT SHELL (parse_args.c
  ground truth) and denies like the explicit `sudo -i`; `sudo -k`/-v/-l
  stay admitted (documented no-command no-ops). The getopt `--` sentinel
  applies the same walk decisions (round-3 pins: `sudo --`, `sudo -i --`,
  `sudo FOO=bar` are the implied interactive root shell and deny;
  `sudo -k --`/-v stay benign; `sudo -- time -o …` walks the nested GNU
  grammar). `sudo -D DIR` composes with the nested `time -o` — the
  rewritten child subshell keeps the `time` word QUOTED so the re-detection
  selects the binary grammar (`sudo -D src time -o ok.txt true` admits,
  the escaping twin denies). Remaining disclosed residual (emission-level,
  deny-direction net): a launcher nested TWO levels deep (`nice sudo time
  -o x true`) loses the inner `-o` EMISSION — the walk recurses one
  nesting level only — but the escaping shapes still deny at the gate via
  the unwrap/N-03 net while the in-scope twin admits; tracked in the PR's
  follow-up issue.
- (Implied-shell note:) the command-less-sudo deny models sudo's
  parse_args.c semantics as ground-truthed by the reviewer on a sudo host;
  this host has no sudo binary, so the modeling rests on that citation
  plus the gate's own `sudo -i` parity — flagged for a sudo-bearing
  verification pass in the follow-up issue.
- nohup.out creation stays stdout-tty-gated and out of static reach — disclosed,
  not modeled.

## Test evidence

- New suites `tests/unit/hooks/guardrails-shell-write-interpreter-flags-3491.test.ts`
  (58 tests), `tests/unit/hooks/destructive-command-verb-and-ps-3539.test.ts`
  (56 tests), and the review-round sibling
  `guardrails-shell-write-launcher-depth-3491.test.ts` (13 tests: compound
  depth laundering, quoted time, explain parity); W3 legs added to
  `guardrails-shell-write-launcher-env-3491.test.ts` (80 tests total).
- Closure round: brace-site legs (sed/awk/curl: escaping branch, in-scope
  admit, refusal class) in `guardrails-shell-write-brace-sites-3491.test.ts`
  (sibling of `brace-3491`, which sits at the FR-006 cap); deno uncertainty
  legs in `guardrails-shell-write-interpreter-flags-3491.test.ts`;
  colon-glued write-arm PS legs in `destructive-command-verb-and-ps-3539.test.ts`;
  `cmd /k` legs (bare + path-qualified + in-scope admit) in
  `destructive-command-windows-3491-cmdk.test.ts`. Closure round 2 added the
  wget/scp brace destinations to the `brace-sites` suite (glued `-O`
  escaping deny, spaced in-scope admit, scp backstop refusal, plain control,
  detector pins) and the deno dash-run legs to the interpreter suite.
- Deliberate re-pins: `shell-write-detect-null-device.test.ts` (perl glued
  cluster evalToo rows), `guardrails-shell-write-inplace-unknown-option.test.ts`,
  `guardrails-shell-write-inplace-escapes.test.ts`,
  `guardrails-shell-write-inplace-operands.test.ts` (perl in-place cluster rows
  moved from allowed to eval-blocked).
- Feedback round: `tests/unit/hooks/guardrails-shell-write-3572-feedback-hardening.test.ts`
  (38 tests: N-01 `sudo -e --` edit survival with in-scope admit control, N-02
  timed-tail deny + cd-tracked admit, N-03 escaping-download emission +
  gate deny + admit, N-29 env -S tee detection + nested -S and expansion
  payload refusals + destructive deny, wrapper-prefixed tee leaf offset with
  admit/deny controls, N-25 uncertainty through transparent heads, N-26
  sanitized hostile launcher word, N-13 perl cluster gate pin, N-06 deno
  stdin flag run, N-16 scope_validate channel parity, the delta round
  (quote-grouped env -S splice, glued split-string, paranoid-bound
  transparent heads, declared-wrapper dynamic-refusal carriers, segment-
  contextual timed tail, explain verb parity), and the critic round
  (launcher-nested GNU `time -o`, the implied command-less-sudo root
  shell)) and
  `shell-write-detect-perl-cluster-n12.test.ts` (2 detector pins).
