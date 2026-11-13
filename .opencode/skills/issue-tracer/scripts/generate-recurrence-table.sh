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
#   disposition a disposition cell is empty or outside the canonical vocabulary
#              (evidence-artifacts.md ## Dispositions: FIX / FALSE_POSITIVE /
#              OUT_OF_CLASS / DEFERRED_WITH_USER_APPROVAL)
#   count-drift an orphan disposition (no matching hit), or a rendered table
#              whose data-row count or FIX total disagrees with its summary
#
# Input contract (each file's first line MUST be `tree-digest: <sha>`, and the
# file MUST end with a trailing newline — awk reads a final unterminated line,
# but the digest/count tooling is newline-normalized, so absent one the last
# row is still counted; refusals below are all newline-safe):
#   hits.tsv          rows: <predicate> \t <count> \t <paths>
#   dispositions.tsv  rows: <predicate> \t <disposition> \t <note>
#
# The rendered table carries ONE ROW PER HIT (a predicate with count N renders
# N identical rows) so the table can be embedded in 08a directly: the
# trace-check phase-4.2 gate requires the disposition-table data-row count to
# equal the SUM of the per-predicate `hits:` bullets.
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

# awk, not sed: BSD sed (macOS) rejects `1{s/.../p}` block syntax ("bad flag in
# substitute command: '}'"); this awk form is POSIX-portable.
hits_digest="$(awk 'NR==1 && /^tree-digest: /{sub(/^tree-digest: /,""); print; exit}' "$hits")"
disp_digest="$(awk 'NR==1 && /^tree-digest: /{sub(/^tree-digest: /,""); print; exit}' "$disp")"
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
  FNR > 1 && NF > 0 { if (!(($1) in disps)) printf "%s ", $1 }
' "$disp" "$hits")"
if [ -n "$missing_disp" ]; then
  echo "GENERATION-REFUSED: unmatched (hit predicates without dispositions:${missing_disp})" >&2
  exit 1
fi

# Orphan dispositions (no matching hit) are count drift by construction.
orphan_disp="$(awk -F '\t' '
  NR == FNR { if (FNR > 1) hits[$1] = 1; next }
  FNR > 1 && NF > 0 { if (!(($1) in hits)) printf "%s ", $1 }
' "$hits" "$disp")"
if [ -n "$orphan_disp" ]; then
  echo "GENERATION-REFUSED: count-drift (dispositions without hits:${orphan_disp})" >&2
  exit 1
fi

# Disposition cells: non-empty, tab-delimited, and inside the canonical
# vocabulary (evidence-artifacts.md ## Dispositions). An empty cell or a typo
# (FIXD) must refuse, not render a blank classification.
bad_disp="$(awk -F '\t' '
  FNR > 1 && NF > 0 && ($2 == "" || $2 !~ /^(FIX|FALSE_POSITIVE|OUT_OF_CLASS|DEFERRED_WITH_USER_APPROVAL)$/) {
    printf "%s ", $1
  }
' "$disp")"
if [ -n "$bad_disp" ]; then
  echo "GENERATION-REFUSED: disposition (empty or non-canonical disposition for:${bad_disp}; canonical vocabulary: FIX / FALSE_POSITIVE / OUT_OF_CLASS / DEFERRED_WITH_USER_APPROVAL)" >&2
  exit 1
fi

# Hit counts must be positive integers: a zero or non-numeric count would
# silently render ZERO rows for that predicate while the summary still
# counts the predicate's hits — a vacuous row the phase-4.2 gate could not
# reconcile (Stage-B finding).
bad_count="$(awk -F '\t' '
  FNR > 1 && NF > 0 && ($2 == "" || $2 !~ /^[1-9][0-9]*$/) { printf "%s ", $1 }
' "$hits")"
if [ -n "$bad_count" ]; then
  echo "GENERATION-REFUSED: count (non-positive or non-numeric hit count for:${bad_count})" >&2
  exit 1
fi

# rows = SUM of per-predicate hit counts (one rendered row per hit, so the
# embedded table satisfies the phase-4.2 rows == hits-sum rule). fixed = sum
# of the hit counts whose predicate's disposition is FIX — the rendered table
# repeats a FIX predicate's row once per hit, so rendered FIX rows equal this.
rows="$(tail -n +2 "$hits" | awk -F '\t' 'NF > 0 { s += $2 } END { print s + 0 }')"
fixed="$(awk -F '\t' '
  NR == FNR && FNR > 1 { d[$1] = $2; next }
  NR != FNR && FNR > 1 && NF > 0 && d[$1] == "FIX" { s += $2 + 0 }
  END { print s + 0 }
' "$disp" "$hits")"

if [ "$rows" -eq 0 ]; then
  echo "GENERATION-REFUSED: count-drift (zero hit rows)" >&2
  exit 1
fi

mkdir -p "$outdir"
table="$outdir/recurrence-table.md"
# Atomic write: render to a temp file, run the self-check, then rename over
# the target so a refused run never leaves a self-contradicting table behind
# and concurrent generations to one outdir never expose a partial table.
tmp_table="$outdir/.recurrence-table.tmp-$$"
cleanup() { rm -f -- "$tmp_table"; }
trap cleanup EXIT HUP INT TERM

{
  echo '# Phase 4.2 recurrence dispositions (generated)'
  echo
  echo "tree-digest: $hits_digest"
  echo
  echo '| Predicate | Hits | Disposition | Note |'
  echo '|---|---|---|---|'
  # Single two-file awk join (NR==FNR): no -v assignment, so awk escape
  # processing cannot mangle predicate keys (a backslash-bearing grep pattern
  # joins exactly); no shell read loop, so a final row without a trailing
  # newline is still rendered; one row per hit.
  awk -F '\t' '
    NR == FNR && FNR > 1 { d[$1] = $2; n[$1] = $3; next }
    NR != FNR && FNR > 1 && NF > 0 {
      c = $2 + 0
      for (i = 0; i < c; i++) print "| " $1 " | " $2 " | " d[$1] " | " n[$1] " |"
    }
  ' "$disp" "$hits"
  echo
  echo "rows: $rows fixed: $fixed"
} >"$tmp_table"

# Rendered-consistency self-check: data-row count and FIX total must equal
# the summary line this generator itself wrote. The separator row starts
# '|---' and does not match '^| '.
rendered_rows="$(grep -c '^| ' "$tmp_table" || true)"
rendered_rows=$((rendered_rows - 1)) # header row
rendered_fixed="$(grep -c '^| .* | .* | FIX | ' "$tmp_table" || true)"
if [ "$rendered_rows" -ne "$rows" ] || [ "$rendered_fixed" -ne "$fixed" ]; then
  echo "GENERATION-REFUSED: count-drift (rendered rows/fixed $rendered_rows/$rendered_fixed vs inputs $rows/$fixed)" >&2
  exit 1
fi

mv -f -- "$tmp_table" "$table"
trap - EXIT HUP INT TERM

echo "RECURRENCE-TABLE: ok rows=$rows"
