#!/usr/bin/env bash
# Issue #1976 — advisory-injection gating ratchet.
#
# Forbids direct `.push()` onto `session.pendingAdvisoryMessages` outside the
# shared helper `src/utils/advisory-queue.ts`. Every producer must route
# through `pushAdvisory(...)` so the advisory queue gets a gate (dedupe +
# length cap) by construction. Without this ratchet the defect class
# (ungated, unbounded, re-firing advisory injection) silently returns the
# first time a contributor adds a new `.push(...)` site.
#
# Portability: bash 3.2 (macOS) compatible — no associative arrays, no `grep -P`.
set -euo pipefail

# Resolve repo root from script location (works from any CWD).
script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

helper="src/utils/advisory-queue.ts"

violations=0
violation_details=""

# Find production .ts files (exclude tests, the helper itself, build output,
# and type/test fixtures) that reference pendingAdvisoryMessages.push.
while IFS= read -r file; do
	rel="${file#"$repo_root"/}"
	# The helper is the only allowed site.
	if [[ "$rel" == "$helper" ]]; then
		continue
	fi
	# Match a direct push onto pendingAdvisoryMessages (the anti-pattern).
	# `grep -E` (BSD/GNU portable); matches `pendingAdvisoryMessages.push(` with
	# optional whitespace around the dot/parens. Tolerates the idiomatic
	# optional-chaining (`?.push(`) and non-null-assertion (`!.push(`) forms,
	# because the field is declared optional (`pendingAdvisoryMessages?: string[]`)
	# and a future contributor's natural raw-push will use one of those.
	matches=$(grep -nE 'pendingAdvisoryMessages[[:space:]]*([?!][[:space:]]*)?\.[[:space:]]*push[[:space:]]*\(' "$file" 2>/dev/null || true)
	if [ -n "$matches" ]; then
		violations=$((violations + 1))
		# Prefix each matching line with the relative file path.
		while IFS= read -r line; do
			violation_details="${violation_details}\n  ${rel}:${line}"
		done <<<"$matches"
	fi
done < <(grep -rlE 'pendingAdvisoryMessages' "$repo_root/src" --include='*.ts' 2>/dev/null | grep -vE '__tests__|\.test\.ts$|\.adversarial\.test\.ts$')

echo "=== Check: no raw pendingAdvisoryMessages.push outside $helper (issue #1976) ==="
if [ "$violations" -gt 0 ]; then
	echo "ERROR: found direct pendingAdvisoryMessages.push() call(s) outside the shared"
	echo "       advisory-queue helper. Route every advisory push through"
	echo "       pushAdvisory(session, message, opts?) (src/utils/advisory-queue.ts) so the"
	echo "       queue gets dedupe + length cap by construction."
	echo -e "Violations:$violation_details"
	echo ""
	echo "To fix: replace"
	echo "    session.pendingAdvisoryMessages ??= [];"
	echo "    session.pendingAdvisoryMessages.push(msg);"
	echo "with"
	echo "    pushAdvisory(session, msg);"
	exit 1
fi

echo "OK — all advisory pushes route through pushAdvisory()."
