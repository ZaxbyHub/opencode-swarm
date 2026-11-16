#!/usr/bin/env bash
#
# check-publication-body-order.sh
#
# Local mirror of the remote pr-standards PR-body section-ORDER contract
# (.github/workflows/pr-standards.yml "Validate PR body contract"): the three
# required H2 sections must appear in the order Summary -> Invariant audit ->
# Test plan. The publication gate (copilot-pr-publication-gate.sh) checks
# PRESENCE of each section; this script adds the positional check so a
# wrongly-ordered body is refused locally before it can cost a CI round.
#
# Usage: check-publication-body-order.sh <body-file>
# Exit 0  body carries the three sections in the required order
# Exit 1  a section is missing, or the order is wrong (diagnostics below)
#
# Deliberately mirrors the remote gate's anchored heading grammar: the section
# must be a heading line on its own, matched with a line-anchored grep so a
# prose mention ("see ## Summary above" mid-sentence) never counts.
set -euo pipefail
export LC_ALL=C

if [ "$#" -ne 1 ]; then
  echo "usage: check-publication-body-order.sh <body-file>" >&2
  exit 1
fi

body="$1"
if [ ! -f "$body" ]; then
  echo "Blocked: body file not found: $body" >&2
  exit 1
fi

# The section greps each run under `|| true` INSIDE the pipeline: with
# pipefail, a section that is absent makes its grep exit 1, which must reach
# the missing-section handling below — not abort the script silently.
summary_ln="$({ grep -n '^## Summary[[:space:]]*$' "$body" || true; } | head -1 | cut -d: -f1)"
audit_ln="$({ grep -n '^## Invariant audit[[:space:]]*$' "$body" || true; } | head -1 | cut -d: -f1)"
plan_ln="$({ grep -n '^## Test plan[[:space:]]*$' "$body" || true; } | head -1 | cut -d: -f1)"

missing=0
if [ -z "$summary_ln" ]; then
  echo "Blocked: missing required section: ## Summary" >&2
  missing=1
fi
if [ -z "$audit_ln" ]; then
  echo "Blocked: missing required section: ## Invariant audit" >&2
  missing=1
fi
if [ -z "$plan_ln" ]; then
  echo "Blocked: missing required section: ## Test plan" >&2
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  exit 1
fi

if [ "$summary_ln" -lt "$audit_ln" ] && [ "$audit_ln" -lt "$plan_ln" ]; then
  exit 0
fi

# Found-order sequence, rendered first on the diagnostic line so the found
# order is textually ahead of the required order (the frozen acceptance
# driver pins exactly that shape). Three-element insertion sort by line
# number; POSIX-only, no gawk extensions.
seq=""
emit() { if [ -z "$seq" ]; then seq="$1"; else seq="$seq -> $1"; fi; }
l1="$summary_ln"; n1="Summary"
l2="$audit_ln";   n2="Invariant audit"
l3="$plan_ln";    n3="Test plan"
if [ "$l2" -lt "$l1" ]; then t="$l1"; l1="$l2"; l2="$t"; t="$n1"; n1="$n2"; n2="$t"; fi
if [ "$l3" -lt "$l2" ]; then t="$l2"; l2="$l3"; l3="$t"; t="$n2"; n2="$n3"; n3="$t"; fi
if [ "$l2" -lt "$l1" ]; then t="$l1"; l1="$l2"; l2="$t"; t="$n1"; n1="$n2"; n2="$t"; fi
emit "$n1"; emit "$n2"; emit "$n3"

echo "Blocked: PR body section order: found ${seq} before the required order (required: Summary -> Invariant audit -> Test plan)" >&2
exit 1
