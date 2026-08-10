#!/usr/bin/env bash
# Issue #2078 — ZERO-LOGIC SHIM.
#
# The FR-006 500-line test-file cap ratchet (issue #1781 E1) now lives in
# scripts/check-test-file-cap.ts so it runs identically on Windows, macOS, and
# Linux. This shim exists only so the historical `scripts/check-test-file-cap.sh`
# path keeps working for existing docs, release-note fragments, and muscle
# memory. It MUST NOT contain any cap value, ratchet rule, or env-var parsing —
# every such decision belongs to the TypeScript implementation, which is the
# single source of truth. Adding logic here re-creates the drifting-clone
# problem issue #2078 was filed to prevent.
#
# Preferred cross-platform invocation:
#   bun run check:test-file-cap
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
exec bun run "${script_dir}/check-test-file-cap.ts" "$@"
