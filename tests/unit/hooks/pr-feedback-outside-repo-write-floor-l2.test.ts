/**
 * Issue #3315 AC27 — general outside-repo write containment FLOOR.
 *
 * GREEN at base and head (floor): the D8 authoring surface (#3315 commit
 * message files, git add admission) must never widen general file-write
 * containment. `architect` — the broadest role — must stay DENIED for writes
 * whose resolved target lives outside the working directory: (a) an absolute
 * path in a SECOND temp directory outside the fixture repo, and (b) a `../`
 * escaping relative path. Both deny with AUTHORITY_ROOT_ESCAPE.
 *
 * Invocation mirrors the working pattern in
 * tests/unit/hooks/guardrails-authority-enhanced.test.ts, which drives the
 * default rule map through the checkFileAuthority wrapper; here
 * checkFileAuthorityWithRules is called directly with DEFAULT_AGENT_AUTHORITY_RULES
 * (the same map buildEffectiveRules(undefined) produces), per the AC.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
	checkFileAuthorityWithRules,
	DEFAULT_AGENT_AUTHORITY_RULES,
} from '../../../src/hooks/guardrails/file-authority.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

describe('issue #3315 AC27 — architect writes outside the repo stay denied', () => {
	let repoDir = '';
	let outsideDir = '';

	afterEach(() => {
		if (repoDir) removeTreeWithRetry(repoDir);
		if (outsideDir) removeTreeWithRetry(outsideDir);
		repoDir = '';
		outsideDir = '';
	});

	test('absolute path in a second temp dir denies with AUTHORITY_ROOT_ESCAPE', () => {
		repoDir = canonicalMkdtemp('auth-floor-repo-');
		outsideDir = canonicalMkdtemp('auth-floor-outside-');
		// A real (commit-less) git repo as the working directory.
		execFileSync('git', ['-C', repoDir, 'init', '-q', '-b', 'main'], {
			stdio: 'ignore',
			timeout: 15_000,
		});

		const decision = checkFileAuthorityWithRules(
			'architect',
			join(outsideDir, 'outside-write.ts'),
			repoDir,
			DEFAULT_AGENT_AUTHORITY_RULES,
		);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/AUTHORITY_ROOT_ESCAPE/);
	});

	test("'../' escaping relative path denies (root escape / workspace containment)", () => {
		repoDir = canonicalMkdtemp('auth-floor-repo-');

		const decision = checkFileAuthorityWithRules(
			'architect',
			'../escapee.ts',
			repoDir,
			DEFAULT_AGENT_AUTHORITY_RULES,
		);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(
			/AUTHORITY_ROOT_ESCAPE|workspace-containment/,
		);
	});
});
