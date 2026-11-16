/**
 * Issue #3315 acceptance check AC9 — swarm-pr-feedback skill staging text.
 * Classification: DISCRIMINATING — RED at base, GREEN after the fix.
 *
 * The skill's "Pre-flight: Dirty Worktree Handling" section teaches the bare
 * multi-path staging form:
 *
 * ```bash
 * git add src/foo.ts tests/foo.test.ts
 * ```
 *
 * That exact form is what the PR_FEEDBACK shell classifier refuses at base
 * (trace 3315-prescribed-tools-reachable, defect D3): a bare `git add` with
 * positional pathspecs is indistinguishable from the beginning of a
 * pathspec-glob staging sweep, and no staging verb is admitted at all today.
 * The fix (AC7/AC9) replaces the instructional text with the sanctioned
 * exact-path form `git add -- <path>...`, where the `--` terminator makes
 * every remaining token a literal path. This check freezes the text contract:
 * the bare example must be gone and the `--` form must be present.
 *
 * Base behavior (verified 2026-10-18): the file contains the bare string
 * `git add src/foo.ts tests/foo.test.ts` (SKILL.md line 204) and contains no
 * `git add -- ` anywhere, so BOTH assertions below fail at base.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the canonical skill repo-relative from this test file first
 * (tests/unit/skills/ -> three levels up to the repository root), falling back
 * to process.cwd() resolution when the tree is laid out differently. The test
 * runner executes from the repository root, so both resolve to the same file;
 * keeping the file-relative form primary means the check still pins the
 * canonical skill when invoked from elsewhere.
 */
function resolveSkillPath(): string {
	const relativeToTestFile = join(
		__dirname,
		'..',
		'..',
		'..',
		'.opencode',
		'skills',
		'swarm-pr-feedback',
		'SKILL.md',
	);
	if (existsSync(relativeToTestFile)) return relativeToTestFile;
	return join(
		process.cwd(),
		'.opencode',
		'skills',
		'swarm-pr-feedback',
		'SKILL.md',
	);
}

describe('swarm-pr-feedback skill staging text (issue #3315 AC9)', () => {
	test('teaches only the sanctioned `git add -- <exact paths>` staging form', () => {
		const content = readFileSync(resolveSkillPath(), 'utf-8');

		// Post-fix contract: the bare multi-path example is gone. At base this
		// fails because the bare string is the literal fenced example (line 204).
		expect(
			content,
			'swarm-pr-feedback SKILL.md still instructs the bare `git add src/foo.ts tests/foo.test.ts` form the PR_FEEDBACK shell classifier refuses (issue #3315 D3/AC9)',
		).not.toContain('git add src/foo.ts tests/foo.test.ts');

		// Post-fix contract: the sanctioned exact-path form with the `--`
		// pathspec terminator is documented. At base this fails because no
		// `git add -- ` occurs anywhere in the file.
		expect(
			content,
			'swarm-pr-feedback SKILL.md does not document the sanctioned `git add -- <exact paths>` staging form (issue #3315 AC9)',
		).toContain('git add -- ');
	});
});
