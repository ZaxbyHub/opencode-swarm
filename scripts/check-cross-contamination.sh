#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
exec bun run "${script_dir}/check-cross-contamination.ts" "$@"
