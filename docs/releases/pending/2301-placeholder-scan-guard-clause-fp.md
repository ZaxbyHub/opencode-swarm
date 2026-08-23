# Fix: placeholder_scan flags guard-clause returns and lowercase xxx paths

## What

`placeholder_scan`'s `placeholder/code-stub-return` rule used a bare per-line regex
that flagged any `return <constant>;`, including legitimate guard-clause early
returns inside non-stub functions. During the 2026-08-08 swarm session this
produced 5 consecutive gate failures (66 findings, ~95% false positives) on
`scripts/drift-check.ts` and `scripts/check-skill-assertions.ts`.

Separately, the `\bXXX\b/i` comment pattern flagged lowercase `xxx` in
path-shape examples (e.g. `../../../.claude/skills/xxx/SKILL.md` in
`scripts/drift-check.ts:1048`).

## Fix

- For parser-supported TS/JS/Python files, `scanWithParser` now performs a
  tree-sitter function-body AST walk after the regex pass. A constant return is
  suppressed as a finding only when it is **not** the function's sole effective
  statement — i.e., the function has substantive subsequent behavior and the
  constant return is a guard clause, not a stub skeleton.
- True stub skeletons (sole statement `return <constant>;`) still fail the gate,
  including block-bodied arrows (`() => { return 0; }`).
- Comments interleaved inside a function body are stripped from the
  effective-statement count, so a `/* TODO */ return null;` skeleton is still
  classified as a stub.
- Nested stub skeletons inside non-stub functions (declarations, methods,
  arrows, function expressions, Python function_definitions) are still
  flagged — only the non-stub body's lines are added to the suppression
  set, and any inner stub's range is subtracted.
- For unparsed extensions (and parse failures), the regex fallback is preserved
  unchanged. `added_lines` diff-aware filtering continues to work as before.
- The `XXX` comment pattern is now case-sensitive (`\bXXX\b` without `/i`).
  Uppercase `XXX` placeholder still flagged; lowercase `xxx` no longer flagged
  in path-shape comments.

## Known limitation

- "Sole effective statement" counting treats any control-flow wrapper around
  a constant return as substantive, even when both branches return the same
  constant with no other behavior — e.g. `function f() { try { return null; }
  catch (e) { return null; } }` or `function f(x) { if (x) { return null; }
  return null; }` are genuine do-nothing stubs but are no longer flagged.
  This trades a class of false positives (guard clauses) for a narrower class
  of false negatives (symmetric-branch stubs); tightening effective-statement
  counting to detect this shape is a follow-up.

## Note for future edits

- Tree-sitter body-shape coverage in this fix is limited to TS/JS/Python.
  Other parser-supported languages (Go, Rust, Java, C/C++, C#, PHP, Ruby) fall
  back to the regex pass for this rule. Expansion to those languages is the
  natural follow-up.
- New `_internals` exports on `src/tools/placeholder-scan.ts`:
  `collectNonStubBodyLines`, `isStubSkeletonFunction`, `isConstantLiteralNode` —
  available for direct testing without `mock.module`.
