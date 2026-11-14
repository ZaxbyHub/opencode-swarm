---
issue: 3165
---

# Review-backlog remainder: sandboxed allowlist tests, sandbox-home AC-010, bare-token redaction, path-aware Tier-3

Delivers the #3165 C-2/C-3/F-1/F-2 slice plus the #2910 delivery audit (issue
stays open; `Refs` not `Closes`).

- **C-2:** `scripts/generate-mock-allowlist.sh` gains `MOCK_ALLOWLIST_OUT`
  (redirects regenerated output AND `--check` comparison input); the test suite
  now runs entirely against sandbox copies and asserts the tracked
  `scripts/mock-allowlist.txt` is byte-identical after every run (previously the
  suite rewrote the tracked file and restored it in `afterEach` — an interrupted
  run left it mutated).
- **C-3:** BOTH real-home AC-010 sandbox tests (macOS `sandbox-exec` and the
  Linux bwrap sibling) now derive their broad scope from a test-created sandbox
  home with positive (sandbox file exists) and negative (nothing under the real
  home) assertions; an unavailable executor FAILS the validation instead of
  silently passing.
- **F-1:** `sanitizeFailureEvidenceDisplay` redacts bare well-known credential
  VALUE shapes (`sk-…`, `gh?_…`, `github_pat_…`, `AKIA…`, `xox[baprs]-…`,
  `AIza…`) wherever they appear — prose placements with no `key=value` span
  (e.g. the real OpenAI "Incorrect API key provided: sk-proj-…" error text)
  previously shipped in cleartext to `logger.warn`, oversight events, and pause
  reasons. A mirror-parity suite pins the display redactor and
  `redactShellCommand` against the same token corpus. The same gap in the
  training-capture redactor (`src/training/redact.ts`) is NOT fixed in this PR
  — see the PR body for the recorded disposition (its fix requires
  consent/export redaction-version decisions).
- **F-2:** the Tier-3 classifier is now path-aware and fail-closed: `guardrails/`
  and `sandbox/` directory segments, singular+plural `credential(s)` names and
  prefixes, exact repo paths (`src/cli/index.ts`, `src/tools/phase-complete.ts`,
  `src/plan/ledger.ts`), and cwd-independent normalization that classifies
  blank/absolute/`~`/`..` entries as Tier 3 (closing a Turbo Stage-A bypass
  where blank or `./`-prefixed `files_touched` entries skipped the security
  review block). The Turbo banner and `docs/modes.md` rule lists updated; the
  architect's independent QA-tier policy is deliberately untouched. A runtime
  census test guards against future silent drops (the PR #2224 class).
- **#2910:** per-row delivery audit published (dual-shape export, guidance
  parity fixture, tools parity + registration check, hooks/events, storage,
  v2-host-smoke CI lane, docs/invariants); the three genuinely-open design
  deltas (external-directory lane scoping, `text.complete` re-homing design,
  per-guard behavioral matrix) are enumerated as #2910's remaining scope in
  `docs/host/v2-hook-inventory.md`.
