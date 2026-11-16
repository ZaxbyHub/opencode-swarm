#!/usr/bin/env bash
#
# cost-yield-ledger.sh — per-lane cost/yield ledger for broad reviews
# (swarm-pr-review; #3605 AC4, ABSORB-refined 2026-11-08).
#
# Renders a ledger that PAIRS cost with actionable-finding yield on the same
# row for every lane, so neither column can be read alone (the two highest-
# cost lanes of the measured example were exactly the two that produced the
# deepest findings — a cost column without its yield column misreads the most
# valuable lanes as the most expensive).
#
# Token semantics (ABSORB refinement):
# - per-request context = (input + cache_read + cache_creation) / requests —
#   a DERIVED figure; the raw token columns are cumulative across the lane's
#   whole run.
# - `reasoning_tokens` is unpopulated on ~88% of harness subagent rows and
#   must never be used as a denominator; output_tokens is overwhelmingly
#   reasoning and is EXCLUDED from context.
# - aggregate: per-finding cost = (Σ lane (input + cache_read +
#   cache_creation)) / (Σ actionable_findings) — pooled totals; a lane with
#   zero requests and empty token fields contributes 0 to the numerator.
# - zero total findings renders `per-finding cost: n/a (zero actionable
#   findings)`; a zero-request lane renders `cost: n/a (zero requests)`.
#
# Input: TSV with a 9-column header
#   id, elapsed_min, tool_uses, requests, input_tokens,
#   cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
#   actionable_findings
# (any data row that is not exactly 9 well-formed fields — wrong arity, blank
# line, empty id, or a non-numeric elapsed/tool-uses/requests/findings cell —
# is refused by line number).
#
# Usage: cost-yield-ledger.sh <lanes.tsv>
# Success: `COST-YIELD-LEDGER: ok lanes=N` + the rendered ledger on stdout.
# Refusal: `LEDGER-REFUSED: unpaired` (exit 1).
set -euo pipefail
export LC_ALL=C

if [ "$#" -ne 1 ]; then
  echo "usage: cost-yield-ledger.sh <lanes.tsv>" >&2
  exit 1
fi

input="$1"
if [ ! -f "$input" ]; then
  echo "LEDGER-REFUSED: unpaired (input not found: $input)" >&2
  exit 1
fi

expected_header="$(printf 'id\telapsed_min\ttool_uses\trequests\tinput_tokens\tcache_read_input_tokens\tcache_creation_input_tokens\toutput_tokens\tactionable_findings')"
actual_header="$(sed -n '1p' "$input" | tr -d '\r')"
if [ "$actual_header" != "$expected_header" ]; then
  echo "LEDGER-REFUSED: unpaired (unexpected header; expected the 9-column contract)" >&2
  exit 1
fi

# Refuse any bad data row, keyed on the row's EXISTENCE (line number), never
# on the value of $1 (an empty id would otherwise bypass the guard). Bad =
# wrong arity (fewer OR more than 9 fields), a blank line, an empty id, or a
# non-numeric requests/tool-uses/yield cell (a missing or "N/A" yield must
# refuse, not coerce to zero actionable findings).
bad_row="$(tail -n +2 "$input" | awk -F '\t' '
  NF != 9 || $1 == "" || $2 == "" || $3 == "" || $4 == "" || $9 == "" \
    || $2 !~ /^[0-9]+([.][0-9]+)?$/ || $3 !~ /^[0-9]+$/ || $4 !~ /^[0-9]+$/ || $9 !~ /^[0-9]+$/ \
    || ($5 != "" && $5 !~ /^[0-9]+$/) || ($6 != "" && $6 !~ /^[0-9]+$/) || ($7 != "" && $7 !~ /^[0-9]+$/) \
    || ($8 != "" && $8 !~ /^[0-9]+$/) { print NR }' | head -1 || true)"
if [ -n "$bad_row" ]; then
  echo "LEDGER-REFUSED: unpaired (data row $bad_row violates the 9-column contract: 9 tab-separated fields, non-empty id/elapsed/tool-uses/requests/findings, numeric cells)" >&2
  exit 1
fi

lanes="$(tail -n +2 "$input" | grep -c . || true)"
if [ "$lanes" -eq 0 ]; then
  echo "LEDGER-REFUSED: unpaired (header-only input carries no lane rows)" >&2
  exit 1
fi

echo "lane-cost-yield-ledger (cost and yield are paired per row by design; derived per-request context = (input+cache_read+cache_creation)/requests)"
tail -n +2 "$input" | awk -F '\t' '
{
  id = $1; elapsed = $2; tools = $3; requests = $4 + 0
  tin = ($5 == "" ? 0 : $5 + 0); tcr = ($6 == "" ? 0 : $6 + 0)
  tcc = ($7 == "" ? 0 : $7 + 0); findings = $9 + 0
  total_ctx = tin + tcr + tcc
  pooled_ctx += total_ctx
  pooled_requests += requests
  pooled_findings += findings
  if (requests > 0) {
    ctx_req = total_ctx / requests
    printf "%s  cost: %.1f ctx/req (%d requests, %d tool uses, %.0f min)  |  yield: %d actionable\n", id, ctx_req, requests, tools, elapsed, findings
  } else {
    printf "%s  cost: n/a (zero requests) (%d tool uses, %.0f min)  |  yield: %d actionable\n", id, tools, elapsed, findings
  }
}
END {
  if (pooled_findings > 0 && pooled_requests > 0) {
    printf "per-finding cost: %.1f\n", pooled_ctx / pooled_findings
  } else if (pooled_findings > 0) {
    print "per-finding cost: n/a (zero requests recorded, so no cost denominator exists)"
  } else {
    print "per-finding cost: n/a (zero actionable findings)"
  }
}'

echo "COST-YIELD-LEDGER: ok lanes=$lanes"
