/**
 * Fail-closed guard for git ref arguments (issue #2476 AC3, source issue
 * #2265).
 *
 * Defect class: a repository- or caller-derived ref interpolated into a git
 * argv position can BEGIN WITH A DASH and be parsed by git as an OPTION. A
 * hostile remote can advertise `refs/heads/--evil` (`git update-ref` bypasses
 * `check-ref-format`; a plain `git clone` propagates it), so `git checkout
 * --evil` exits 129 with "unknown option" and a branch literally named
 * `--force` makes `git checkout --force` SILENTLY DESTRUCTIVE.
 *
 * Guard placement is per-command, settled empirically against git 2.x (see
 * `.agents/issue-traces/2476-harden-trust-boundaries/02-reproduction.md` R3):
 *
 * - `branch -d -- <name>` and `push <remote> -- <refspec>` accept a literal
 *   `--` end-of-options separator with IDENTICAL semantics for benign names
 *   and fail-closed behavior for hostile ones — those sinks insert `--`.
 * - `checkout`, `checkout -b <new> <start>`, `rev-parse --verify`,
 *   `rev-parse --abbrev-ref <b>@{upstream}`, `reset --hard`, `log <range>`,
 *   `diff <base> HEAD`, and `branch --merged <target>` REGRESS benign
 *   behavior when a leading `--` is inserted (pathspec/malformed-object
 *   errors) — those sinks use this validation guard instead.
 *
 * The predicate is deliberately minimal — NOT the full check-ref-format
 * grammar — so `origin/main`, `HEAD`, `feature/x`, SHAs, and each side of an
 * `a..b` range all pass while any dash-leading side is rejected. This mirrors
 * the in-repo validator family (`isSafeGitRef` in ci-simulate.ts,
 * `isSafeGitRevisionToken` in workspace-snapshot.ts, `isSafeGitRefToken` in
 * pr-workflow-gate.ts), which this module centralizes for the src/git sinks.
 */

/** Typed, fail-closed rejection of an option-injectable git ref. */
export class UnsafeGitRefError extends Error {
	constructor(
		readonly ref: string,
		readonly context: string,
	) {
		super(
			`Refused unsafe git ref "${ref}" at ${context}: a ref argument ` +
				'starting with "-" can be parsed by git as an option (issue #2265/#2476)',
		);
		this.name = 'UnsafeGitRefError';
	}
}

/**
 * True when `value` is safe to interpolate into a git argv ref position:
 * non-empty, and no `..`-separated side starts with "-". Empty/odd `..`
 * sides are deliberately NOT rejected here (a name like `../../x` is not an
 * option-injection risk; git itself rejects it as an invalid ref, and the
 * pre-existing adversarial contract in tests/unit/git/branch.adversarial
 * pins pass-through for those shapes) — only dash-leading sides are.
 */
export function isSafeGitRefArg(value: string): boolean {
	if (value.length === 0) return false;
	for (const side of value.split('..')) {
		if (side.startsWith('-')) return false;
	}
	return true;
}

/**
 * Fail-closed form of {@link isSafeGitRefArg}: returns `value` unchanged when
 * safe, throws {@link UnsafeGitRefError} otherwise. `context` names the
 * caller/sink so the error is actionable (e.g. "createBranch checkout").
 */
export function assertSafeGitRefArg(value: string, context: string): string {
	if (!isSafeGitRefArg(value)) {
		throw new UnsafeGitRefError(value, context);
	}
	return value;
}
