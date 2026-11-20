---
issue: 3304
---

# Correction: required-check CRLF fixture and Migration / Behavior-change wording (v7.195.0 notes)

The v7.195.0 section "Required-check workflow hash is line-ending independent"
is already published and its body is immutable, so — like the #3289 erratum for
its mechanism paragraph — these corrections ship as this erratum rather than as
edits to `docs/releases/v7.195.0.md`. Nothing here changes behavior: the
fixture's assertions and the checker's normalization are untouched.

## What changed

Three accuracy corrections to the wording that shipped with the `sha256()` CRLF
normalization, plus the matching comment fix in
`tests/unit/scripts/required-check-contract-evidence-2677.test.ts` (comment
only; both assertions are unchanged):

1. **How the fixture produces its CRLF working copy.** The published Change
   paragraph and the fixture's own comment said it rewrites the working copy
   "exactly the way `core.autocrlf=true` does". In fact the fixture keeps
   `core.autocrlf` set to `false` and writes the CRLF bytes directly with
   `writeFileSync`, so no git conversion path runs. What it actually does —
   and all the test needs — is produce the byte-level state a CRLF checkout
   would serve, then prove `sha256()` normalizes that state against the
   recorded LF hashes. The comment now describes that byte-level rewrite.

2. **Migration claim scoped to the current tree.** The published Migration
   sentence — `docs/ci/required-check-evidence.json` "is unchanged — its
   recorded hashes already describe the committed blobs" — holds only for the
   `localWorkflowHashes` of the tree being checked (all three match the
   committed blobs on current `main`), and must not be read as a property of
   the capture record. `capturedWorkflowFiles` pins blob IDs at `captureSha`,
   and those stop describing the tree as soon as a contract-owned workflow
   changes after capture: at the #3293 review head, the `012c4e40d`-pinned
   record already mismatched `drift-check.yml` and `pr-standards.yml`, and the
   current record pins `pr-standards.yml` at blob `7d2683b6…` while HEAD's
   blob is `b17171d9…`.

3. **Behavior-change narrowing disclosed.** The published Behavior change
   paragraph covered only the CRLF-checkout case. Because `sha256()` in
   `scripts/check-required-check-contract.ts` normalizes `\r\n` before
   hashing, `WORKFLOW_CHANGED_AFTER_CAPTURE` also no longer fires for a
   **CRLF-only edit** to a contract-owned workflow — such an edit is
   indistinguishable from a checkout line-ending artifact and is not flagged
   as drift. A lone `\r` (one not part of any `\r\n` pair) is not normalized
   and still changes the hash. A real content change still fires everywhere.

## Why

Issue #3304 (from the #3293 review): the fixture comment overstated what the
test exercises, and the release wording hid a real narrowing of local drift
detection. Comments and release notes that claim more than the code does are
how the next reader mis-diagnoses a Windows-only `drift` failure.

## Migration steps

None. Wording and a test comment only; no code, config, or behavior change.

## Known caveats

The normalization narrowing itself is unchanged (explicitly out of scope for
#3304): CRLF-only edits to contract-owned workflows remain unflagged by design
until a policy decision says otherwise. The lone-CR case still hashes
differently and fires.
