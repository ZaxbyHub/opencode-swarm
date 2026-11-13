#!/usr/bin/env bash
#
# generate-recurrence-table.sh — fail-closed Phase 4.2 disposition-table
# generator (issue-tracer; #3605 AC2).
#
# The PR #3593 session assembled its recurrence-disposition table with three
# hand-run scripts whose joins silently fell back and whose regeneration keyed
# overrides to pre-shift line numbers — two full critic rounds were consumed
# by table repair. This generator makes those failure modes refusals:
#
#   unmatched  a predicate hit with no disposition row
#   digest     the two input artifacts carry different tree-state digests
#   count-drift an orphan disposition (no matching hit), or a rendered table
#              whose data-row count or FIXED total disagrees with its summary
#
# Input contract (each file's first line MUST be `tree-digest: <sha>`):
#   hits.tsv          rows: <predicate> \t <count> \t <paths>
#   dispositions.tsv  rows: <predicate> \t <disposition> \t <note>
#
# Usage: generate-recurrence-table.sh <hits.tsv> <dispositions.tsv> <outdir>
# Success: renders <outdir>/recurrence-table.md (markdown table + summary
# line) and prints `RECURRENCE-TABLE: ok rows=<N>`.
set -euo pipefail
export LC_ALL=C

if [ "$#" -ne 3 ]; then
  echo "usage: generate-recurrence-table.sh <hits.tsv> <dispositions.tsv> <outdir>" >&2
  exit 1
fi

hits="$1"
disp="$2"
outdir="$3"

for f in "$hits" "$disp"; do
  if [ ! -f "$f" ]; then
    echo "GENERATION-REFUSED: input not found: $f" >&2
    exit 1
  fi
done

hits_digest="$(sed -n '1{s/^tree-digest: //p}' "$hits")"
disp_digest="$(sed -n '1{s/^tree-digest: //p}' "$disp")"
if [ -z "$hits_digest" ] || [ -z "$disp_digest" ]; then
  echo "GENERATION-REFUSED: digest (input missing its tree-digest header)" >&2
  exit 1
fi
if [ "$hits_digest" != "$disp_digest" ]; then
  echo "GENERATION-REFUSED: digest (hits $hits_digest != dispositions $disp_digest)" >&2
  exit 1
fi

# Fail on any duplicate predicate within one input (ambiguous joins are the
# exact hand-run failure mode this generator exists to close).
dup_hits="$(tail -n +2 "$hits" | cut -f1 | sort | uniq -d)"
dup_disp="$(tail -n +2 "$disp" | cut -f1 | sort | uniq -d)"
if [ -n "$dup_hits" ] || [ -n "$dup_disp" ]; then
  echo "GENERATION-REFUSED: unmatched (duplicate predicate rows: ${dup_hits}${dup_disp})" >&2
  exit 1
fi

# Unmatched: every hit predicate must have a disposition row. Joins are
# EXACT column-1 comparisons (awk $1 == p): a substring/suffix grep would let
# a predicate like "foo" join against "bar-foo" and render a misjoined row.
missing_disp="$(awk -F '\t' '
  NR == FNR { if (FNR > 1) disps[$1] = 1; next }
  FNR > 1 { if (!(($1) in disps)) printf "%s ", $1 }
' "$disp" "$hits")"
if [ -n "$missing_disp" ]; then
  echo "GENERATION-REFUSED: unmatched (hit predicates without dispositions:${missing_disp})" >&2
  exit 1
fi

# Orphan dispositions (no matching hit) are count drift by construction.
orphan_disp="$(awk -F '\t' '
  NR == FNR { if (FNR > 1) hits[$1] = 1; next }
  FNR > 1 { if (!(($1) in hits)) printf "%s ", $1 }
' "$hits" "$disp")"
if [ -n "$orphan_disp" ]; then
  echo "GENERATION-REFUSED: count-drift (dispositions without hits:${orphan_disp})" >&2
  exit 1
fi

rows="$(tail -n +2 "$hits" | grep -c . || true)"
fixed="$(tail -n +2 "$disp" | awk -F '\t' '$2 == "FIXED" {n++} END {print n+0}')"

if [ "$rows" -eq 0 ]; then
  echo "GENERATION-REFUSED: count-drift (zero hit rows)" >&2
  exit 1
fi

mkdir -p "$outdir"
table="$outdir/recurrence-table.md"
{
  echo '# Phase 4.2 recurrence dispositions (generated)'
  echo
  echo "tree-digest: $hits_digest"
  echo
  echo '| Predicate | Hits | Disposition | Note |'
  echo '|---|---|---|---|'
  tail -n +2 "$hits" | while IFS="$(printf '\t')" read -r pred count paths; do
    [ -z "$pred" ] && continue
    d_row="$(tail -n +2 "$disp" | grep -F "$(printf '%s\t' "$pred")" | head -1)"
    d_disp="$(printf '%s\n' "$d_row" | cut -f2)"
    d_note="$(printf '%s\n' "$d_row" | cut -f3)"
    printf '| %s | %s | %s | %s |\n' "$pred" "$count" "$d_disp" "$d_note"
  done
  echo
  echo "rows: $rows fixed: $fixed"
} >"$table"

# Rendered-consistency self-check: data-row count and FIXED total must equal
# the summary line this generator itself wrote.
rendered_rows="$(grep -c '^| ' "$table" || true)"
rendered_rows=$((rendered_rows - 1)) # header row
rendered_fixed="$(grep -c '^| .* | .* | FIXED | ' "$table" || true)"
if [ "$rendered_rows" -ne "$rows" ] || [ "$rendered_fixed" -ne "$fixed" ]; then
  echo "GENERATION-REFUSED: count-drift (rendered rows/fixed $rendered_rows/$rendered_fixed vs inputs $rows/$fixed)" >&2
  exit 1
fi

echo "RECURRENCE-TABLE: ok rows=$rows"
