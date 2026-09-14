# Quarantine three merge-group flaky tests (issue #2740)

## What changed

- Appended three new entries to the CI quarantine ledgers, each carrying the
  structured `# OWNER:` / `# EXPIRY:` metadata block required by
  `scripts/check-invariants.ts` Check 7 (issue #2477):
  - `tests/unit/services/evidence-summary-adversarial.test.ts` → general
    ledger, `scripts/ci/quarantined-tests.txt` (ubuntu-latest flake; no
    per-OS ledger exists for ubuntu, matching the #2368 dispatch-lanes
    precedent)
  - `tests/unit/utils/bun-compat-exit-first-2530.test.ts` → macOS ledger,
    `scripts/ci/quarantined-tests-macos.txt`
  - `tests/unit/commands/promote-registration.test.ts` → macOS ledger,
    `scripts/ci/quarantined-tests-macos.txt`
- No source or hook code changed. The two ledger files are the only
  repository files modified, plus a consumer-side regression test
  (`tests/unit/scripts/ci/ci-yml-quarantine-2740.test.ts`) that pins the three
  new ledger entries, and this pending release fragment.

## Why

Issue #2740 was auto-filed by the `flake-detection` workflow (issue #1782,
`scripts/ci/detect-and-quarantine-flakes.sh`) after a merge-group CI run
reported all three paths as flaky candidates (each with a `Passed on retry`
annotation, so the ci.yml retry loop discarded the attempt-1 output — no
assertion text exists to drive a root-cause fix).

Triggering merge-group run 34726206593 (filed by flake-detection run
34728138233 at 2026-09-13T00:30Z), with the flake annotation located in each
shard's log:

- `tests/unit/services/evidence-summary-adversarial.test.ts` — `unit
  (ubuntu-latest, 2)`; attempts 1 and 2 both failed, passed on retry 2. The
  "should not block on slow event handlers" case registers a real 100 ms
  `setTimeout` handler and asserts
  `expect(duration).toBeLessThan(500)` at
  tests/unit/services/evidence-summary-adversarial.test.ts:882 — under
  merge-group runner CPU contention the publish can exceed the 500 ms budget.
  Sibling ubuntu/macos/windows shards green.
- `tests/unit/utils/bun-compat-exit-first-2530.test.ts` — `unit
  (macos-latest, 4)`; passed on retry 1. Most tests shell out to `bun build`
  plus a `node` probe under hard 5 s timeouts
  (`PROBE_TIMEOUT_MS` at
  tests/unit/utils/bun-compat-exit-first-2530.test.ts:9) — a macos-latest
  runner stall >5 s trips the probe timeout. Sibling shards green.
- `tests/unit/commands/promote-registration.test.ts` — `unit
  (macos-latest, 6)`; passed on retry 1. `beforeEach` mutates
  `process.env.HOME` / `LOCALAPPDATA` / `XDG_DATA_HOME` to redirect the hive
  knowledge path into a fresh `mkdtempSync` temp dir (cleaned in `afterEach`)
  — the classic env-mutation + temp-dir teardown surface (#1782 class).
  Sibling shards green.

All three files pass locally on this checkout (62 pass / 0 fail across the
three files in 4.51 s), confirming the flakes are environment-sensitive
(merge-group runner pressure) rather than logic bugs. The `unit
(windows-latest, 4)` failure in the same run was `close-active-state-unlink-
retry.test.ts` — unrelated (already root-fixed surface, different file, and
the detect job did not flag it).

## Migration steps

None. Quarantine is a CI-gating data change: the ci.yml unit-shard discovery
pipeline (`grep | sort | comm`) now excludes these three paths from the gated
test set on the relevant OS (general ledger applies to all OSes, macOS ledger
to macos-latest only).

## Known caveats

- Entries carry EXPIRY 2026-10-14 (30 days out; inside the 14-day grace
  window Check 7 only warns). They must be root-fixed or renewed before the
  expiry closes; the recommended root fixes are noted in each entry's
  `# EXPIRY` criterion line.
- Ledger placement is per-OS evidence-based: the evidence-summary flake was
  single-detection on ubuntu-latest so it landed in the general ledger (no
  ubuntu-specific ledger exists); the two macOS flakes landed in the macOS
  ledger. If any file later flakes on a second OS, it should be split or
  moved accordingly.
- These are the first macOS-ledger entries added alongside the #2738 signal
  test; both ledgers are independent of the windows ledger (STATUS: 2
  entries) and the general ledger (now 1 active entry).
