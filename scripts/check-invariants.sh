#!/usr/bin/env bash
# ZERO-LOGIC SHIM.
#
# The engineering invariant gate now lives in scripts/check-invariants.ts so
# Windows, macOS, and Linux all execute the same policy owner. This shell path
# remains for existing workflow, skill, and release-note references only.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
exec bun run "${script_dir}/check-invariants.ts" "$@"
