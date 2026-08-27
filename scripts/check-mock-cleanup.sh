#!/usr/bin/env bash
# Check that test files using mock.module have proper cleanup.
# Cross-module mock.module is permitted per two-tier convention,
# but must have afterEach(mock.restore()) or documented exception.
#
# FB-001: This script is non-blocking for pre-existing violations.
# It only fails if the PR DIFF introduces NEW violations.
# Pre-existing violations are reported as WARNINGS, not errors.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec bun run "${script_dir}/check-mock-cleanup.ts" "$@"
