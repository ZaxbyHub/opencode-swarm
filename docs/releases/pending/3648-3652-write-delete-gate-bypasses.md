---
'opencode-swarm':
  - issue: 3648
  - issue: 3652
---

# Fix: shell write/destructive gates judge awk programs, xargs-fed verbs, sudoedit, shred, chroot roots, paren-led login sudo, and GNU-time payloads (#3648, #3652 items 2-4 + dispositions)

Seven previously admitted write/delete-gate bypass spellings now deny, the
same-family residuals from #3652 get pinned dispositions, and the planted-link
redaction in authority denials gains its first test pin:

- **awk/gawk/mawk/nawk/original-awk inline programs**
  (`awk 'BEGIN{print > "../secret"}'`, `awk 'BEGIN{system("rm -rf ../x")}'`)
  now classify as interpreter evals — exact `python -c`/`perl -e` parity.
  `awk -f progfile data` keeps the script-file carve-out, and
  `awk -i inplace <clean-program> <operand>` keeps the in-place carve-out —
  the carve-out applies ONLY when the program text carries no output
  redirection, pipe, `system(…)` or `getline` (an `-i inplace` edit whose
  program also writes elsewhere classifies as an eval; `-i inplace` does not
  disable `print >` — verified against real gawk). DISCLOSED over-deny: every
  inline awk program — including benign `awk '{print}'` — is judged as an eval
  under a declared scope (same contract as `python3 -c 'print(1)'` today);
  run from an in-scope cwd it admits.
- **xargs-fed delete/write verbs** (`echo ../x | xargs rm -rf`, `xargs rm -rf`,
  `find .. | xargs rm -rf`, `xargs -I{} cp src/a {}`) withdraw fail-closed —
  stdin-supplied targets are statically unknowable. The verb position is
  CLASSIFIED, not just table-matched: an interpreter/shell verb
  (`xargs sh -c 'rm -rf ../secret'`, `xargs python3 -c …`,
  `echo x | xargs awk 'BEGIN{print > "…"}'`), a launcher verb
  (`xargs env rm …`), a nested `xargs`, or an expansion-bearing verb
  (`xargs "$CMD" …`) withdraws too, and the walk anchors on the
  wrapper-consumed tail so group-wrapped forms (`(sudo xargs cp …)`) deny.
  DISCLOSED over-deny: with an UNKNOWN xargs option the verb position is
  unknowable and any write-verb word in the remaining words triggers the
  withdrawal.
- **`sudoedit`** is recognized as an edit form with its documented option
  synopsis; `sudoedit ../secret.txt` denies. `sudoedit -h HOST` edits on a
  remote host — every operand withdraws (landing unmodeled). `sudoedit -R DIR`
  withdraws relative operands (chroot base unresolvable for edits).
- **`shred`** operands are overwrite write-targets (`shred ../x` denies,
  `shred src/a` admits under scope `src/`), with the documented GNU grammar
  (`--remove[=how]` glued value; detached words stay operands; numeric
  filenames after `--` are real operands).
- **`sudo --chroot`/`-R DIR`** re-bases the wrapped tail: relative operands
  are judged under the chroot root (`sudo --chroot ../X cp a src/esc.txt`
  denies), and any tail containing an absolute write spelling (including
  embedded `dd of=/abs` targets) withdraws whole-tail — DISCLOSED over-deny:
  legitimate in-chroot absolute writes deny too. Repeated `-R` is a sudo
  usage error and denies. Wrapper-owned outer redirects
  (`sudo --chroot /r true > src/ok.txt`) stay judged at the invoking cwd.
- **Parenthesized login sudo** (`( sudo -i sh -c 'cd src && rm -rf x' )`,
  glued **argument-free** `(sudo -i`/`((sudo -i`/`{sudo -i;}` — including the
  nested standalone+glued forms and the stdin-fed pipe of the argument-free
  form, `echo … | (sudo -i)`, brace groups) no longer escapes the login-shell
  withdrawal; `>(cat)`/`2>(wc)` redirect openers are untouched. DISCLOSED
  pre-existing residual: glued forms carrying a command argument
  (`echo … | (sudo -s sh)`) remain admitted (base-class gap tracked in #3688).
- **GNU `time` payloads** are analyzed: `time -o src/t.txt sh -c "echo x >
  ../y.txt"` denies (bare keyword and GNU spellings) for WRITE payloads, and
  time-masked RECURSIVE DELETES deny under the default config too
  (`time -o f sh -c "rm -rf ../y"`, glued `-oF`, `--output=`, unknown
  options, and interposed env/timeout/nice/`bash -lc` wrappers withdraw
  fail-closed — including `nice -n N` adjustment values and `env` heads
  before the time word; the Homebrew GNU-time binary `gtime` peels like
  `/usr/bin/time`; the launcher peel is iterative under the shared
  64-head bound and refuses past exhaustion) while the pinned admissions hold (`time -o ../secret` alone,
  `time -o x true`, bare glued-brace forms, `time make build`, the in-scope
  timed delete `cd src && /usr/bin/time -o r.txt rm -rf build`, and both
  N-02 forms `cd src && /usr/bin/time -o ok.txt true` / `cd src && 'time'
  -o ok.txt true`). DISCLOSED known-edge: bare-keyword `time -o ../esc <cmd>` stays
  admitted — emitting the `-o` target for the bare spelling would break the
  two pinned admissions above; under bash the keyword reading never opens the
  file, under dash it may.
- **#3652 dispositions delivered** (issue stays open for the AC16
  owner decision): item 5 (quoted-time cd over-deny) bounded and pinned;
  item 6 (D6 >-word heuristic) accepted and pinned; item 7 (new file through
  an in-scope directory link) bounded and pinned — full fix needs scope-root
  + target canonicalization together; item 8 (rm ambiguous abbreviations)
  accepted and pinned; items 9-10 executor env-scrub feasibility note in the
PR body. The planted-link redaction (`re-rooted target crosses
symlink/junction "…"` in AUTHORITY_ROOT_ESCAPE details) is pinned by a new
suite driving the escaping-relative arm through a real junction fixture on
every host and the different-filesystem-root arm on hosts where a second
filesystem root is constructible (registered linked worktree on the second
root; the leg skips with a diagnostic elsewhere).
