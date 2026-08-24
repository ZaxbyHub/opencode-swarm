# Release-notes pipeline hardening: cubic-race protection, CHANGELOG fallback, repaired bare releases

## What changed

- **Cubic-race protection for release PR bodies.** Third-party PR-description bots (observed: cubic on release PR #2331 — the injected notes block was wiped 7 seconds after the update-pr job wrote it) can rewrite the release PR body after `release-notes-fragments.mjs update-pr` injects the `custom-release-notes` block. The script now settles and re-verifies after every attempt (default 45s window, ~6× the observed rewrite delay, via `FRAGMENT_SETTLE_DELAY_MS`), and when the block vanishes it re-runs a FULL attempt — re-reading the live body and re-extracting PR candidates from it, never reusing stale notes. Two failed attempts emit a visible `::warning::` instead of failing silently.
- **CHANGELOG fallback for bare GitHub Releases.** release-please occasionally creates a release with an empty body (seen on v7.146.1 and v7.145.1). `update-release` previously exited 0 with "no PR references" and the release stayed bare forever. It now falls back to the release's own CHANGELOG.md section (whose `/commit/<40-hex>` links resolve to the source PRs), injects the fragments from there, and — when a section exists but yields no candidates — fails the job loudly (`::warning::` + exit 1) instead of passing green. A release with genuinely no changelog section (degenerate meta release) still exits 0. The failure is advisory: it does not gate npm publishing.
- **Repaired the two bare releases** (v7.146.1, v7.145.1) by running the new fallback against them; both now carry their full fragment notes.

## Why

Releases cut after some merges shipped with completely empty release-notes bodies while others carried rich notes, depending on who won a silent race. Two root causes: the cubic bot rewriting release PR bodies seconds after injection, and release-please occasionally creating releases with empty bodies that the enrichment script then silently skipped.

## New CI gate

`check:pending-fragment` (scripts/check-pending-fragment.ts, wired into the CI quality job) now enforces the AGENTS.md mandate that every user-visible PR ships a `docs/releases/pending/<unique-slug>.md` fragment: a diff touching `src/`, `package.json`, workflows, or shipped skills without adding a fragment fails CI (escape hatch `FRAGMENT_CHECK_ENFORCE=0`). This closes the silent-omission gap where a user-visible PR shipped with no release notes at all.

## Migration

No action required. `FRAGMENT_SETTLE_DELAY_MS=45000` is the only new knob and defaults sensibly. Follow-up (out of scope here): consumed-fragment cleanup — `docs/releases/pending/` accumulates fragments (534 files today) because nothing removes them after a release consumes them.
