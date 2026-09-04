#!/usr/bin/env bash
# trace-check.sh - read-only validation for issue-tracer v3 evidence.
set -eu
export LC_ALL=C

to_shell_path() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW* | MSYS* | CYGWIN*)
      if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; return; fi
      ;;
  esac
  printf '%s\n' "$1"
}

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "trace-check: not inside a git work tree" >&2; exit 2; }
root="$(to_shell_path "$root")"
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
failed=0
legacy=0

usage() { echo "usage: trace-check.sh {tree-id|handshake|phase <phase> --slug <slug> [--trace-dir <dir>]|merge --slug <slug>}" >&2; exit 2; }
valid_slug() { case "$1" in ''|*[!a-z0-9-]*) return 1;; *) return 0;; esac; }
trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

tree_id() {
  local index
  index="$(mktemp)"
  rm -f "$index"
  if ! GIT_INDEX_FILE="$index" git read-tree HEAD || ! GIT_INDEX_FILE="$index" git add -A . || ! GIT_INDEX_FILE="$index" git write-tree; then
    rm -f "$index"
    return 1
  fi
  rm -f "$index"
}

handshake() {
  local version candidate value shim verdict worst="MATCH"
  version="$(awk '/^metadata:/{in_metadata=1; next} in_metadata && /^  version:/{sub(/^  version:[[:space:]]*/, ""); print; exit}' "$root/.opencode/skills/issue-tracer/SKILL.md" 2>/dev/null || true)"
  [ -n "$version" ] || version="unknown"
  for candidate in "${HOME:-}/.claude/skills/issue-tracer/SKILL.md" "${HOME:-}/.codex/skills/issue-tracer/SKILL.md" "${HOME:-}/.agents/skills/issue-tracer/SKILL.md" "${HOME:-}/.zcode/skills/issue-tracer/SKILL.md"; do
    if [ ! -f "$candidate" ]; then
      verdict="ABSENT"
    else
      value="$(grep -m1 '^  version:' "$candidate" 2>/dev/null | sed 's/^  version:[[:space:]]*//' || true)"
      shim="$(grep -m1 '^shim:' "$candidate" 2>/dev/null | sed 's/^shim:[[:space:]]*//' || true)"
      if [ "$value" = "$version" ] && [ "$shim" = "true" ]; then verdict="SHIM"
      elif [ "$value" = "$version" ]; then verdict="MATCH"
      else verdict="STALE:$candidate"; fi
    fi
    echo "handshake: $verdict $candidate"
    case "$verdict" in
      STALE:*) worst="$verdict" ;;
      ABSENT) case "$worst" in STALE:*) ;; *) worst="ABSENT";; esac ;;
      SHIM) if [ "$worst" = "MATCH" ]; then worst="SHIM"; fi ;;
    esac
  done
  echo "handshake-summary: $worst"
}

rule_ok() { echo "OK $1"; }
rule_bad() {
  if [ "$legacy" -eq 1 ]; then echo "WARN $1: $2"; else echo "FAIL $1: $2"; failed=1; fi
}
state_value() { awk -F ': ' -v key="$1" '$1 == key { print substr($0, length(key) + 3); exit }' "$state" 2>/dev/null || true; }
is_hex() { case "$1" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) return 0;; *) return 1;; esac; }

check_headings() {
  local file="$1"; shift
  if [ ! -f "$file" ]; then rule_bad "artifact-$(basename "$file")" "missing"; return; fi
  local heading count
  for heading in "$@"; do
    count="$(grep -Fx "$heading" "$file" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$count" -eq 1 ]; then rule_ok "heading-${heading#\#\# }"
    elif [ "$count" -gt 1 ]; then rule_bad "duplicate-heading-${heading#\#\# }" "in $(basename "$file")"
    else rule_bad "heading-${heading#\#\# }" "missing in $(basename "$file")"; fi
  done
  # Any duplicated level-two heading is invalid even when it is not required.
  while IFS= read -r heading; do rule_bad "duplicate-heading-${heading#\#\# }" "in $(basename "$file")"; done < <(grep '^## ' "$file" 2>/dev/null | sort | uniq -d)
}

state_gate() {
  local gate="$1" commit="$2" row
  row="$(awk -F '|' -v gate="$gate" -v commit="$commit" '$2 ~ "^[[:space:]]*" gate "[[:space:]]*$" && $3 ~ /APPROVE|RECORDED/ && (commit == "" || $4 ~ "^[[:space:]]*" commit "[[:space:]]*$") {print; exit}' "$state" 2>/dev/null || true)"
  [ -n "$row" ] && rule_ok "gate-$gate" || rule_bad "gate-$gate" "missing approved bound row"
}

clean_tree() {
  local dirty
  dirty="$(git status --porcelain | awk '$0 !~ /^.. \.agents\/issue-traces\//')"
  [ -z "$dirty" ] && rule_ok clean-tree || rule_bad clean-tree "working tree has non-trace changes"
}

phase0() {
  local keys key expected actual previous=0 line
  keys='protocol phase tier classification base-ref base-sha freshness phase0-tree-id checkpoint-tree-id handshake tools merge next-action'
  if [ ! -f "$state" ]; then rule_bad state "missing"; return; fi
  for key in $keys; do
    line="$(grep -n "^$key: " "$state" 2>/dev/null | cut -d: -f1 | head -n1 || true)"
    if [ -z "$line" ]; then rule_bad "state-$key" "missing"; continue; fi
    if [ "$(grep -c "^$key: " "$state" 2>/dev/null || true)" -ne 1 ]; then rule_bad "state-$key" "must appear once"; fi
    if [ "$line" -le "$previous" ]; then rule_bad "state-order" "$key is out of order"; fi
    previous="$line"
  done
  [ "$(state_value protocol)" = "3.0.0" ] && rule_ok protocol || rule_bad protocol "expected 3.0.0"
  is_hex "$(state_value base-sha)" && rule_ok base-sha || rule_bad base-sha "must be 40 hex"
  is_hex "$(state_value phase0-tree-id)" && rule_ok phase0-tree-id || rule_bad phase0-tree-id "must be 40 hex"
  case "$(state_value freshness)" in
    unset|'') rule_bad freshness "must be recorded" ;;
    fetch-failed:*) case "$(state_value freshness)" in *user-override:*) rule_ok freshness;; *) rule_bad freshness-fail-closed "fetch failure lacks user override";; esac ;;
    *) rule_ok freshness ;;
  esac
  case "$(state_value tier)" in S|M|L) rule_ok tier;; *) rule_bad tier "must be S, M, or L";; esac
  [ "$(state_value handshake)" != "unset" ] && [ -n "$(state_value handshake)" ] && rule_ok handshake || rule_bad handshake "must be recorded"
}

acceptance_ids() { grep -E '^- \[[ x]\] AC[0-9]+:' "$trace/01-issue-summary.md" 2>/dev/null | sed -E 's/^- \[[ x]\] (AC[0-9]+):.*/\1/'; }
is_already_fixed() { [ "$(state_value classification)" = "ALREADY_FIXED" ]; }

phase1() {
  local file="$trace/01-issue-summary.md" value
  check_headings "$file" '## Source' '## Observed Behavior' '## Expected Behavior' '## Acceptance Criteria' '## Classification' '## Related Issues'
  acceptance_ids | grep -q . && rule_ok acceptance-criteria || rule_bad acceptance-criteria "missing AC checkbox"
  value="$(state_value classification)"
  case "$value" in VALID|AMBIGUOUS|ALREADY_FIXED|NOT_A_BUG|FEATURE) ;; *) rule_bad classification "invalid state value"; return;; esac
  if grep -A100 '^## Classification$' "$file" 2>/dev/null | grep -Eq 'VALID|AMBIGUOUS|ALREADY_FIXED|NOT_A_BUG|FEATURE' && grep -A100 '^## Classification$' "$file" | grep -q "$value"; then rule_ok classification
  else rule_bad classification "artifact does not match state"; fi
}

phase2() {
  local file="$trace/02-reproduction.md"
  check_headings "$file" '## Commands Tried' '## Reproduction Verdict'
  grep -q '^```text$' "$file" 2>/dev/null && rule_ok reproduction-text-block || rule_bad reproduction-text-block "missing"
  grep -Eq '^- Exit code: [0-9]+' "$file" 2>/dev/null && rule_ok reproduction-exit-code || rule_bad reproduction-exit-code "missing"
  if is_already_fixed; then check_headings "$file" '## Fixing Change'; fi
}

phase25() {
  local file="$trace/02-reproduction.md" header ac row found class check pre notes reason checkpoint manifest_path diff_path
  if is_already_fixed; then rule_ok obe-subset; return; fi
  header='| AC | class | check | argv | expect | pre-fix | post-fix | notes |'
  grep -Fx "$header" "$file" >/dev/null 2>&1 && rule_ok acceptance-table || { rule_bad acceptance-table "missing exact header"; return; }
  while IFS= read -r ac; do
    found="$(grep -E "^\\|[[:space:]]*$ac[[:space:]]*\\|" "$file" 2>/dev/null | wc -l | tr -d ' ')"
    [ "$found" -eq 1 ] && rule_ok "acceptance-$ac" || rule_bad "acceptance-$ac" "must appear exactly once"
  done < <(acceptance_ids)
  check="$(grep -E '^\|[[:space:]]*AC[0-9]+[[:space:]]*\|' "$file" 2>/dev/null | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $4); print $4}' | sort | uniq -d | head -n1 || true)"
  [ -z "$check" ] && rule_ok acceptance-check-ids || rule_bad acceptance-check-ids "duplicate check id $check"
  while IFS= read -r row; do
    IFS='|' read -r _ ac class check argv expect pre post notes _ <<EOF
$row
EOF
    ac="$(trim "$ac")"; class="$(trim "$class")"; check="$(trim "$check")"; pre="$(trim "$pre")"; notes="$(trim "$notes")"
    case "$class" in
      DISCRIMINATING) [ "$pre" = RED ] || rule_bad "pre-fix-$ac" "DISCRIMINATING must be RED"; [ -f "$trace/repro/$check.base.log" ] || rule_bad "base-log-$check" "missing" ;;
      PRESERVING) [ "$pre" = GREEN ] || rule_bad "pre-fix-$ac" "PRESERVING must be GREEN"; [ -f "$trace/repro/$check.base.log" ] || rule_bad "base-log-$check" "missing" ;;
      NEW-SURFACE) [ "$pre" = ERROR ] || rule_bad "pre-fix-$ac" "NEW-SURFACE must be ERROR"; [ -f "$trace/repro/$check.base.log" ] || rule_bad "base-log-$check" "missing" ;;
      NON-EXECUTABLE) case "$check" in DOCS_ONLY|HOST_ONLY|PRODUCT_DECISION|EXTERNAL_SERVICE_UNAVAILABLE) ;; *) rule_bad "non-executable-$ac" "unknown reason";; esac; [ -n "$notes" ] && [ "$notes" != '-' ] || rule_bad "notes-$ac" "required" ;;
      *) rule_bad "class-$ac" "invalid" ;;
    esac
  done < <(grep -E '^\|[[:space:]]*AC[0-9]+[[:space:]]*\|' "$file" 2>/dev/null || true)
  check_headings "$file" '## Red checkpoint'
  checkpoint="$(grep '^checkpoint-tree-id: ' "$file" 2>/dev/null | head -n1 | sed 's/^checkpoint-tree-id: //')"
  is_hex "$checkpoint" && [ "$checkpoint" = "$(state_value checkpoint-tree-id)" ] && rule_ok red-checkpoint || rule_bad red-checkpoint "state binding missing or invalid"
  manifest_path="$trace/repro/checkpoint.manifest"
  [ -f "$manifest_path" ] && grep -Fx '# issue-tracer checkpoint manifest v1' "$manifest_path" >/dev/null 2>&1 && rule_ok checkpoint-manifest || { rule_bad checkpoint-manifest "missing or invalid"; return; }
  diff_path="$(git diff-tree -r --name-only "$(state_value phase0-tree-id)" "$checkpoint" 2>/dev/null || true)"
  while IFS= read -r check; do
    [ -z "$check" ] && continue
    awk -F '\t' -v p="$check" 'NR > 1 && $3 == p {found=1} END {exit !found}' "$manifest_path" && rule_ok "manifest-path-$check" || rule_bad "manifest-path-$check" "not recorded"
  done <<EOF
$diff_path
EOF
}

phase3() {
  check_headings "$trace/05-fix-plan.md" '## Selected Fix' '## Candidate Fixes' '## Impact Analysis' '## Anticipated Defect-Class Sweep (Phase 4.2)'
  check_headings "$trace/06-critic-review.md" '## Reviewed SHA / diff hash' '## Verdict' '## Check replay' '## Round 1'
  grep -A10 '^## Verdict$' "$trace/06-critic-review.md" 2>/dev/null | grep -q APPROVE && rule_ok critic-verdict || rule_bad critic-verdict "must approve"
  [ -f "$trace/07-approved-plan.md" ] && rule_ok approved-plan || rule_bad approved-plan "missing"
  state_gate plan-critic ""
}

executable_ids() { grep -E '^\|[[:space:]]*AC[0-9]+[[:space:]]*\|' "$trace/02-reproduction.md" 2>/dev/null | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); gsub(/^[ \t]+|[ \t]+$/, "", $4); if ($3 != "NON-EXECUTABLE") print $4}'; }
phase4() {
  local file="$trace/08-test-results.md" id
  check_headings "$file" '## Regression Test' '## Acceptance check results' '## Quality Checks' '## Deferred-Work Scan' '## Verification Reasoning' '## Checkpoint verification'
  while IFS= read -r id; do [ -z "$id" ] || { grep -Fx "### Check $id" "$file" >/dev/null 2>&1 && rule_ok "check-block-$id" || rule_bad "check-block-$id" "missing"; }; done < <(executable_ids)
  if "$script_dir/repro-check.sh" verify-checkpoint --slug "$slug" --trace-dir "$trace" >/dev/null 2>&1; then rule_ok checkpoint-verification; else rule_bad checkpoint-verification "verify-checkpoint failed"; fi
  grep -A100 '^## Deferred-Work Scan$' "$file" 2>/dev/null | grep -q '^scan-deferred: clean' && rule_ok deferred-work-scan || rule_bad deferred-work-scan "clean result missing"
}

phase42() {
  local file="$trace/08a-recurrence-sweep.md" hits rows
  [ -f "$file" ] || { rule_bad recurrence-sweep "missing"; return; }
  if grep -qi 'no defect class' "$file" && grep -A100 '^## Justification$' "$file" 2>/dev/null | grep -q '[^[:space:]]'; then rule_ok recurrence-sweep; return; fi
  check_headings "$file" '## Defect Class' '## Predicates and Results' '## Dispositions' '## Guardrail'
  hits="$(grep -E '^- Predicate.*hits: [0-9]+' "$file" 2>/dev/null | sed -E 's/.*hits: ([0-9]+).*/\1/' | awk '{s += $1} END {print s + 0}')"
  grep -Eq '^- Predicate.*hits: [0-9]+' "$file" 2>/dev/null && rule_ok recurrence-predicates || rule_bad recurrence-predicates "missing hit counts"
  rows="$(awk '/^## Dispositions$/{in_table=1; next} /^## /{in_table=0} in_table && /^\|/ && $0 !~ /^\|[ -]*\|/ {n++} END {print n-1}' "$file")"
  [ "$hits" -eq "$rows" ] && rule_ok recurrence-dispositions || rule_bad recurrence-dispositions "rows ($rows) do not equal hits ($hits)"
  grep -A100 '^## Guardrail$' "$file" 2>/dev/null | tr '\n' ' ' | grep -Eq '### Check .*RED.*GREEN' && rule_ok recurrence-guardrail || rule_bad recurrence-guardrail "missing RED then GREEN check"
}

phase45() {
  clean_tree
  check_headings "$trace/08b-implementation-review.md" '## Reviewed SHA / diff hash' '## Verdict' '## Independently re-run' '## Check integrity' '## Deferred / Scoped-Out / Unwired'
  state_gate implementation-review "$(git rev-parse HEAD)"
}
phase46() {
  local ac
  clean_tree
  check_headings "$trace/09-final-critic.md" '## Reviewed SHA / diff hash' '## Verdict' '## Review Freshness' '## Deferred / Scoped-Out / Unwired' '## Acceptance criteria evidence'
  state_gate final-critic "$(git rev-parse HEAD)"
  while IFS= read -r ac; do grep -A100 '^## Acceptance criteria evidence$' "$trace/09-final-critic.md" 2>/dev/null | grep -q "$ac" && rule_ok "final-$ac" || rule_bad "final-$ac" "missing evidence"; done < <(acceptance_ids)
}
phase5() {
  if is_already_fixed; then rule_ok obe-subset; return; fi
  check_headings "$trace/10-pr-body.md" '## Acceptance Criteria' '## Waivers'
  case "$(state_value merge)" in AWAITING_USER_APPROVAL|APPROVED:[0-9a-f]*|MERGED) rule_ok merge-state;; *) rule_bad merge-state "not ready";; esac
}
merge_check() {
  local file="$trace/10b-merge-approval.md" pr final
  check_headings "$file" '## User approval (verbatim)' '## PR head SHA' '## Final critic reviewed-commit'
  pr="$(grep -A3 '^## PR head SHA$' "$file" 2>/dev/null | grep -Eo '[0-9a-f]{40}' | head -n1 || true)"
  final="$(grep -A3 '^## Final critic reviewed-commit$' "$file" 2>/dev/null | grep -Eo '[0-9a-f]{40}' | head -n1 || true)"
  is_hex "$pr" && [ "$pr" = "$final" ] && rule_ok merge-sha-binding || rule_bad merge-sha-binding "PR and final critic SHA differ"
  state_gate merge-approval ""
  echo 'NOTE: human-enforced gate; this validator checks presence and binding only'
}

command="${1:-}"; shift || true
case "$command" in
  tree-id) [ "$#" -eq 0 ] || usage; tree_id; exit $? ;;
  handshake) [ "$#" -eq 0 ] || usage; handshake; exit 0 ;;
  phase) phase="${1:-}"; shift || true; case "$phase" in 0|1|2|2.5|3|4|4.2|4.5|4.6|5) ;; *) usage;; esac ;;
  merge) phase="merge" ;;
  *) usage ;;
esac
slug=""; trace=""
while [ "$#" -gt 0 ]; do
  case "$1" in --slug) [ "$#" -ge 2 ] || usage; slug="$2"; shift 2;; --trace-dir) [ "$#" -ge 2 ] || usage; trace="$2"; shift 2;; *) usage;; esac
done
valid_slug "$slug" || { echo "trace-check: invalid slug" >&2; exit 2; }
[ -n "$trace" ] || trace="$root/.agents/issue-traces/$slug"
state="$trace/state.md"
[ "$(state_value protocol)" = "3.0.0" ] || legacy=1
[ "$legacy" -eq 0 ] || echo "WARN protocol: legacy trace (protocol missing or not 3.0.0), all failures downgraded to WARN"

if [ "$phase" = merge ]; then merge_check
else
  if is_already_fixed && [ "$phase" != 0 ] && [ "$phase" != 1 ] && [ "$phase" != 2 ]; then
    rule_ok obe-subset
  else
    case "$phase" in
      0) phase0;; 1) phase1;; 2) phase2;; 2.5) phase25;; 3) phase3;; 4) phase4;; 4.2) phase42;; 4.5) phase45;; 4.6) phase46;; 5) phase5;;
    esac
  fi
fi
[ "$failed" -eq 0 ] || exit 1
exit 0
