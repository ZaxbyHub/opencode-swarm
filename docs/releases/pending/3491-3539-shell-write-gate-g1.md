# Shell Write Gate: Directory State, Child-Scoped Chdir Wrappers, sh -c Payload (G1)

## What changed

- **Directory-state model for the write gate** (`src/hooks/shell-write-detect.ts`):
  the resolver walk now threads one `DirectoryState` (`{cwd, prevCwd, dirStack}`)
  through both passes instead of a bare cwd stack. `cd` word forms resolve-or-
  withdraw: bare `cd` / `cd ~` / `cd ~/x` land at `$HOME` (withdrawn when the
  line reassigns `HOME=`), `cd -` lands at the modeled `prevCwd` (withdrawn
  when unmodeled or `OLDPWD=` is reassigned), and dynamic operands (`cd $VAR`)
  withdraw later writes — the historical literal-append could fail OPEN under
  a broad declared scope. `pushd`/`popd` are tracked (push, bare swap, pop;
  `±N`/`-n`/stack-overflow withdraw), and `cd -P src` / `cd -- src` now track
  the real operand. Conditionals carry both outcomes explicitly: pipelines
  run components on isolated state copies with post-pipeline withdrawal,
  `if`/`case` branch copies diverge over the COMPLETE state (cwd + prevCwd +
  dirStack + withdrawal flag — #3567 feedback PRR-001) and withdraw, loops
  accept only a full-state fixpoint, and function bodies walk a discarded
  copy that inherits (never zeroes) the context withdrawal. Withdrawn writes reach the gate as
  `resolvedPath: null` with an additive `unresolved` marker; a withdrawn
  capability eval denies before any `evalDirectory` fallback (#3491 AC1/AC3,
  #3539 AC1/AC5).

- **Child-scoped env/sudo chdir through a quoted subshell transform**
  (`src/hooks/guardrails/destructive-command.ts`, `tool-before.ts`,
  `guardrail-explain-service.ts`): chdir-bearing wrapper segments
  (`env -C DIR`, `env -S '…-C DIR…'`, `sudo -D DIR`) rewrite at the gate as
  correctly-quoted subshells `( cd -- 'DIR' && <re-unwrapped inner> )`, so the
  wrapped command's writes resolve under the CHILD cwd while following
  siblings stay at the parent cwd (bash-true). DIR is emitted through a POSIX
  single-quote serializer (`'` → `'\''`); expansion-bearing operands
  (`$VAR`, `~`, `$(…)`, globs) are never serialized — the segment rewrites to
  a withdrawal form whose inner writes withdraw. Nested chdir wrappers
  compose as nested subshells. The destructive arm receives an evolving
  per-segment directory context (inner `cd`s tracked; unrepresentable
  mutations relocate to a deny-on-uncertainty sentinel), and
  `/swarm guardrail explain` shares the same preprocessing (#3491 AC2/AC4).

- **Shared `sh -c` payload extractor** (`src/hooks/guardrails/destructive-command.ts`):
  the payload is the single quote-removed word the `-c` flag selects (sh's
  argv[2] contract: the next standalone word after the flag cluster),
  extracted by a quote-aware tokenizer shared with the W2 serializer.
  Trailing positionals (`sh -c 'payload' sh`) and same-kind quote
  concatenation (`'\''`) no longer defeat the unwrap, and words after the
  payload ($0/$1…) are never scanned as commands (#3491 AC5/AC7).

- **Review round 1 hardening** (`destructive-command.ts`, `tool-before.ts`,
  `guardrail-explain-service.ts`): the uncertain-DIR withdrawal form uses a
  synthetic dynamic cd operand, so it withdraws UNCONDITIONALLY — the first
  round's synthetic `cd -` landed at a modeled `OLDPWD` after a preceding
  `cd`/`pushd` and admitted the wrapped writes. The destructive arm's
  child-cwd context is keyed per OCCURRENCE instead of per segment text
  (first-wins text keying let `env -C src rm -rf dist; env -C .. rm -rf
  dist` inherit the first occurrence's in-scope context). `/swarm guardrail
  explain` mirrors the gate's null-path decision tree — withdrawn/dynamic
  write targets answer block, and inspectable evals route through their
  tracked working directory exactly like the gate.

- **sh-family flag-cluster payloads** (`src/hooks/shell-write-detect.ts`,
  `src/hooks/guardrails/destructive-command.ts`; final-critic rounds 2–5):
  the covered grammar is bash-true, complete over four dimensions —
  [which letters are options] (clusters like `-xc`/`-ceu`; unknown letters
  are deny-on-uncertainty), [where arg-taking members draw arguments]
  (`o`/`O` take the next standalone word VERBATIM as their optname —
  `bash -eo pipefail -c …`, `bash -oc pipefail 'code'` — and a dash-led
  optname is erroring bash rc=2; cluster tails are always MORE option
  letters), [which word `c` selects] (`c` does NOT grab the next word
  verbatim: option parsing CONTINUES past it and the command string is the
  FIRST NON-OPTION word — `bash -c '-e' 'code'`, `bash -c -x 'code'`,
  `bash -c -o pipefail 'code'`, `bash -c -c 'code'` all execute the last
  word), and [`--` handling] (`--` and a lone `-` end option parsing; with
  a pending `c` the FIRST operand after the terminator is the command
  string, flag-shaped or not — `sh -c -- 'code'` runs; without one it is
  the script-file operand). Long flags are recognized only before
  short-option parsing starts (bash's "[GNU long option] [option]" order;
  `bash -c --rcfile F 'code'` errors rc=2 ⇒ deny-on-uncertainty). One
  shared invocation-flag walk feeds BOTH the dc wrapper extractor (heads
  may be path-qualified: `/bin/sh`) and `detectInterpreterEval`'s
  shell-family matcher. The earlier anchored `-c`-first spellings, the
  round-2 tail-as-payload rule, the round-3 o-branch tail-eating rule, and
  the round-4/5 verbatim-word rules all ADMITTED executing forms while
  real bash runs the payload; the anchored form also over-blocked benign
  multi-flag in-scope spellings. The tail-glued `-c'code'` and
  `-opipefail` spellings, unknown flags, a pending `-c` with no operand,
  and clusters sharing two or more arg-taking members (`-oc`, `-co`) are
  deny-on-uncertainty (the eval classifier fires, the wrapper never
  unwraps). Long `--rcfile`/`--init-file` keep the spaced next-word form
  (and the gate-tolerated `=value` gluing, valid only in the leading long
  phase). Python/perl/ruby cluster handling is untouched (W7/PR-3).

## Known edges

- `pushd ±N`, `pushd -n`, `popd ±N`, `;&`/`;;&` case fall-through, and
  `cd`/`cd -` with reassigned `HOME=`/`OLDPWD=` fail closed (withdrawal) by
  design — inherited shell state is unavailable statically.
- Control-flow bodies whose directory landings diverge over the complete
  state — now INCLUDING the withdrawal flag (#3567 feedback PRR-001: a
  withdrawn branch is divergence) — withdraw later writes instead of
  fabricating a merge; benign in-scope writes inside the body are unaffected.
- A `||` chain whose LEFT operand is not a statically-provable failed
  directory command and whose RIGHT branch moves directories now withdraws
  later writes (#3567 feedback PRR-012: the chain models both the skipped
  and the execute-from-pre-left outcomes; disagreement withdraws). The old
  skip-only model admitted `cd nope/sub || cd ../..; write` while bash ran
  the right branch; the new model over-denies `cmd || cd x; write` where the
  left is likely to succeed — fail-closed by design (both candidates walk,
  and disagreement withdraws; no candidate adoption is claimed).
- A function CALL whose body contains a directory transition withdraws later
  writes (#3567 feedback P-F5: bash runs the body in the current shell at
  CALL time, so the call-time landing is unknowable from the definition). A
  function definition no longer zeroes an inherited withdrawal either
  (PRR-002): body writes inherit the definition-context withdrawal.
- Same-directory `cd`/`pushd` now refresh `prevCwd` exactly like bash
  refreshes `OLDPWD` (#3567 feedback PRR-006: `cd ..; cd .; cd -` lands at
  the workspace parent, where bash lands it). A `CDPATH=` reassignment on
  the line still does not withdraw CDPATH-eligible `cd` operands.
- The `env -C`/`sudo -D` rewrite consults the existing env-flag grammar,
  extended to GNU abbreviation spellings (`--ch=DIR`, `--c DIR`) so the
  chdir is captured (#3567 feedback P-R1). `env -S 'payload'` is NOT yet
  modeled as a re-parsed command: the strip consumes the payload as flag
  arguments, so `env -S 'rm -rf …'` / `env -S 'sh -c "… > …"'` remain
  under-detected (base behavior; the payload-routing fix lands with the G3
  launcher workstream — disclosed, not silently assumed). Deeper launcher
  option tables (sudo `-u`, glued `-D..` arity, `time -o`, nice) arrive
  with G3 (PR-3; #3491 AC3/AC4 residuals).
- Process-substitution masking and brace-expansion write destinations are
  the PR-2 workstream's deferred set (not yet in the extractor's disclosed
  grammar); an unquoted `$(...)` operand to a chdir wrapper now FAILS the
  rewrite closed (#3567 feedback P-F3) instead of serializing a mangled
  operand, and those commands deny via the parse-failure channel.
- A shell-family launcher whose flag cluster the walk cannot model
  (`bash -oc pipefail 'payload'` — ground truth: the payload executes)
  denies outright (#3567 feedback PRR-003) instead of leaving the payload
  uninspectable. A shell `-c` payload's statements are SPLICED AS A
  PARENTHESIZED SUBSHELL (#3567 final-critic round): the payload's inner
  `cd` can no longer move the parent walk state (`bash -c 'cd src'; echo x
  > f` judges f at the session cwd, bash-true), and payload-internal
  writes judge at the child cwd exactly like bash. On the DESTRUCTIVE arm
  the payload's statements additionally relocate to the uncertain
  sentinel (an inner `cd` re-bases later statements above the session
  cwd) — the fail-closed price is the over-block of no-cd
  multi-statement payloads on that arm. A same-directory `pushd` does not
  grow the directory stack in the model (bash pushes a duplicate entry),
  so a `popd` after a same-dir `pushd` can withdraw where bash returns to
  the same directory — deny-direction, disclosed.
- Denial MESSAGE classes: shapes the #3567 feedback fixes route through the
  fail-closed withdrawal or wrapper-walk channels now deny with the
  withdrawal (`dynamic path target …`) or parse-failure message instead of
  the older single-landing scope message; the verdict (reject) is unchanged
  and the affected pins were re-pinned with the wider class alternations.

## Verification

- Frozen checks from the trace: C1 (cd word forms), C2 (env -C/-S), C5
  (sh -c payloads), C12 (pushd in control flow) all pass; preserving checks
  C13 (fixed cd family) and C14 (write suites) stay green. (The trace's
  repro harness lives in the git-excluded `.agents/issue-traces/` scratch
  tree, not the published package; the shipped assertions are the in-repo
  suites below.)
- New suites: `guardrails-shell-write-cd-word-forms-3491`,
  `guardrails-shell-write-launcher-env-3491`,
  `guardrails-shell-write-shc-payload-3491` (plain, trailing-positional,
  quote-concat, and flag-cluster payload spellings), and
  `guardrail-explain-shell-write-parity-3491` (explain/gate parity), plus
  `guardrails-shell-write-3567-feedback-hardening` — the #3567 feedback
  pins (withdrawal propagation per construct, function seam, prevCwd
  refresh, redirect hoist, `$()` fail-closed, flag-cluster deny, payload
  isolation, both-outcome `||`, resolution precedence, backslash segment
  split, env abbreviation capture).
