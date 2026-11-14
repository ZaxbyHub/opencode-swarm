#!/usr/bin/env bash
set -eu

for file in tests/unit/scripts/repro-check*.test.ts \
  tests/unit/scripts/trace-check*.test.ts \
  tests/unit/skills/issue-tracer*.test.ts \
  tests/unit/skills/swarm-pr-review*.test.ts; do
  bun --smol test "$file" --timeout 30000
done
