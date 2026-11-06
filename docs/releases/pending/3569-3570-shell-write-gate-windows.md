---
title: Shell write-gate detector residuals round 4
issue: "3569, 3570"
---

## What

Five shell write-gate detector fixes, collated from #3569 + #3570 (the
#3491/#3539 program's final-critic residuals) and stacked on the g3 branch:

1. **Nested `sh -c` chains no longer admit destructive payloads (#3570).**
   `dcNormalizeCommand`'s blind `''` evasion collapse corrupted the POSIX
   `'\''` embed-a-quote splice, so 3+-level chains truncated to the bare verb
   and admitted `rm -rf ../../outside` payloads that real bash executes. The
   collapse now skips backslash-escaped pairs, and a chain nesting >= 3
   `sh -c` layers withdraws fail-closed when — and only when — its iterative
   unwrap collapses to a single token (the truncation signature): escaping
   multi-token payloads reach the verb arms and deny naming the real target,
   and in-scope 3-level writes keep admitting (levels 1-2 always unchanged).
2. **Wrapper-prefixed `tee`/`dd` resolve their real operands (#3569).** The
   tee/dd operand windows now read the wrapper-consumed token tail, and
   `scope_validate` routes through the same canonical wrapper-chdir
   preprocessing the gate uses — `sudo -D src tee a` / `env -C src tee ok.txt`
   admit with exactly `[<ws>/src/a]` instead of denying on fabricated
   `ws\tee` targets; escaping operands deny naming the real path.
3. **Destructive rm targets expand brace regions (#3569).** `rm
   src/{a,../esc}` denied nothing at base (flagless shapes never reached the
   extractor; forced shapes had the closing brace stripped). Brace-bearing rm
   targets are now destructive in both flag states, expand every branch, and
   dynamic/over-cap expansions withdraw fail-closed; the expansion engine
   refuses adversarial ranges BEFORE materialization (bounded, not ~2.2 GB).
4. **scp destinations are modeled by the real grammar (#3569).** The last
   operand is the destination; remote sources no longer fabricate local
   `ws\host:f` targets; plain local escapes (`scp f src/../esc`) are caught;
   zero/one operand (usage error) transfers nothing; the #3491 brace-refusal
   backstop is preserved.
5. **Process-substitution span bodies get full-body detection (#3569).**
   Every `>(…)`/`<(…)` body routes through the whole mainline detector
   family set (gunzip/tar/curl/rsync/sed/tee/dd/… previously invisible), with
   an 8-level recursion cap, fail-closed parse/depth propagation, restored
   linear span accounting (the quadratic per-span join is gone), and the
   destructive span-body push restored in both the gate and explain
   pipelines.

## Why

Each face was an executed-probe-verified admission or false-denial at the
stacked base (see the trace's reproduction table): a security:high admission
class (#3570), a false-deny class with fabricated targets (#3569 core), and
three residual admissions folded into #3569's comments.

## Known edges

- Chains nesting >= 3 `sh -c` layers WHOSE ITERATIVE UNWRAP COLLAPSES TO A
  SINGLE TOKEN deny fail-closed even when the hidden payload is in scope —
  no textual re-parse can recover the lost words at that depth; multi-token
  chains (including in-scope 3-level writes) keep their normal verdicts,
  pinned by tests.
- Wrapper-prefixed brace operands over-block conservatively: `env -C src
  tee {a,b}` denies (the brace's first branch word is emitted as a target
  and resolves at the parent cwd) even when every expanded branch would
  land in scope. Fail-closed; pre-dates this PR (the wrapper-window work
  surfaced it).
- Flagless `rm` with a single LITERAL out-of-scope target remains admitted
  (a different, separately tracked coverage class — see the PR's
  "Considered, not filed" table).
- The scp option table is pinned from the installed OpenSSH binary; unknown
  glued-value long flags fail closed.

## Tests

Five new suites (`guardrails-shell-write-shc-nested-quote-3570`,
`-wrapper-tee-dd-3569`, `-destructive-brace-3569`, `-scp-destinations-3569`,
`-procsub-full-body-3569`) plus the 35-suite frozen battery green.
