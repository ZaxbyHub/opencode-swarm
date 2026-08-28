#!/usr/bin/env bash
# ZERO-LOGIC SHIM.
#
# The bash-3.2 portability scan now lives in scripts/check-bash-portability.ts.
# This shell path remains for existing workflow, documentation, and release-note
# references only.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
exec bun run "${script_dir}/check-bash-portability.ts" "$@"
