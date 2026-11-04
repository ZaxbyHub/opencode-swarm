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
  dirStack) and withdraw, loops accept only a full-state fixpoint, and
  function bodies walk a discarded copy. Withdrawn writes reach the gate as
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
  argv[2] contract: the word after the flag token, or the attached cluster
  tail `-c'code'`), extracted by a quote-aware tokenizer shared with the W2
  serializer. Trailing positionals (`sh -c 'payload' sh`) and same-kind quote
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
  `src/hooks/guardrails/destructive-command.ts`; final-critic round): `-c` is
  honored wherever the sh getopt grammar puts it — as a CLUSTER member
  (`sh -xc`, `bash -lc`, `dash -xc`, `bash -ic`, `bash -ec`, `sh -uc`) or
  after other arg-consuming flags (`bash -eo pipefail -c`) — through one
  shared invocation-flag walk used by BOTH the dc wrapper extractor (heads
  may be path-qualified: `/bin/sh`) and `detectInterpreterEval`'s
  shell-family matcher. The anchored `-c`-first spellings previously
  ADMITTED cluster forms while real bash executes the payload, and
  over-blocked benign multi-flag in-scope forms the same way. A script-file
  operand or `--` carries no payload; an unknown flag of unknowable arity is
  deny-on-uncertainty (the eval classifier fires, the wrapper never
  unwraps). Python/perl/ruby cluster handling is untouched (W7/PR-3).

## Known edges

- `pushd ±N`, `pushd -n`, `popd ±N`, `;&`/`;;&` case fall-through, and
  `cd`/`cd -` with reassigned `HOME=`/`OLDPWD=` fail closed (withdrawal) by
  design — inherited shell state is unavailable statically.
- Control-flow bodies whose directory landings diverge over the complete
  state (e.g. `if …; then cd x; fi` without `else`) withdraw later writes
  instead of fabricating a merge; benign in-scope writes inside the body are
  unaffected.
- The `env -C`/`sudo -D` rewrite consults the existing env-flag grammar;
  deeper launcher option tables (sudo `-u`, `time -o`, nice) arrive with the
  G3 launcher workstream (PR-3; #3491 AC3/AC4 residuals).
- Process-substitution masking and brace-expansion write destinations are
  the PR-2 workstream's deferred set (not yet in the extractor's disclosed
  grammar).
- A same-directory `cd` deliberately does not refresh `OLDPWD` in the model
  (bash does): keeping the state stable avoids spurious control-flow
  divergence, and the omission is conservative/fail-closed. A `CDPATH=`
  reassignment on the line does not yet withdraw CDPATH-eligible `cd`
  operands (review round 1 non-blocking note).

## Verification

- Frozen checks from the trace: C1 (cd word forms), C2 (env -C/-S), C5
  (sh -c payloads), C12 (pushd in control flow) all pass; preserving checks
  C13 (fixed cd family) and C14 (write suites) stay green.
- New suites: `guardrails-shell-write-cd-word-forms-3491`,
  `guardrails-shell-write-launcher-env-3491`,
  `guardrails-shell-write-shc-payload-3491` (plain, trailing-positional,
  quote-concat, and flag-cluster payload spellings), and
  `guardrail-explain-shell-write-parity-3491` (explain/gate parity).
