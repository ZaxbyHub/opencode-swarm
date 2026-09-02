#!/usr/bin/env bash
# Issue #1737 FR-011 — lint for the macOS /var -> /private/var symlink gap.
# `os.tmpdir()` returns a path under `/var/...` on macOS, but `/var` is itself
# a symlink to `/private/var`; production code that canonicalizes paths (e.g.
# containment guards) compares against the resolved `/private/var/...` form.
# A test that creates a fixture via the raw path and checks it via the
# canonicalized path silently diverges on macOS CI. tests/helpers/tmpdir.ts
# (canonicalTmpDir / canonicalMkdtemp) exists so new tests don't reintroduce
# this bug piecemeal.
#
# LINE-SCOPED (not file-scoped, unlike check-mock-cleanup.sh/check-test-clock.sh):
# ingest found ~250 pre-existing raw os.tmpdir()/mkdtempSync() occurrences
# across 30+ test files; retrofitting them is explicitly out of scope (FR-011
# scope decision). A file-scoped check (flag the whole file if ANY PR touches
# it) would false-fail on unrelated changes to those files. This check instead
# diffs at the line level (`git diff --unified=0`) and only flags lines
# ADDED by the current diff, so pre-existing raw calls elsewhere in a touched
# file never trip it.
#
# A violation is an ADDED line calling `tmpdir()` — matching both `os.tmpdir()`
# and the bare `tmpdir()` form used via `import { tmpdir } from 'node:os'`
# (both idioms are in active use across tests/) — that does NOT also contain
# `realpathSync` on the same line (the repo's established one-line idiom, e.g.
# `fs.realpathSync(os.tmpdir())`). Prefer `canonicalTmpDir()` /
# `canonicalMkdtemp(prefix)` from tests/helpers/tmpdir.ts instead of
# hand-rolling the wrap.
#
# Project-relative temp roots are also rejected. Tests that create `tmp/` below
# the checkout can leave runtime `.swarm/` state in the repository and couple
# otherwise-isolated files through a shared directory. The line-scoped check
# catches both direct calls and the historical `const baseDir = 'tmp'` helper
# shape while leaving pre-existing occurrences outside the diff untouched.
#
# KNOWN LIMITATION: Plain-text substring match, not syntax-aware, so `tmpdir()`
# in string literals/comments also trips it. Accepted tradeoff for a portable bash
# script (no JS/TS parser) — fails safe (over-flags) rather than silently missing
# violations. Rephrase any false-positive string/comment to avoid the substring.
#
# Portability (issue #1729 merge_group macOS): bash 3.2 on macOS — no
# associative arrays, no `grep -P`. Plain indexed arrays + grep -E only.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec bun run "${script_dir}/check-test-tmpdir.ts" "$@"
