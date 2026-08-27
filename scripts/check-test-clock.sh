#!/usr/bin/env bash
# Check that test files using the real clock (Date.now / new Date() / spyOn(Date))
# also use the freezeClock helper, so time-sensitive assertions don't flake
# under coverage instrumentation (issue #1782, root-cause class 1).
#
# A test file is a VIOLATION if it contains a raw time read
# (Date.now() / no-argument new Date() / spyOn(Date) ) AND does not reference
# the helper. Date constructors with explicit inputs are deterministic fixtures
# and are intentionally excluded.
# (freezeClock / withFrozenClock / withFrozenClockAsync).
#
# The helper reference is a proxy for "the author considered time-sensitivity."
# It is deliberately permissive on the helper side: any reference counts,
# because the lint cannot do call-graph analysis from bash. Most legitimate
# raw-clock uses (fixture IDs, tmp suffixes) are fine in files that ALSO freeze
# the clock for their assertions. Files that use the clock at all but never
# reference the helper are the ones most likely to add a flaky assertion.
#
# This script is LINE-SCOPED (a narrowing of check-mock-cleanup.sh FB-001's
# file-scoped model):
#   - Pre-existing violations (files not in the PR diff, and files in the diff
#     whose raw-clock uses were already there) → WARNING, non-blocking.
#   - NEW violations (lines ADDED by the PR diff that introduce a raw-clock
#     pattern) → ERROR, blocking.
# Merely touching a file that already violates does NOT promote its pre-existing
# warning to a blocking error — that misattribution is what line-scoping fixes.
# This avoids the day-1 wall of ~473 pre-existing files (issue #1782 plan
# critic C3) while still forcing every NEW time-touching test to acknowledge
# the helper.
#
# Portability (issue #1729 merge_group macOS): bash 3.2 on macOS — no
# associative arrays, no `grep -P`. Plain indexed arrays + grep -E only.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec bun run "${script_dir}/check-test-clock.ts" "$@"
