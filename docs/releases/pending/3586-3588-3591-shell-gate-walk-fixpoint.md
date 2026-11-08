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
   f; done` (real bash writes `src/sub/f` and then the escaping
   workspace-root `f`) now denies. Net-zero loop bodies (no net `cd`)
   keep admitting. The only exemption is a `for` whose word list is a
   single fully-literal word (no glob, brace, tilde, `!` or expansion) in
   a command with no dynamic-execution builtin (eval, source, trap,
   alias, set, shopt, …): that loop runs exactly once, so `cd src; for i
   in x; do echo x > f; cd ..; done` still admits.
2. **Two-level launcher chains surface their inner write targets
   (#3588).** `nice sudo time -o src/ok.txt true` lost the inner `time -o`
   target; the detector now follows launcher-headed tails to any depth
   (bounded).
3. **Nested command-less `sudo` denies (#3588).** `sudo sudo -i`,
   `sudo FOO=bar sudo -i`, `nice sudo -i` and `nice sudo -z true` were
   admitted; the launcher-uncertainty channel now re-walks nested launcher
   tails.
4. **Quoted compound payloads under `sudo -i`/`-s` deny (#3588).**
   `sudo -i 'echo x > ../esc'` (and `sudo -i echo 'x > ../esc'`) were
   admitted although the login shell's `-c` re-joins and executes them.
   Any tail word carrying whitespace or shell-operator structure under
   `-i`/`-s` now denies; plain multiword tails (`sudo -i make build`) keep
   admitting.
5. **`sudo -D DIR -e FILE` resolves the edit target under DIR (#3588).**
   `cd src; sudo -D /etc -e shadow` was admitted as `src/shadow`; relative
   edit targets now resolve under the `-D`/`--chdir` directory, while
   absolute targets are judged as written.
6. **Plain and late-flag `rm` are scope-checked (#3591).** Policy decision
   (AC10): **scope containment, modeled on `unlink`/`rmdir`** — every
   operand of a non-recursive, non-forced `rm` (flagless, or `-i`/`-v`)
   is now judged against the declared scope, so `rm ../esc` denies and
   `rm src/temp.ts` keeps admitting. GNU option permutation is honored:
   `rm foo -rf ../../outside` is treated as recursive and denies naming
   `../../outside` (the destructive check now validates every target for
   traversal/containment before the allowlist, so the escaping target is
   the one named). The gate, `/swarm guardrail explain` and the
   `scope_validate` tool agree on all three shapes.

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
  judgeable).
- `sudo -D DIR -e /absolute/path` is judged at the absolute path (a target
  outside scope now denies).
- `rm -i ../esc` (and other non-destructive flags with an out-of-scope
  operand) now denies; in-scope `rm -i` keeps working.
- A scope-LESS coder session's non-recursive `rm` now denies with
  `SCOPE_NOT_DECLARED` exactly like any other shell write (`echo x > f`,
  `unlink`, `tee`, …): without the write-authorization scope the operands
  cannot be verified (invariant 9). With a declared scope, in-scope
  operands keep admitting. This also covers `rm .swarm/file` when
  `block_destructive_commands` is disabled — the write-authorization layer
  owns the operand, not the destructive arm.

## Supersedes

The `3569-3570-shell-write-gate-windows` fragment's residual "Flagless `rm`
with a single LITERAL out-of-scope target remains admitted" is superseded:
item 6 above closes it, so that residual no longer applies.

## Residuals (disclosed)

- GNU long-option abbreviations (`rm --rec`, `--forc`) are not recognized as
  recursive/forced (exact-match only; pre-existing).
- Launch-environment sanitization (`BASH_ENV` / `BASH_FUNC_*` scrubbing at
  the shell-spawn layer) is not in scope; the loop withdrawal is the
  command-text-level mitigation.
- Writes inside command substitutions in For word-list / clause WORD
  positions are not enumerated (pre-existing; e.g. `for i in $(echo x >
  ../esc)`).
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
