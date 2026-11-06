# Shell Write Gate: Procsub Masking + Residual Resolution, Brace-Expanded Destinations (G2)

## What changed

- **Process-substitution masking + residual resolution (#3539 W5 / AC1–AC2,
  RC-5)** (`src/hooks/shell-write-detect.ts`, `tool-before.ts`,
  `guardrail-explain-service.ts`): on a parse-failing `>(…)` line the
  detector no longer runs the procsub-only partial scan whose success
  cleared the fail-closed flag — the shape that let one clean in-scope
  procsub write launder a second, undetected outer write
  (`tee >(cat > src/ok) ; echo x > /etc/passwd` admitted). It now masks
  every BALANCED, quote-aware, unquoted-unescaped `>(…)`/`<(…)` span
  (nesting counted; comments and quoted/escaped `>(` never masked; only
  GLUED `>(`/`<(` — spaced `> (x)`, `>>(x)`, `<<(`, `>&(` are real bash
  syntax errors and stay failing), replaces each span with a
  token-preserving `/dev/null` placeholder, and parses the RESIDUAL with
  bash-parser. When the residual parses clean the OUTER writes come from
  the normal AST detectors on it, the masked INNER writes come from the
  FULL detector family run on each span body (#3568 feedback PRR-001 — the
  original per-stage scan recognized only the builtin set plus simple
  redirects, letting tee/dd/curl/sed -i/python/rsync/archive and nested
  `<(` bodies through), and the analysis returns the residual as
  `residualCommand` — the
  gate and `/swarm guardrail explain` resolve surviving writes against
  the RESIDUAL, so `cd ..; tee >(cat > src/ok); echo x > src/f` resolves
  the outer write at the tracked post-cd directory and denies. The
  placeholder is suppressed by the EXISTING sink-device exemption inside
  both the detection and resolver walks (no new string matching: a real
  `/dev/null` operand was already a non-target, and occurrence numbering
  never depends on placeholder removal). Inner writes withdraw
  (`unresolvedContext`, the proven #3518 P-3 channel) whenever their body
  OR the residual prefix before the span carries a directory-selection
  word (`cd|pushd|popd` — `tee >(cd ..; cat > src/f)` denies; a `cd` after
  the span does not withdraw; the backslash-escaped verb spelling
  `\cd ..` withdraws too — #3568 F-04). Anything short of full success — zero
  maskable spans, an unbalanced/ambiguous span, an unparseable residual —
  keeps the parseError UNCONDITIONALLY: the legacy whole-command regex
  fallback still emits its writes for observability, but its partial
  success never clears the fail-closed flag again. `<>` (LESSGREAT)
  remains a write. Read-only `<(cmd)` lines with no writes no longer
  parse-block. `bash -c` payload procsub stays on the W4 unwrap surface.

- **Brace-expanded write destinations (#3491 W8 / AC7, RC-9)**
  (`src/hooks/shell-write-detect.ts`): unquoted `{a,b}` comma lists and
  plain numeric ranges (`{1..3}`, ascending and descending) in a write
  destination — redirect operands, builtin operands (cp/mv/install/ln/
  truncate/rmdir), `tee` positionals, `dd of=` — expand to one write
  target per branch, Cartesian across at most 2 regions and 8 branches,
  emitted identically by the detection walk and BOTH resolver walks so
  every branch pairs with its tracked context (`cd src; echo x > {a,b}`
  admits at ws/src; `cd src; echo x > {a,../../x}` denies). The engine is
  quote-aware on the raw word source, matching executed bash ground
  truth: quoted/escaped braces and commas never expand
  (`'{a,b}'`, `"\{a,b\}"`, `{a\,b}` stay literal), a comma list beats a
  `..` alternative (`{1..3,x}` → `1..3`,`x`), `${a,b}` is a parameter
  expansion (kept literal, denied as a dynamic `$` path), `{a}`/`{a..}`/
  `{..3}`/`{ab..cd}` are literals, and a quoted alternative inside an
  unquoted region still expands (`{a,"b"}`). Real expansions the model
  refuses to enumerate exactly — nested braces, empty alternatives
  (`{a,,b}`), alpha/signed/zero-padded/stepped sequences (`{a..c}`,
  `{-1..2}`, `{01..3}`, `{1..7..2}`), >2 regions, >8 branches — classify
  the write DYNAMIC: a null-path write the gate's existing dynamic-target
  block denies (fail-closed). The procsub-body fallback channel shares
  the engine, so `tee >(cat > src/{a,../../x})` enumerates its branches
  too. Final-critic round: the dynamic refusal is wired UNCONDITIONALLY at
  every destination site (the tee/dd closures' empty-path test previously
  discarded the refusal write — a fail-open that admitted
  `tee src/{a,b}/{c,d}/{e,../../../x}` while bash writes the escaping
  branch), a word with ANY dynamic branch (`src/{a,$(echo b)}`) refuses
  as a whole, and the dynamic-target denial renders the user's SOURCE
  word (`dynamicSourceWord`) instead of brace-substituted branch text.

## Known edges

- A brace expansion in a destination served by detectors outside this
  workstream's site list (curl `-o`, sed `-i` operands) was a FAIL-OPEN
  residue while this PR shipped: the operand read literally, while real
  bash expands it and writes the escaping branch when the target directory
  exists. PR-3 (the g3 closure round) LANDED those site grammars — the
  sed/perl/awk `-i` in-place operands and curl's `-o`/`--output`
  destinations now route through this same brace engine, so the residue is
  closed there.
- Per-site multi-branch semantics are ground-truthed and deliberately
  OVER-APPROXIMATED where bash refuses (final-critic F-2, executed GT):
  a multi-branch REDIRECT operand is an "ambiguous redirect" (rc=1, no
  write; a single-branch `f{1..1}` writes), a ≥2-branch cp/mv destination
  fails "target is not a directory" (no write), and `dd of=` keeps only
  the LAST expanded operand — which can itself be the escaping branch
  (`dd of=src/{a,../ddesc}` writes the outside file). The model judges
  EVERY branch at these sites instead of modeling the refusals: deny when
  any branch escapes, admit when all are in scope — a superset of what
  bash writes, never fail-open. tee/truncate/rmdir are bash-exact
  multi-write commands.
- `> >(cat > f)`-style redirect-into-procsub relies on the placeholder's
  sink-device exemption; a procsub operand in a `cp`/`truncate`
  destination position emits a bogus `/dev/null` write (fail-closed deny)
  rather than modeling the pipe.
- Operator boundaries follow bash's greedy redirect lexing (executed
  ground truth): `<<(x)`, `>>(x)`, `<<<(x)`, `<>(x)`, `>&(x)`, `<&(x)`,
  `>|(x)` and `&>(x)`/`&>>(x)` are operator + `(` — genuine bash syntax
  errors (rc=2, nothing runs) that keep the parse-error block (never
  masked), while `>>>(x)` is `>>` + a glued `>(x)` whose body bash RUNS
  (masked and analyzed, like `><(x)` = `>` + `<(x)` and the escaped-`&`
  midword `\&>(x)`). A spaced `> (x)` never masks.
- An unbalanced procsub span or a masked residual that still fails to
  parse hard-blocks the line even when the legacy fallback found writes —
  deliberate fail-closed supersedure of the old partial-clear behavior
  (one detector-level pin re-pinned accordingly in
  `shell-write-detect-null-device-exact.test.ts`: a `>(cat > /dev/null)`
  body is now analyzed and exempted instead of parse-blocked).
- A `#` comment inside a procsub body can close the span early for the
  scanner; the residual then fails to parse and the line keeps the
  fail-closed parseError (over-block direction only).
- `cat <(ls)`-style no-write procsub lines now admit at the write gate;
  whether the command then runs depends on the host sandbox arm (weak
  PowerShell wrapper without the native Windows runner rejects some
  shapes — an environment behavior outside this gate, pinned
  detector-level in the shipped suite).
- Procsub span BODIES are pushed to the destructive arm with an UNCERTAIN
  child-cwd context (#3568 F-01: a body `rm -rf …` sits at the body's own
  verb position), so any destructive verb inside a procsub body relocates
  to the escaping sentinel — an over-block for benign destructive-in-procsub
  shapes, disclosed (fail-closed).
- `touch` is now a modeled write builtin (every operand; #3568 F-01 — the
  operand loop was previously invisible to both walks, admitting
  `touch ../../esc` at base too), and `cp -t DEST` emits DEST as a write
  target alongside the last-operand destination (#3568 PRR-009 — bash
  writes DEST/<basename>).
- A FULLY-quoted brace token (`dd "of=../../src/{a,b}"`) no longer
  mis-slices across its quote wrapper (#3568 F-02): the braces stay
  literal (bash truth) and the whole literal path is the judged write.
- Numeric brace ranges refuse BEFORE materialization (#3568 PRR-006 —
  the sequence was built first and only then cap-checked: `{1..100000000}`
  cost GB-scale RSS and a 20-digit endpoint never terminated; both now
  classify dynamic in milliseconds). The procsub body recursion is DEPTH-
  BOUNDED (8 levels; reviewer F-b — nested re-masking was super-linear:
  28KB at 4000 levels measured 17.4s vs 6ms base) and fails closed past
  the bound (a depth-cap body surfaces as a null-path unresolved write —
  delta-critic round: the cap originally dropped the nested write
  entirely, reopening the F-01 class at depth 9).
- `/swarm guardrail explain` does NOT mirror the destructive-arm sentinel
  relocation for procsub span bodies (reviewer F-c): the live gate denies
  `true <(rm -rf .swarm)` via the body's uncertain-context relocation,
  while explain can answer allow for the same shape (the write-scope
  mirror blocks the body's WRITE verbs; the destructive relocation is
  gate-only). `scope_validate` DOES deny the shape (DESTRUCTIVE_COMMAND).
  Disclosed asymmetry — the gate is the enforcement surface.
- touch option VALUES (`-d/-t/-r` short-with-separate-arg and the long
  `--date/--reference/--time` forms) are consumed, not judged as targets;
  path-qualified leaves (`command /usr/bin/touch x`) locate the verb by
  basename. `cp -tDEST` (attached short value) is modeled alongside the
  spaced and `=` forms. An UNQUOTED `dd of=$VAR` emits the dynamic
  refusal; a QUOTED `of=$VAR` expansion remains invisible (pre-existing
  at base — the quote wrapper defeats both the word gate and the
  expansion detection; disclosed).

## Verification

- Frozen checks from the trace: C7 (brace expansion) and C9 (procsub +
  outer writes) flip to CHECK OK; preserving checks C13 (fixed cd family)
  and C14 (write suites: dual-resolution-3530, rmdir-scope-cwd,
  env-flags-3343 — 155 tests) stay green. PR-1 checks C1/C2/C5/C12
  re-run green at this head (built on the G1 branch).
- New suites: `guardrails-shell-write-procsub-outer-3539` (43 legs: C9
  families, orderings both ways, quoted outer operands, outer builtins,
  fd-dup exclusion, the residual-context discriminator, inner-cd
  withdrawal, `bash -c` payload non-overlap, malformed-residual blocks,
  operator-boundary shapes, the here-string over-block pin,
  admit/block controls, detector-level residual + placeholder pins,
  explain parity) and `guardrails-shell-write-brace-3491` (52 legs: C7
  families, destination families with per-site bash ground truth,
  quoted/escaped ground truth, Cartesian regions, duplicate branches,
  dynamic-class denials wired at EVERY destination site, tracked-cd
  resolver pairing, explain parity).
- Battery: the full `guardrails-shell-write-*`, `destructive-command-*`,
  `shell-write-detect-*`, co-located `src/hooks/shell-write-detect*`, and
  explain-service suites pass per-file; typecheck, pinned biome, and
  `check:invariants`/`check:test-file-cap` clean.
