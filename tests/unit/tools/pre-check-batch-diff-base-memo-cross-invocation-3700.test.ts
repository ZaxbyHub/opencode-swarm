/**
 * F-4 (PR #3718 swarm-pr-review, MEDIUM): the batch-scoped diff-base memo
 * fix site had no CROSS-INVOCATION test. The staleness file drives direct
 * consumer calls (no holder passed — always fresh by contract) and the
 * feedback file proves sharing through ONE explicitly passed holder, so
 * moving the holder back to module scope (`const diffBaseMemo = { current:
 * null }` outside runPreCheckBatch) would reintroduce the #3700.1 stale
 * merge-base fail-open — two consecutive batches sharing one memo — and no
 * focused test would catch it. This file drives `runPreCheckBatch` TWICE
 * across a same-HEAD candidate-ref move:
 *
 *   batch 1: zaxbyhub/main == base      -> committed hop contains the
 *            line-2 edit -> the planted secretscan finding on a.txt:2 is
 *            NEW -> the hard gate fails.
 *   (move zaxbyhub/main to the edit commit — HEAD stays fixed)
 *   batch 2: committed hop is the line-3 add only -> the finding on line 2
 *            is PRE-EXISTING (unchanged) -> non-gating, gates pass.
 *
 * With a module-scoped holder, batch 2 re-serves batch 1's (directory,
 * HEAD)-keyed memo — line 2 still "changed" — and the gates_passed === true
 * assertion reddens. Ambiguity is kept REAL (not stubbed to an empty Set)
 * so the fail-closed null arm cannot mask the classification: the merge
 * base is never HEAD-equal in either batch.
 *
 * The secretscan wrapper is stubbed to plant the finding; the changed-line
 * consumers run for real against the throwaway git repo, so the whole
 * holder-threading path (resolver memo -> both consumers -> classifier)
 * executes under the batch.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	type PreCheckBatchInput,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const IDENTITY = [
	'-c',
	'user.email=test@example.com',
	'-c',
	'user.name=Test',
] as const;

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', [...args], {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: 20_000,
		windowsHide: true,
	});
}

function commitAll(repo: string, message: string): string {
	git(repo, 'add', '-A');
	git(repo, ...IDENTITY, 'commit', '-q', '-m', message);
	return git(repo, 'rev-parse', 'HEAD').trim();
}

describe('runPreCheckBatch diff-base memo cross-invocation freshness (F-4, #3700 item 1)', () => {
	test('two consecutive batches resolve the diff base independently across a same-HEAD candidate-ref move', async () => {
		const root = canonicalMkdtemp('pre-check-memo-cross-invocation-3700-');
		const repo = path.join(root, 'repo');
		const bare = path.join(root, 'zaxbyhub.git');
		const originalInternals = {
			runLintWrapped: _internals.runLintWrapped,
			runSecretscanWrapped: _internals.runSecretscanWrapped,
			runSastScanWrapped: _internals.runSastScanWrapped,
			runQualityBudgetWrapped: _internals.runQualityBudgetWrapped,
			saveEvidence: _internals.saveEvidence,
		};
		try {
			git(root, 'init', '-q', '-b', 'main', repo);
			git(root, 'init', '-q', '--bare', '-b', 'main', bare);
			git(repo, 'remote', 'add', 'zaxbyhub', bare);
			git(repo, 'config', 'core.autocrlf', 'false');

			writeFileSync(path.join(repo, 'a.txt'), 'line one\nline two\n');
			const baseSha = commitAll(repo, 'base');
			// batch 1 state: line 2 edited, line 3 not yet present.
			writeFileSync(path.join(repo, 'a.txt'), 'line one\nline two EDITED\n');
			const editSha = commitAll(repo, 'edit');
			// HEAD carries one further change (line 3) so the merge base is
			// never HEAD-equal (which would fail the ambiguity consumer closed
			// and force every finding NEW in both batches).
			writeFileSync(
				path.join(repo, 'a.txt'),
				'line one\nline two EDITED\nline three\n',
			);
			commitAll(repo, 'add-line-three');
			git(repo, 'push', '-q', 'zaxbyhub', `${baseSha}:refs/heads/main`);

			// Plant a critical secretscan finding on a.txt line 2 through the
			// wrapper seam; everything else stays quiet. The changed-line
			// consumers are NOT stubbed — they run against the real repo.
			_internals.runLintWrapped = (async () => ({
				ran: false,
				duration_ms: 0,
			})) as typeof _internals.runLintWrapped;
			_internals.runSastScanWrapped = (async () => ({
				ran: false,
				duration_ms: 0,
			})) as typeof _internals.runSastScanWrapped;
			_internals.runQualityBudgetWrapped = (async () => ({
				ran: false,
				duration_ms: 0,
			})) as typeof _internals.runQualityBudgetWrapped;
			_internals.runSecretscanWrapped = (async () => ({
				ran: true,
				duration_ms: 1,
				result: {
					scan_dir: repo,
					findings: [
						{
							path: 'a.txt',
							line: 2,
							type: 'generic-secret',
							confidence: 'high',
							severity: 'critical',
							redacted: 'REDACTED',
							context: 'line two EDITED',
						},
					],
					count: 1,
					passed: true,
					files_scanned: 1,
					skipped_files: 0,
					policy_skipped_files: 0,
					requested_files: 1,
					ignored_files: 0,
					incomplete_files: 0,
					incomplete_paths: [],
				},
			})) as typeof _internals.runSecretscanWrapped;
			_internals.saveEvidence =
				(async () => {}) as typeof _internals.saveEvidence;

			const input: PreCheckBatchInput = {
				files: ['a.txt'],
				directory: repo,
			};

			// Batch 1: hop base..HEAD contains the line-2 edit -> finding NEW
			// -> the secretscan hard gate fails.
			const first = await runPreCheckBatch(input);
			expect(first.gates_passed).toBe(false);

			// Move the candidate ref under a FIXED HEAD: zaxbyhub/main now
			// contains the line-2 edit; the hop is the line-3 add only.
			git(
				repo,
				'push',
				'-q',
				'--force',
				'zaxbyhub',
				`${editSha}:refs/heads/main`,
			);
			git(repo, 'fetch', '-q', 'zaxbyhub');

			// Batch 2 (the cross-invocation leg): a fresh batch must
			// re-resolve the diff base — line 2 is pre-existing (unchanged
			// within this hop) -> non-gating -> gates pass. RED against a
			// module-scoped holder (mutant): batch 2 re-serves batch 1's
			// (directory, HEAD) memo, line 2 still reads as changed, the
			// finding stays NEW, and this assertion fails.
			const second = await runPreCheckBatch(input);
			expect(second.gates_passed).toBe(true);
		} finally {
			Object.assign(_internals, originalInternals);
			removeTreeWithRetry(root);
		}
	}, 120_000);
});
