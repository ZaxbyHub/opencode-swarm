# `syntax_check`: an empty check set no longer records a passing verdict

## What

`syntax_check` returned `verdict: 'pass'` with `files_checked: 0` whenever its
filters left nothing to check, and wrote that green result into the durable
evidence store. Observed in a live PR review, where the tool's first invocation
reported *"All 0 files passed syntax check"* and that verdict was persisted as
evidence.

Three paths produced an empty set, all silently:

1. `changed_files: []`.
2. The default `mode: 'changed'` drops every entry with `additions === 0` —
   deletion-only files and pure renames vanish with no note.
3. A `languages` filter that matches nothing.

A gate that examined nothing is not a gate that passed. Anyone later reading the
evidence bundle could not distinguish "syntax is fine" from "the input never
reached the parser".

The verdict is now `'skip'` (already a member of `EvidenceVerdict`) whenever
`files_checked === 0`, and the summary names the specific cause and its remedy,
for example:

```
No files were checked — mode='changed' dropped files with additions === 0
(deletion-only or pure-rename entries); pass mode='all' to include them.
This is NOT a passing syntax check.
```

The `mode` description also no longer misstates its own behavior. It previously
read *"'all' = all files in repo"*, but the tool never enumerates the
repository — both modes only ever inspect the entries passed in `changed_files`;
`'all'` merely skips the `additions > 0` filter.

## Why

A vacuous pass is worse than a failure: it is indistinguishable from real
verification at the point where the evidence is consumed, so it silently
weakens every gate built on top of it.

## Migration

`syntax_check` callers that branch on `verdict === 'pass'` will now see `'skip'`
for empty check sets. No production code in this repo branches on the verdict
value (checked by grep), so nothing downstream changes. Callers that treated
"All 0 files passed" as success were relying on the defect.

Tests that pinned the old behavior are updated rather than deleted, each with the
reason recorded inline:
- three cases asserting `'All 0 files passed syntax check'` now assert `'skip'`
  plus the specific cause named in the summary;
- four cases where every supplied file was skipped as `unsupported_language` now
  assert `'skip'` — a file that was skipped was not checked;
- one case where processing throws still asserts `'pass'`, because a throw counts
  toward `files_checked`, so the set is not empty and the new branch does not
  apply;
- one allowed-verdict list read `['pass', 'fail', 'skipped']` — `'skipped'` was
  never a member of `EvidenceVerdict`, so that assertion had been silently
  accepting only `pass`/`fail`. Corrected to `'skip'`.

## Invariant audit

- **Invariant 11 (tool/agent-map coherence).** No parameter, tool, or agent
  surface is added — only the verdict value for an already-reachable branch and
  two description strings. `drift:check` passes.
- No new module-level state, so invariant 8 is not engaged.

## Verification

Regression coverage added in `tests/unit/tools/syntax-check.adversarial.test.ts`
(`empty check set never reports a passing verdict`), including an assertion that
the non-passing verdict reaches `saveEvidence` and not merely the return value,
plus a paired `mode: 'all'` case proving the remedy named in the summary actually
works. Verified to bite: stashing the fix fails both new tests.

Net-new failures across all four `syntax-check*` suites, measured against the
same suites without this change: **0** (58 pass / 30 fail before and after; the
30 are pre-existing and environmental).
