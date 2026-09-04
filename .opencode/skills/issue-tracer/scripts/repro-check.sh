#!/usr/bin/env bash
# repro-check.sh - disposable-worktree acceptance checks for issue-tracer v3.
set -eu
export LC_ALL=C

to_shell_path() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW* | MSYS* | CYGWIN*) if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; return; fi ;;
  esac
  printf '%s\n' "$1"
}

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "repro-check: not inside a git work tree" >&2; exit 2; }
root="$(to_shell_path "$root")"
root_real="$(cd "$root" && pwd -P)"
script_dir="$(cd "$(dirname "$0")" && pwd -P)"

usage() { echo "usage: repro-check.sh {run|checkpoint|verify-checkpoint} --slug <slug> ..." >&2; exit 2; }
valid_slug() { case "$1" in ''|*[!a-z0-9-]*) return 1;; *) return 0;; esac; }
valid_id() { case "$1" in C[0-9]* ) return 0;; *) return 1;; esac; }
has_bad_field() { case "$1" in *$'\t'*|*$'\n'*|*$'\r'*) return 0;; *) return 1;; esac; }
is_inside_root() {
  case "$1" in /*|[A-Za-z]:*|*\\*) return 1;; esac
  case "/$1/" in */../*|*/./*) return 1;; esac
  return 0
}
issue_traces_base="$root_real/.agents/issue-traces"

# Path-only preflight: trace_dir (default or --trace-dir override) must be
# textually rooted at <repo>/.agents/issue-traces/ before we touch the
# filesystem. Runs before any mkdir/write, so a caller cannot point the
# script at an arbitrary path via that flag.
validate_trace_dir_prefix() {
  case "$trace_dir/" in
    "$root"/.agents/issue-traces/*) ;;
    *)
      echo "repro-check: --trace-dir must be inside .agents/issue-traces" >&2
      exit 2
      ;;
  esac
}

# Symlink-escape guard: resolve the deepest EXISTING ancestor of trace_dir
# (it may not exist yet) and require it to land inside the repo root. Must
# run before any mkdir -p, since mkdir -p happily follows an existing
# symlinked ancestor before any later check on the final path can catch it.
refuse_ancestor_symlink_escape() {
  local check="$trace_dir" resolved
  while [ ! -e "$check" ]; do check="$(dirname "$check")"; done
  if [ -L "$check" ]; then
    echo "repro-check: --trace-dir must be inside .agents/issue-traces" >&2
    exit 2
  fi
  resolved="$(cd "$check" && pwd -P)"
  case "$resolved/" in
    "$root_real"/*) ;;
    *)
      echo "repro-check: --trace-dir must be inside .agents/issue-traces" >&2
      exit 2
      ;;
  esac
}

# Post-mkdir, strict resolution check: once a path under trace_dir exists,
# its pwd -P form must land inside <repo-root>/.agents/issue-traces/. Also
# refuses the path itself being a symlink (created between the ancestor
# check above and this call).
require_contained() {
  local dir="$1" resolved
  [ -e "$dir" ] || return 0
  if [ -L "$dir" ]; then
    echo "repro-check: refusing symlinked path: $dir" >&2
    exit 2
  fi
  resolved="$(cd "$dir" && pwd -P)"
  case "$resolved/" in
    "$issue_traces_base"/*) ;;
    *)
      echo "repro-check: refusing path outside .agents/issue-traces: $dir" >&2
      exit 2
      ;;
  esac
}

trace_for() {
  [ -n "$trace_dir" ] || trace_dir="$root/.agents/issue-traces/$slug"
  validate_trace_dir_prefix
  refuse_ancestor_symlink_escape
}
manifest_for() { trace_for; printf '%s\n' "$trace_dir/repro/checkpoint.manifest"; }

# Structural integrity of the checkpoint manifest, shared by `checkpoint` and
# `verify-checkpoint` so both refuse the same mangled file. Three properties:
# line 1 is the version header AND records the expected data-row count; every
# later line carries exactly 10 TAB-separated fields; the seq column counts
# 1..N with no gaps.
#
# The recorded count is what makes this total rather than a PREFIX invariant.
# Seq contiguity alone is satisfied by any prefix of a valid file, so `head -3`
# (or deleting just the last row) would still validate - silently dropping
# those checks from the replay set AND un-freezing their paths, so a plain
# `checkpoint` could then re-baseline a weakened check to green through the
# very guard below. Comparing the header count against the rows actually
# present closes the tail; seq closes the middle. Together they refuse deletion
# anywhere, reordering, duplication, and field mangling.
#
# The legacy header with no `rows=` count (`... v1`) is REJECTED rather than
# accepted for compatibility: accepting it would itself be a one-line bypass
# (write the old header, then truncate freely). Nothing is lost by failing
# closed - the manifest is an ephemeral, git-excluded, per-issue trace artifact
# seeded fresh by trace-init.sh, so there is no installed base to migrate.
#
# This is tamper-EVIDENCE, not tamper-proofing: the trace directory is the
# agent's own write surface, so a rewriter that renumbers every row AND
# restamps the header count still gets through, and so does deleting the
# manifest outright and re-running `checkpoint` (nothing binds the file's
# existence or completeness to anything outside it). What it stops is a
# partial write or a hand edit that leaves the file internally inconsistent.
validate_manifest() {
  local file="$1" problem counts
  problem="$(awk -F '\t' '
    NR == 1 {
      if ($0 !~ /^# issue-tracer checkpoint manifest v1 rows=[0-9]+$/) { bad = "header"; exit }
      declared = $0
      sub(/^.*rows=/, "", declared)
      declared = declared + 0
      next
    }
    {
      rows += 1
      if (NF != 10) { bad = "fields " NR; exit }
      if ($1 "" != rows "") { bad = "seq " NR; exit }
      # A path is frozen by its first row; every later row for it must be a
      # reasoned AMEND. do_checkpoint refuses a duplicate CHECKPOINT at write
      # time, but do_verify is last-writer-wins per path, so without this a
      # forged CHECKPOINT row appended by hand (plus a bumped header count)
      # would silently re-baseline a frozen blob. Checking it here makes the
      # rule hold in both commands.
      if (seen[$3] && $2 != "AMEND") { bad = "supersede " NR; exit }
      seen[$3] = 1
    }
    END {
      if (bad != "") { print bad; exit }
      if (NR == 0) { print "header"; exit }
      if (declared != rows + 0) { print "count " declared " " rows + 0 }
    }
  ' "$file")"
  case "$problem" in
    '') return 0 ;;
    'fields '*) echo "repro-check: checkpoint manifest line ${problem#fields } does not have 10 tab-separated fields" >&2 ;;
    'seq '*) echo "repro-check: checkpoint manifest seq is not contiguous (row deleted or reordered) at line ${problem#seq }" >&2 ;;
    'supersede '*) echo "repro-check: checkpoint manifest line ${problem#supersede } re-freezes an already-recorded path without an AMEND reason" >&2 ;;
    'count '*)
      counts="${problem#count }"
      echo "repro-check: checkpoint manifest header records ${counts%% *} rows, found ${counts#* } (rows deleted or truncated)" >&2
      ;;
    *) echo "repro-check: invalid manifest header (want '# issue-tracer checkpoint manifest v1 rows=<N>' on line 1)" >&2 ;;
  esac
  exit 2
}

# True when field 3 (the path column) of any data row already names this path.
# A recorded path is frozen: only a reasoned AMEND may supersede it.
manifest_has_path() {
  awk -F '\t' -v want="$2" 'NR > 1 && $3 == want { found = 1; exit } END { exit !found }' "$1"
}

# Append one data row and restamp the header's recorded count in a single
# temp-file swap, so the manifest is never observable in a state where the
# count and the rows disagree - a mid-loop `exit` (an invalid later path, an
# already-frozen repeat) leaves a consistent file rather than bricking it.
# Mirrors bound_log's `$log.truncate.tmp` pattern; refuse_nonregular_target
# guards the temp name as well as the manifest, and `mv` renames over the
# destination rather than writing through a symlink planted there.
append_manifest_row() {
  local file="$1" count="$2" row="$3" temp
  temp="$file.append.tmp"
  refuse_nonregular_target "$file"
  refuse_nonregular_target "$temp"
  {
    printf '# issue-tracer checkpoint manifest v1 rows=%s\n' "$count"
    awk 'NR > 1' "$file"
    printf '%s\n' "$row"
  } > "$temp"
  mv "$temp" "$file"
}

# Refuse to redirect/append into a pre-existing path that is not a regular
# file (a symlink, device, fifo, directory, ...). Must run immediately before
# every `>`/`>>` into a leaf artifact path (base/head logs, checkpoint
# manifest), since a pre-existing symlink there would otherwise be silently
# followed by the shell redirection, writing through it to an arbitrary
# target.
refuse_nonregular_target() {
  local path="$1"
  if { [ -e "$path" ] && [ ! -f "$path" ]; } || [ -L "$path" ]; then
    echo "repro-check: refusing non-regular target: $path" >&2
    exit 2
  fi
}

bound_log() {
  local log="$1" total kept=1048576 omitted temp
  total="$(wc -c < "$log" | tr -d ' ')"
  [ "$total" -le 2097152 ] && return
  temp="$log.truncate.tmp"
  refuse_nonregular_target "$temp"
  { head -c "$kept" "$log"; printf '\n[... truncated %s bytes ...]\n' "$((total - (kept * 2)))"; tail -c "$kept" "$log"; } > "$temp"
  mv "$temp" "$log"
}

run_one() {
  local cwd="$1" log="$2" seconds="$3"; shift 3
  local status=0 pid started timed=0 waited=0
  refuse_nonregular_target "$log"
  : > "$log"
  if [ "${REPRO_CHECK_FORCE_FALLBACK:-0}" != "1" ] && command -v timeout >/dev/null 2>&1; then
    ( cd "$cwd" && timeout --foreground -k 5 "${seconds}s" "$@" ) > "$log" 2>&1 || status=$?
  else
    # POSIX watchdog fallback: run the child in its own process group so the
    # whole group (not just the immediate child) can be killed on timeout.
    if command -v setsid >/dev/null 2>&1; then
      ( cd "$cwd" && exec setsid "$@" ) > "$log" 2>&1 &
    else
      set -m
      ( cd "$cwd" && "$@" ) > "$log" 2>&1 &
      set +m
    fi
    pid=$!
    started=$SECONDS
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$((SECONDS - started))" -ge "$seconds" ]; then
        timed=1
        kill -TERM -- "-$pid" >/dev/null 2>&1 || kill -TERM "$pid" >/dev/null 2>&1 || true
        waited=0
        while [ "$waited" -lt 5 ] && kill -0 "$pid" 2>/dev/null; do sleep 1; waited=$((waited + 1)); done
        kill -KILL -- "-$pid" >/dev/null 2>&1 || kill -KILL "$pid" >/dev/null 2>&1 || true
        break
      fi
      sleep 1
    done
    wait "$pid" 2>/dev/null || status=$?
    [ "$timed" -eq 0 ] || status=124
  fi
  bound_log "$log"
  printf '%s\n' "$status"
}

copy_path() {
  local rel="$1" source target source_dir
  is_inside_root "$rel" || { echo "repro-check: --copy path must be repo-relative without ..: $rel" >&2; exit 2; }
  source="$root/$rel"
  [ -e "$source" ] || { echo "repro-check: --copy path does not exist: $rel" >&2; exit 2; }
  source_dir="$(cd "$(dirname "$source")" && pwd -P)"
  case "$source_dir" in "$root_real"|"$root_real"/*) ;; *) echo "repro-check: --copy path resolves outside repo: $rel" >&2; exit 2;; esac
  target="$worktree/$rel"
  mkdir -p "$(dirname "$target")"
  rm -rf "$target"
  cp -R "$source" "$target"
}

link_deps() {
  [ "$deps" = link ] || return 0
  [ -e "$root/node_modules" ] || return 0
  [ ! -e "$worktree/node_modules" ] || return 0
  case "$(uname -s 2>/dev/null || true)" in
    MINGW* | MSYS* | CYGWIN*) cmd //c mklink //J "$(to_shell_path "$worktree/node_modules")" "$(to_shell_path "$root/node_modules")" >/dev/null 2>&1 || true ;;
    *) ln -s "$root/node_modules" "$worktree/node_modules" ;;
  esac
}

quoted_argv() { local arg; for arg in "$@"; do printf '%q ' "$arg"; done; }

do_run() {
  local base="" class="" check_id="" expect="" timeout_seconds=600 deps=link arg base_status head_status base_result head_result verdict exit_code=0
  local copies=()
  trace_dir=""; slug=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --base) [ "$#" -ge 2 ] || usage; base="$2"; shift 2;;
      --class) [ "$#" -ge 2 ] || usage; class="$2"; shift 2;;
      --id) [ "$#" -ge 2 ] || usage; check_id="$2"; shift 2;;
      --expect) [ "$#" -ge 2 ] || usage; expect="$2"; shift 2;;
      --copy) [ "$#" -ge 2 ] || usage; copies+=("$2"); shift 2;;
      --deps) [ "$#" -ge 2 ] || usage; deps="$2"; shift 2;;
      --timeout) [ "$#" -ge 2 ] || usage; timeout_seconds="$2"; shift 2;;
      --slug) [ "$#" -ge 2 ] || usage; slug="$2"; shift 2;;
      --trace-dir) [ "$#" -ge 2 ] || usage; trace_dir="$2"; shift 2;;
      --) shift; break;;
      *) usage;;
    esac
  done
  [ "$#" -gt 0 ] || usage
  valid_slug "$slug" && valid_id "$check_id" || { echo "repro-check: invalid slug or check id" >&2; exit 2; }
  case "$base" in ''|-*) echo "repro-check: --base must name a commit" >&2; exit 2;; esac
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "repro-check: --base does not resolve to a commit" >&2; exit 2; }
  case "$class" in DISCRIMINATING|PRESERVING|NEW-SURFACE) ;; *) echo "repro-check: unknown class" >&2; exit 2;; esac
  case "$deps" in link|none) ;; *) echo "repro-check: --deps must be link or none" >&2; exit 2;; esac
  case "$timeout_seconds" in ''|*[!0-9]*|0) echo "repro-check: --timeout must be a positive integer" >&2; exit 2;; esac
  case "$class" in DISCRIMINATING|NEW-SURFACE) [ -n "$expect" ] || { echo "repro-check: --expect is required for $class" >&2; exit 2; };; esac
  has_bad_field "$expect" && { echo "repro-check: --expect cannot contain tabs or newlines" >&2; exit 2; }
  trace_for
  require_contained "$trace_dir"
  require_contained "$trace_dir/repro"
  mkdir -p "$trace_dir/repro"
  require_contained "$trace_dir/repro"
  worktree="$(mktemp -d "${TMPDIR:-/tmp}/issue-tracer-repro.XXXXXX")"
  cleanup() { git worktree remove --force "$worktree" >/dev/null 2>&1 || true; rm -rf "$worktree"; }
  trap cleanup EXIT HUP INT TERM
  git worktree add --detach "$worktree" "$base" >/dev/null 2>&1 || { echo "repro-check: could not create disposable worktree" >&2; exit 2; }
  for arg in ${copies[@]+"${copies[@]}"}; do copy_path "$arg"; done
  link_deps
  base_status="$(run_one "$worktree" "$trace_dir/repro/$check_id.base.log" "$timeout_seconds" "$@")"
  head_status="$(run_one "$root" "$trace_dir/repro/$check_id.head.log" "$timeout_seconds" "$@")"
  if [ "$base_status" -eq 124 ] || [ "$head_status" -eq 124 ]; then
    base_result="TIMEOUT"; head_result="TIMEOUT"; verdict="FAIL"; exit_code=6
  elif [ "$class" = DISCRIMINATING ]; then
    if [ "$base_status" -eq 0 ]; then base_result="VACUOUS"; verdict="VACUOUS"; exit_code=4
    elif grep -Eq "$expect" "$trace_dir/repro/$check_id.base.log"; then
      base_result="RED"
      if [ "$head_status" -eq 0 ]; then head_result="GREEN"; verdict="PASS"; else head_result="FAIL"; verdict="FAIL"; exit_code=5; fi
    else base_result="ERROR"; verdict="ERROR"; exit_code=3; fi
  elif [ "$class" = PRESERVING ]; then
    base_result="$( [ "$base_status" -eq 0 ] && echo GREEN || echo FAIL )"
    head_result="$( [ "$head_status" -eq 0 ] && echo GREEN || echo FAIL )"
    if [ "$base_status" -eq 0 ] && [ "$head_status" -eq 0 ]; then verdict=PASS; else verdict=FAIL; exit_code=5; fi
  else
    if [ "$base_status" -ne 0 ] && grep -Eq "$expect" "$trace_dir/repro/$check_id.base.log"; then
      base_result="ERROR"
      if [ "$head_status" -eq 0 ]; then head_result="GREEN"; verdict=PASS; else head_result="FAIL"; verdict=FAIL; exit_code=5; fi
    else base_result="FAIL"; head_result="$( [ "$head_status" -eq 0 ] && echo GREEN || echo FAIL )"; verdict=FAIL; exit_code=5; fi
  fi
  [ -n "${head_result:-}" ] || head_result="$( [ "$head_status" -eq 0 ] && echo GREEN || echo FAIL )"
  printf '### Check %s (%s)\n- base: %s exit=%s result=%s log=repro/%s.base.log\n- head: %s exit=%s result=%s log=repro/%s.head.log\n- argv: %s\n- expect: %s\n- verdict: %s\n' "$check_id" "$class" "$base" "$base_status" "$base_result" "$check_id" "$(git rev-parse HEAD)" "$head_status" "$head_result" "$check_id" "$(quoted_argv "$@")" "${expect:--}" "$verdict"
  exit "$exit_code"
}

do_checkpoint() {
  local reason="-" check_id="" argv="" expect="" base="" path manifest seq kind mode blob row
  trace_dir=""; slug=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --slug) [ "$#" -ge 2 ] || usage; slug="$2"; shift 2;; --trace-dir) [ "$#" -ge 2 ] || usage; trace_dir="$2"; shift 2;;
      --reason) [ "$#" -ge 2 ] || usage; reason="$2"; shift 2;; --id) [ "$#" -ge 2 ] || usage; check_id="$2"; shift 2;;
      --argv) [ "$#" -ge 2 ] || usage; argv="$2"; shift 2;; --expect) [ "$#" -ge 2 ] || usage; expect="$2"; shift 2;; --base) [ "$#" -ge 2 ] || usage; base="$2"; shift 2;;
      --) shift; break;; *) break;;
    esac
  done
  [ "$#" -gt 0 ] || usage
  valid_slug "$slug" && valid_id "$check_id" || { echo "repro-check: invalid slug or check id" >&2; exit 2; }
  case "$reason" in -) kind=CHECKPOINT;; CHECK_WRONG|FORMAT_ONLY|AC_CHANGED_BY_USER) kind=AMEND;; *) echo "repro-check: invalid amendment reason" >&2; exit 2;; esac
  case "$base" in ''|-*) echo "repro-check: --base must name a commit" >&2; exit 2;; esac
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "repro-check: --base does not resolve to a commit" >&2; exit 2; }
  if has_bad_field "$argv" || has_bad_field "$expect"; then
    echo "repro-check: manifest fields cannot contain tabs or newlines" >&2
    exit 2
  fi
  manifest="$(manifest_for)"
  require_contained "$trace_dir"
  require_contained "$(dirname "$manifest")"
  mkdir -p "$(dirname "$manifest")"
  require_contained "$(dirname "$manifest")"
  refuse_nonregular_target "$manifest"
  [ -f "$manifest" ] || printf '# issue-tracer checkpoint manifest v1 rows=0\n' > "$manifest"
  # validate_manifest owns the header check: it is strictly stronger than the
  # old `grep -Fx` (which matched the string on ANY line) and additionally
  # proves the recorded count, the seq run, and the field count.
  validate_manifest "$manifest"
  seq="$(awk 'END {print NR - 1}' "$manifest")"
  for path in "$@"; do
    is_inside_root "$path" || { echo "repro-check: checkpoint path must be repo-relative without ..: $path" >&2; exit 2; }
    has_bad_field "$path" && { echo "repro-check: checkpoint path cannot contain tabs or newlines" >&2; exit 2; }
    [ -f "$root/$path" ] || { echo "repro-check: checkpoint path must be a file: $path" >&2; exit 2; }
    # Re-running the sanctioned `checkpoint` command on an already-frozen path
    # would append a fresh CHECKPOINT row that last-writer-wins re-baselines a
    # weakened check to green in do_verify. Refuse it: superseding a frozen
    # blob requires an AMEND row that names a reason and stays in the file.
    # The manifest is re-read per path, so a path frozen by an earlier
    # iteration of this same invocation is already recorded and also refused.
    if [ "$kind" = CHECKPOINT ] && manifest_has_path "$manifest" "$path"; then
      echo "repro-check: $path is already frozen; supersede it with --reason CHECK_WRONG|FORMAT_ONLY|AC_CHANGED_BY_USER" >&2
      exit 2
    fi
    blob="$(git hash-object "$root/$path")"
    mode="$(git ls-files -s -- "$path" | awk 'NR==1 {print $1}')"
    [ -n "$mode" ] || { [ -x "$root/$path" ] && mode=100755 || mode=100644; }
    seq=$((seq + 1))
    # $seq is post-increment, so it is also the new total row count that the
    # header must record. Row and header land together in one temp-file swap.
    row="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$seq" "$kind" "$path" "$blob" "$mode" "$check_id" "$argv" "$expect" "$(git rev-parse "$base^{commit}")" "$reason")"
    append_manifest_row "$manifest" "$seq" "$row"
    echo "checkpoint: $kind $path"
  done
}

do_verify() {
  local manifest line path old new changed=0
  trace_dir=""; slug=""
  while [ "$#" -gt 0 ]; do case "$1" in --slug) [ "$#" -ge 2 ] || usage; slug="$2"; shift 2;; --trace-dir) [ "$#" -ge 2 ] || usage; trace_dir="$2"; shift 2;; *) usage;; esac; done
  valid_slug "$slug" || { echo "repro-check: invalid slug" >&2; exit 2; }
  manifest="$(manifest_for)"
  [ -f "$manifest" ] || { echo "repro-check: checkpoint manifest missing or invalid" >&2; exit 2; }
  # Iterating only the surviving rows would silently drop a frozen check when a
  # row is deleted OR the tail is truncated, so structure - header count, seq
  # run, field count - is proven before any row is replayed.
  validate_manifest "$manifest"
  while IFS=$'\t' read -r path old; do
    [ -f "$root/$path" ] || { echo "CHANGED $path $old MISSING"; changed=1; continue; }
    new="$(git hash-object "$root/$path")"
    if [ "$old" = "$new" ]; then echo "OK $path"; else echo "CHANGED $path $old $new"; changed=1; fi
  done < <(awk -F '\t' 'NR > 1 {blob[$3]=$4} END {for (path in blob) print path "\t" blob[path]}' "$manifest")
  [ "$changed" -eq 0 ] || exit 1
}

command="${1:-}"; shift || true
case "$command" in run) do_run "$@";; checkpoint) do_checkpoint "$@";; verify-checkpoint) do_verify "$@";; *) usage;; esac
