/**
 * Real-git evidence arms for the Lean Turbo Rule-3 predicate (issue #2962,
 * split from rule3-production-wiring.test.ts for the FR-006 500-line cap
 * during the PR #3506 feedback round).
 *
 * These arms run the CURRENT Epic marker machinery with NO seams over a real
 * scratch repository: merge-shaped `--no-ff` landings, `Swarm-Plan:` trailer
 * filtering, scrubbed-id mapping, and unborn-HEAD classification.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatEpicTaskCommitMessage } from '../../../../src/epic/plan-key';
import {
	resolveLeanRule3Predicate,
	_internals as uc,
} from '../../../../src/turbo/lean/upstream-committed';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';
import {
	OTHER_PLAN_KEY,
	openEpicRecord,
	PLAN_KEY,
	seamEpicOpen,
} from './_rule3-fixtures';

const realUc = { ...uc };

let tmpDir: string;

function git(dir: string, args: string[]): string {
	const r = spawnSync('git', args, {
		cwd: dir,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

function initRepo(): string {
	git(tmpDir, ['init', '--initial-branch=main']);
	git(tmpDir, ['config', 'user.email', 'test@example.com']);
	git(tmpDir, ['config', 'user.name', 'Rule3 Test']);
	fs.writeFileSync(path.join(tmpDir, 'base.txt'), 'base\n');
	git(tmpDir, ['add', '.']);
	git(tmpDir, ['commit', '-m', 'base commit']);
	return git(tmpDir, ['rev-parse', 'HEAD']).trim();
}

/** Mirror the production landing shape: work committed on a lane branch,
 * then merged back with `git merge --no-ff -m <swarm(task ...)>` — the
 * marker lands on a MERGE commit, which a `--no-merges` scan would miss. */
function landTask(taskId: string, planKey: string): void {
	const safe = taskId.replace(/\W/g, '_');
	git(tmpDir, ['checkout', '-q', '-b', `lane-${safe}`]);
	fs.writeFileSync(path.join(tmpDir, `${safe}.txt`), 'landed\n');
	git(tmpDir, ['add', '.']);
	git(tmpDir, ['commit', '-m', `wip ${safe}`]);
	git(tmpDir, ['checkout', '-q', 'main']);
	git(tmpDir, [
		'merge',
		'--no-ff',
		'-m',
		formatEpicTaskCommitMessage(taskId, planKey, 'landed work'),
		`lane-${safe}`,
	]);
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('rule3-git-');
	// epicCommitRange falls back to 'HEAD' when baseCommit is not a full SHA.
	seamEpicOpen(openEpicRecord(null));
});

afterEach(() => {
	Object.assign(uc, realUc);
	removeTreeWithRetry(tmpDir);
});

describe('real-git evidence arms (current Epic marker machinery, no seams)', () => {
	test('merge-shaped --no-ff landing satisfies the predicate for its task id', () => {
		initRepo();
		landTask('1.1', PLAN_KEY);
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1', '2.1']);
		expect(predicate?.('1.1')).toBe(true);
		expect(predicate?.('2.1')).toBe(false);
	});

	test('same task id under a DIFFERENT plan key does NOT satisfy the predicate', () => {
		initRepo();
		landTask('1.1', OTHER_PLAN_KEY);
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1']);
		expect(predicate?.('1.1')).toBe(false);
	});

	test('scrubbed task id maps back to the raw plan id', () => {
		initRepo();
		const rawId = '1.1 (a)';
		landTask(rawId, PLAN_KEY); // subject carries the scrubbed id
		const predicate = resolveLeanRule3Predicate(tmpDir, [rawId]);
		expect(predicate?.(rawId)).toBe(true);
	});

	test('unborn HEAD (empty repository): defined predicate, empty committed set', () => {
		git(tmpDir, ['init', '--initial-branch=main']);
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1']);
		expect(predicate).toBeDefined();
		expect(predicate?.('1.1')).toBe(false);
	});
});
