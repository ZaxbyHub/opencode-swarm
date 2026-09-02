#!/usr/bin/env bash
# Shared normalization library for mock.module allowlist checks.
# Used by scripts/generate-mock-allowlist.sh and scripts/check-invariants.sh.
# POSIX-bash compatible.

normalize_mock_target() {
  local target="$1"
  local normalized
  normalized="$(echo "$target" | sed 's|^\(\.\.\/\)*||; s|^\(\.\/\)*||')"
  while [[ "$normalized" == *"/../"* ]]; do
    normalized="$(echo "$normalized" | sed 's|[^/]\+/\.\./||')"
  done
  normalized="$(echo "$normalized" | sed 's|^src/||; s|\.js$||')"
  if [[ "$normalized" != node:* ]]; then
    normalized="src/$normalized"
  fi
  echo "$normalized"
}
