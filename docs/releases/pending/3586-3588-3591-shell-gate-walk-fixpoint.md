---
title: Shell write-gate walk fixpoint — loops, launcher nesting, sudo payloads, rm coverage
issue: "3586, 3588, 3591"
---

# Shell write-gate walk fixpoint

## What

Six shell write-gate fixes, collated from #3586 + #3588 + #3591 (the
residuals of the #3491 → #3590 hardening series). One defect class: the
gate's static shell model admitted whenever its bounded walk stopped before
the shell semantics did.

1. **Loops whose directory state alternates no longer admit iteration-2
   writes (#3586).** `cd src; for i in 1 2; do echo x > f; cd ..; done` was
   admitted with the write judged at iteration 1's directory, while real
   bash writes `f` at the workspace root on iteration 2. When one full
   loop iteration's landing differs from the loop's ENTRY state, every
   write the loop collected — `while`/`until` clause writes included — is
   withdrawn fail-closed. The comparison basis is the PRE-clause entry
   state, so a `cd` living in the re-executing clause drifts too:
   `cd src/sub; i=0; while cd ..; [ "$i" -lt 2 ]; do i=$((i+1)); echo x >
   f; done` (real bash writes `src/f` and then the escaping
   workspace-root `f`) now denies. Net-zero loop bodies (no net `cd`)
   keep admitting. The only exemption is a `for` whose word list is a
   single fully-literal word (no glob, brace, tilde, `!` or expansion) in
   a command with no dynamic-execution builtin anywhere in the analyzed
   AST as seen after wrapper preprocessing (trap, alias, set, shopt, …;
   segment-leading `eval`/`exec`/`builtin`/`source` are unwrapped by
   preprocessing before this census and so do not contribute — the
   wrapper-collapse residual below covers what that omission means):
   that loop runs exactly once, so `cd src; for i
   in x; do echo x > f; cd ..; done` still admits.
2. **Two-level launcher chains surface their inner write targets
   (#3588).** `nice sudo time -o src/ok.txt true` lost the inner `time -o`
   target; the detector now follows launcher-headed tails to any depth
   (bounded).
3. **Nested command-less `sudo` denies (#3588).** `sudo sudo -i`,
   `sudo FOO=bar sudo -i`, `nice sudo -i` and `nice sudo -z true` were
   admitted; the launcher-uncertainty channel now re-walks nested launcher
   tails.
4. **Non-plain payload words under `sudo -i`/`-s` deny (#3588).** Any tail
   word carrying whitespace, a shell operator, a quote, `$`, or brace/comma
   structure now denies; plain multiword tails (`sudo -i make build`) keep
   admitting. One shape was a verified bypass: sudo 1.9.15p5 leaves `$`
   unescaped when it re-joins the words for the login shell's `-c`, so
   `sudo -s 'touch$IFS/tmp/x'` creates the file. The rest
   (`sudo -i 'echo x > ../esc'`, `${IFS}`, `{a,b}`) reach the shell as one
   literal word on that sudo version, so those denials are conservative:
   other sudo builds, including sudo-rs, have not been checked.
5. **`sudo -D DIR -e FILE` denies relative edit targets (#3588).**
   `cd src; sudo -D /etc -e shadow` was admitted. sudo 1.9.15p5 opens edit
   targets against the invoking directory, and `-D` only moves the
   editor's working directory, so #3588's premise that the target lands
   under DIR is wrong on that version. Other sudo builds are unverified,
   so relative targets under `-D` now deny as unresolved. Absolute targets
   are judged as written.
6. **Plain, quoted-flag, and late-flag `rm` are scope-checked (#3591).**
   Policy decision (AC10): **scope containment, modeled on
   `unlink`/`rmdir`** — every operand of a non-recursive, non-forced `rm`
   (flagless, or `-i`/`-v`) is now judged against the declared scope, so
   `rm ../esc` denies and `rm src/temp.ts` keeps admitting. GNU option
   permutation is honored — flags AFTER operands (`rm foo -rf
   ../../outside`) AND quote-spelled flags (`rm "-rf" ../../outside`,
   `rm '-f' x`) are classified by the same shared parse (bash strips the
   quotes), so quoted recursive/forced shapes hit the same guards as
   their unquoted twins: the protected-`.git`/`.swarm` arm, the
   filesystem-root guard, the traversal guard, and the build/cache
   allowlist. The destructive check validates every target for
   traversal/containment before the allowlist, so the escaping target is
   the one named. The gate, `/swarm guardrail explain` and the
   `scope_validate` tool agree on these shapes.

`rmdir src/{a,../esc}` was re-verified as already denied (every brace
branch is checked) — no change needed.

## Behavior changes (conservative flips, enforced roles)

- A loop whose body changes directory and does not return to its entry
  directory now denies writes inside it — including the previously
  admitted bare-`break` form `while true; do cd src; echo x > f; break;
  done`. A `break` cannot be trusted: the ambient environment (a
  `BASH_ENV` startup file or an exported `break` function) can redefine it
  outside the command text. Applies to every enforced write-capable role,
  architects included; unchanged where write enforcement is inactive.
- `sudo -i`/`sudo -s` with a quoted compound payload denies even when the
  payload's targets are in scope (the joined command is not statically
  judgeable). Payload words carrying `$` or brace/comma structure deny the
  same way. Only bare `$`-expansion is a confirmed bypass; the other
  shapes are conservative denials (see item 4).
- `sudo -D DIR -e` with a relative edit target denies, in or out of scope
  (`sudo -D src -e shadow` was admitted at the previous emission's
  in-scope path). `sudo -D DIR -e /absolute/path` is judged at the
  absolute path. Tilde-leading operands (`sudo -D src -e ~/shadow`) fail
  closed as dynamic, including a quoted literal `"~/x"`, which the gate
  cannot tell apart once quotes are removed.
- Two loop and flag shapes change direction. `cd src; while cd .. && [ -z
  "$d" ]; do cd src; echo x > f; d=1; done` was withdrawn and now admits,
  which matches bash (the write lands in `src/f`). In-scope late-flag
  `rm src/a.ts -f` now denies like `rm -f src/a.ts`.
- A `for` word list longer than 4096 characters loses the single-literal
  word exemption, so a loop that changes directory denies its writes.
- `rm $X`, `rm "$D"/x` and `rm ~/x` now deny as dynamic targets for
  enforced roles, and architect and other enforced-role `rm` of protected
  paths is now checked.
- `rm -i ../esc` (and other non-destructive flags with an out-of-scope
  operand) now denies; in-scope `rm -i` keeps working.
- A scope-LESS coder session's non-recursive, NON-FORCED `rm` now denies
  with `SCOPE_NOT_DECLARED` exactly like any other shell write (`echo x > f`,
  `unlink`, `tee`, …): without the write-authorization scope the operands
  cannot be verified (invariant 9). With a declared scope, in-scope
  operands keep admitting. This also covers flagless `rm .swarm/file` when
  `block_destructive_commands` is disabled — the write-authorization layer
  owns the operand, not the destructive arm. (FORCED/recursive `rm` shapes
  under `block_destructive_commands: false` are unchanged, and no layer
  judges them: the destructive gate is switched off, and the write
  detector hands destructive rm shapes to that gate instead of emitting
  their operands as writes — so `rm -rf ../outside` admits in that
  configuration. Pre-existing; see Residuals.)

## Supersedes

The `3569-3570-shell-write-gate-windows` fragment's residual "Flagless `rm`
with a single LITERAL out-of-scope target remains admitted" is superseded:
item 6 above closes it, so that residual no longer applies.

## Residuals (disclosed)

- GNU long-option abbreviations (`rm --rec`, `--forc`) are not recognized as
  recursive/forced (exact-match only; pre-existing). The surfaces also
  disagree on them: `rm --rec src` is admitted by the gate and by
  `explain`, but `scope_validate` reports `DESTRUCTIVE_COMMAND`.
- `sudo -i` changes to the target user's home directory before running the
  command (sudo(8); verified with sudo 1.9.15p5: `cd /tmp/ws && sudo -i tee
  src/ok.txt` writes `/root/src/ok.txt`). The gate resolves the relative
  target at the workspace cwd, so `sudo -i tee src/ok.txt` admits while the
  real write lands under the target home, as that user. `sudo -s` keeps the
  cwd and is resolved correctly. Pre-existing, not changed here.
- Forced/recursive `rm` under `block_destructive_commands: false` is judged
  by no layer (see Behavior changes, item 6 note). Pre-existing.
- The brace-expansion regex scan is length-capped only at the `for`
  word-list position. The sed picker, `curl -o` destination and `scp`
  destination checks still scan unbounded words (a 40k-char unclosed-brace
  `curl -o` operand costs about 1.5 s per walk, and several stack).
  Pre-existing.
- `env` between launchers stops the launcher walk: `nice env time -o ../x
  true`, `nice env sudo -i` and `sudo env sudo -i` are admitted, so the
  nested-launcher denials in item 3 do not cover env-interposed chains.
  Pre-existing.
- `pushd .` is not modeled as pushing a duplicate stack entry, so `cd src;
  pushd ../tests; pushd .; popd; echo x > f` is judged at `src/f` while
  bash writes under `tests/`. Pre-existing.
- `rm` operands are judged lexically, so `rm link/../src/x` is judged as
  `src/x`. Where `link` is a symlink to another tree, Linux resolves the
  `..` through the link and deletes the file in that other tree. The gate
  blocks creating escaping symlinks, but one already in the workspace is
  enough. Pre-existing.
- Launch-environment sanitization (`BASH_ENV` / `BASH_FUNC_*` scrubbing at
  the shell-spawn layer) is not in scope; the loop withdrawal is the
  command-text-level mitigation.
- Writes inside command substitutions in For word-list / clause WORD
  positions are not enumerated (pre-existing; e.g. `for i in $(echo x >
  ../esc)`).
- A `for` loop inside a FUNCTION body is walked once at the
  definition-time cwd on a discarded copy, but executes once per call — a
  single-literal-word exempt loop in a function called after a `cd` writes
  at the call-time directory, which the definition-time walk does not
  model (pre-existing shape; the exemption does not worsen it).
- A `sudo -D DIR` EXECUTED command (non-edit) wrapped behind a launcher or
  shell wrapper (`time sudo -D /etc tee src/ok`, `bash -c "sudo -D /etc
  tee src/ok"`) has its chdir dropped by the wrapper collapse: the write
  resolves at the ambient cwd while real sudo writes under DIR as root
  (pre-existing; the plain unwrapped form denies via the chdir rewrite).
  Tracked as a follow-up.
- `/swarm guardrail explain` WITHOUT `--scope` leaves out the scope
  dimension and shows no verified-scope marker, so it can read "allow"
  for a command the gate denies. Example, coder with scope `src/`:
  `rmdir src/{a,../esc}` is denied by the gate, blocked by
  `explain --scope src/`, denied by `scope_validate`, but explain without
  `--scope` reports "allow: no rule matched" with an unverified Resolved
  Scope. Pre-existing (the verified-scope omission in
  `guardrail-explain-service.ts`), not changed here; tracked as a
  follow-up.
- Bounded over-deny: a write AFTER an exempt single-word `for` loop
  (`cd src; for i in x; do echo x > f; cd ..; done; echo y > src/g`) is
  denied via the withdrawn post-loop state even though one iteration
  exactly determines the landing directory (real bash writes both files
  in scope). The loop's own writes keep admitting; only later siblings
  over-deny.
- `sudo` verification (AC6) on sudo 1.9.15p5: bare `sudo`, `sudo --`,
  `sudo FOO=bar`, `sudo FOO=bar --` print usage and run nothing, while the
  gate denies them — a recorded, deliberate deny-on-uncertainty divergence
  (no fail-open risk). `sudo -i` opens a real root shell (denied);
  `-k`/`-v`/`-l`/`-k --`/`-- FOO=bar` run nothing (admitted).

## Tests

Five new suites (`guardrails-shell-write-loop-withdraw-3586`,
`-launcher-nest-3588`, `-sudo-edit-chdir-3588`, `-rm-scope-3591`,
`-rm-parity-3591`) plus THREE justified re-pins of shipped expectations,
each with an in-file rationale:

1. `guardrails-shell-write-cd-word-forms-3491` (the bare-`break` while
   pin): ADMIT → DENIED — the ambient-environment break-redefinition
   record (fourteen plan-critic rounds).
2. `guardrails-swarm-path-evasion.adversarial` `rm src/temp.ts` (scope-less
   coder): ALLOWED → SCOPE_NOT_DECLARED — direct consequence of the AC10
   scope-containment policy (the identical flip `unlink src/temp.ts` would
   produce in the same fixture).
3. `guardrails-swarm-path-evasion.adversarial` `rm .swarm/file`
   (`block_destructive_commands=false`): ALLOWED → write-layer scope block
   — same policy; the full rationale and strengthened assertions live in
   `guardrails-shell-write-rm-scope-3591` (the FR-006 ratchet forbids
   growing the over-cap evasion file, so the relocated block keeps the
   audit trail without growing it).
