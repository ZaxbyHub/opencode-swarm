/**
 * #3434 (trace 3427-3434-rollback-gate-hardening, check C5): both porcelain
 * parsers exclude `../`-bearing records from the destroy-scope set and
 * surface them as a diagnostic instead of joining them into the
 * confirm-token scope digest unvalidated.
 *
 * Coverage: both parsers (NUL form rollback-gate.ts, newline form
 * destructive-purge.ts) at the API level, plus the production surfaces —
 * measureGitDestruction's excludedOutOfRoot + filtered dirtyRelPaths, the
 * /swarm rollback preview text (dirty + all-excluded clean-tree cases, via
 * the real handleRollbackCommand with a seeded checkpoint log), and the
 * close gate result field (through the close gate's own runGit seam).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _closeGateInternals } from '../../../src/commands/close/orchestrator';
import {
	parseTrackedDirtyPaths as parseNewline,
	parseTrackedDirtyPathsWithExclusions as parseNewlineWithExclusions,
} from '../../../src/commands/destructive-purge';
import { handleRollbackCommand } from '../../../src/commands/rollback';
import {
	_rollbackGateInternals,
	isOutOfRootRelativePath,
	measureGitDestruction,
	parseTrackedDirtyPaths as parseNul,
	parseTrackedDirtyPathsWithExclusions as parseNulWithExclusions,
	untrackedPathsInTargetTree,
} from '../../../src/commands/rollback-gate';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalRunGit = _rollbackGateInternals.runGit;
const originalRunGitBuffered = _rollbackGateInternals.runGitBuffered;
const originalCloseRunGit = _closeGateInternals.runGit;

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = canonicalMkdtemp('c5-repo-');
	tempRoots.push(root);
	// Host-hardened fixture (feedback PRR-012): identity is unnecessary for
	// an empty commit when identity config is skipped entirely; gpgsign off,
	// hooks/templates isolated, bounded spawn.
	execSync('git -c init.defaultBranch=main -c init.templateDir= init -q', {
		cwd: root,
		timeout: 30_000,
	});
	execSync(
		'git -c user.name=swarm-test -c user.email=swarm-test@example.com -c commit.gpgsign=false -c core.hooksPath= commit -q --allow-empty --no-verify -m init',
		{ cwd: root, timeout: 30_000 },
	);
	return root;
}

function seedCheckpoint(root: string, label: string): void {
	fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.swarm', 'checkpoints.json'),
		JSON.stringify({
			version: 1,
			checkpoints: [
				{ label, sha: 'HEAD', timestamp: '2026-10-24T00:00:00.000Z' },
			],
		}),
	);
}

function stubRollbackStatus(statusOutput: string): void {
	_rollbackGateInternals.runGit = (async () => ({
		ok: true as const,
		stdout: statusOutput,
	})) as unknown as typeof _rollbackGateInternals.runGit;
	_rollbackGateInternals.runGitBuffered = (async () => ({
		ok: true as const,
		stdout: '',
	})) as unknown as typeof _rollbackGateInternals.runGitBuffered;
}

afterEach(() => {
	_rollbackGateInternals.runGit = originalRunGit;
	_rollbackGateInternals.runGitBuffered = originalRunGitBuffered;
	_closeGateInternals.runGit = originalCloseRunGit;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('containment predicate', () => {
	test('out-of-root and absolute forms are rejected; in-root forms pass', () => {
		expect(isOutOfRootRelativePath('../outside.txt')).toBe(true);
		expect(isOutOfRootRelativePath('a/../../outside.txt')).toBe(true);
		expect(isOutOfRootRelativePath('/abs/path.txt')).toBe(true);
		expect(isOutOfRootRelativePath('..')).toBe(true);
		expect(isOutOfRootRelativePath('src/file.ts')).toBe(false);
		expect(isOutOfRootRelativePath('a/b/../c.txt')).toBe(false);
	});
});

describe('NUL parser (rollback-gate) excludes out-of-root records (#3434 C5)', () => {
	test('dirty ../-bearing record excluded and surfaced; in-root record kept', () => {
		const result = parseNulWithExclusions(
			'M  src/kept.ts\0M  ../outside.txt\0',
		);
		expect(result.dirtyPaths).toEqual(['src/kept.ts']);
		expect(result.excludedOutOfRoot).toEqual(['../outside.txt']);
	});

	test('rename record with an out-of-root ORIG side excludes only that side', () => {
		const result = parseNulWithExclusions('R  src/new.ts\0../evil-old.txt\0');
		expect(result.dirtyPaths).toEqual(['src/new.ts']);
		expect(result.excludedOutOfRoot).toEqual(['../evil-old.txt']);
	});

	test('legacy string[] export returns only in-root paths', () => {
		expect(parseNul('M  src/kept.ts\0M  ../outside.txt\0')).toEqual([
			'src/kept.ts',
		]);
	});
});

describe('newline parser (destructive-purge) excludes out-of-root records (#3434 C5)', () => {
	test('dirty ../-bearing record excluded and surfaced; in-root record kept', () => {
		const result = parseNewlineWithExclusions(
			'M  src/kept.ts\nM  ../outside.txt\n',
		);
		expect(result.dirtyPaths).toEqual(['src/kept.ts']);
		expect(result.excludedOutOfRoot).toEqual(['../outside.txt']);
	});

	test('rename record with an out-of-root side excludes only that side', () => {
		const result = parseNewlineWithExclusions(
			'R  ../evil-old.txt -> src/new.ts\n',
		);
		expect(result.dirtyPaths).toEqual(['src/new.ts']);
		expect(result.excludedOutOfRoot).toEqual(['../evil-old.txt']);
	});

	test('legacy string[] export returns only in-root paths', () => {
		expect(parseNewline('M  src/kept.ts\nM  ../outside.txt\n')).toEqual([
			'src/kept.ts',
		]);
	});
});

describe('measureGitDestruction surfaces exclusions and filters the scope (#3434 C5)', () => {
	test('mixed dirty set: ../-bearing record excluded from dirtyRelPaths, carried on the result', async () => {
		const root = makeRepo();
		stubRollbackStatus('M  src/kept.ts\0M  ../outside.txt\0');

		const measurement = await measureGitDestruction(root, 'HEAD');

		expect(measurement.kind).toBe('ok');
		if (measurement.kind === 'ok') {
			expect(measurement.dirtyRelPaths).toEqual(['src/kept.ts']);
			expect(measurement.excludedOutOfRoot).toEqual(['../outside.txt']);
		}
	});
});

describe('production diagnostic surfaces (#3434 C5)', () => {
	test('rollback preview carries the bounded exclusion line on the dirty path', async () => {
		const root = makeRepo();
		seedCheckpoint(root, 'c5-preview');
		stubRollbackStatus('M  src/kept.ts\0M  ../outside.txt\0');

		const text = await handleRollbackCommand(root, ['c5-preview']);

		expect(text).toContain('DESTROY 1 uncommitted tracked file(s)');
		expect(text).toContain('src/kept.ts');
		expect(text).toContain(
			'1 out-of-root porcelain record(s) were excluded from this scope',
		);
		// The excluded path never enters the preview's file list.
		expect(text).not.toContain('  - ../outside.txt');
	});

	test('rollback all-excluded clean-tree restore still surfaces the exclusion', async () => {
		const root = makeRepo();
		seedCheckpoint(root, 'c5-clean');
		stubRollbackStatus('M  ../outside.txt\0');

		const text = await handleRollbackCommand(root, ['c5-clean']);

		// Every dirty record was excluded — the clean-tree branch restored
		// (reset --hard HEAD on the temp repo), and the diagnostic rides the
		// response instead of being silently dropped.
		expect(text).toContain(
			'1 out-of-root porcelain record(s) were excluded from this scope',
		);
	});

	test('close gate result carries excludedOutOfRoot through its own runGit seam', async () => {
		const root = makeRepo();
		const swarmDir = path.join(root, '.swarm');
		_closeGateInternals.runGit = (async () => ({
			ok: true as const,
			stdout: 'M  src/kept.ts\nM  ../outside.txt\n',
		})) as unknown as typeof _closeGateInternals.runGit;

		const { evaluateClosePurgeGate } = await import(
			'../../../src/commands/close/orchestrator'
		);
		const gate = await evaluateClosePurgeGate(root, swarmDir);

		expect(gate.dirtyPaths).toEqual(['src/kept.ts']);
		expect(gate.excludedOutOfRoot).toEqual(['../outside.txt']);
		expect(gate.wouldDestroyTrackedWork).toBe(true);
	});
});

describe('checkpoint confirmed-restore + clean-tree diagnostics (#3442, feedback PRR-006 bundle)', () => {
	test('confirmed dirty restore appends the exclusion note to the success message', async () => {
		const root = makeRepo();
		seedCheckpoint(root, 'c5-confirm');
		stubRollbackStatus('M  src/kept.ts M  ../outside.txt ');

		const { checkpoint, _internals: ckInternals } = await import(
			'../../../src/tools/checkpoint'
		);
		const { issueConfirmToken } = await import(
			'../../../src/commands/destructive-purge'
		);

		// Mint a token over the exact candidate set the stubbed measurement
		// will report, so consumeConfirmToken accepts it at the sink.
		const candidates = [
			{
				path: path.join(root, 'src', 'kept.ts'),
				reason: 'uncommitted tracked change — destroyed by git reset --hard',
			},
		];
		// kind must equal the sink's ROLLBACK_GIT_KIND literal.
		const token = issueConfirmToken(candidates[0].path, root, {
			kind: 'swarm-rollback-git',
			candidates,
		});

		// The dirty file must EXIST on disk: the confirmed restore's backup
		// gate refuses when an at-risk file owes a copy and none was made,
		// and a missing file creates no backup dir at all.
		fs.mkdirSync(path.join(root, 'src'), { recursive: true });
		fs.writeFileSync(path.join(root, 'src', 'kept.ts'), 'uncommitted work');

		// Stub the measurement seam (property assignment; restored below).
		const originalMeasure = ckInternals.measureGitDestruction;
		ckInternals.measureGitDestruction = (async () => ({
			kind: 'ok' as const,
			dirtyRelPaths: ['src/kept.ts'],
			excludedOutOfRoot: ['../outside.txt'],
		})) as unknown as typeof originalMeasure;

		try {
			// execute(args, ctx) — the context object carries `directory`;
			// a bare string would fall back to process.cwd().
			const result = await checkpoint.execute(
				{ action: 'restore', label: 'c5-confirm', confirm_token: token },
				{ directory: root },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			// #3442: the CONFIRMED destructive restore carries the note like
			// its preview and clean-tree siblings. The excluded record's
			// bytes are sanitized (formatExcludedRecord) before rendering.
			expect(parsed.message).toContain(
				'1 out-of-root porcelain record(s) were excluded from this scope',
			);
		} finally {
			ckInternals.measureGitDestruction = originalMeasure;
		}
	});

	test('clean-tree restore message carries the note when every record was excluded', async () => {
		const root = makeRepo();
		seedCheckpoint(root, 'c5-clean-msg');
		stubRollbackStatus('M  ../outside.txt ');

		const { checkpoint, _internals: ckInternals } = await import(
			'../../../src/tools/checkpoint'
		);

		const originalMeasure = ckInternals.measureGitDestruction;
		ckInternals.measureGitDestruction = (async () => ({
			kind: 'ok' as const,
			dirtyRelPaths: [],
			excludedOutOfRoot: ['../outside.txt'],
		})) as unknown as typeof originalMeasure;

		try {
			const result = await checkpoint.execute(
				{ action: 'restore', label: 'c5-clean-msg' },
				{ directory: root },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.message).toContain(
				'1 out-of-root porcelain record(s) were excluded from this scope',
			);
		} finally {
			ckInternals.measureGitDestruction = originalMeasure;
		}
	});

	test('rollback --yes restore appends the exclusion note to the confirmed output', async () => {
		const root = makeRepo();
		seedCheckpoint(root, 'c5-yes');
		stubRollbackStatus('M  src/kept.ts M  ../outside.txt ');
		// The --yes path restores for real: the dirty file must exist so the
		// backup gate has something to copy.
		fs.mkdirSync(path.join(root, 'src'), { recursive: true });
		fs.writeFileSync(path.join(root, 'src', 'kept.ts'), 'work');

		const text = await handleRollbackCommand(root, ['c5-yes', '--yes']);

		expect(text).toContain('Rolled back to checkpoint');
		expect(text).toContain(
			'1 out-of-root porcelain record(s) were excluded from this scope',
		);
	});

	test('enumeration-failure refusal names the target-tree listing and carries the exclusion note (rollback render)', async () => {
		const root = makeRepo();
		seedCheckpoint(root, 'c5-enum');
		// Status read succeeds WITH an excluded record; ls-tree fails.
		_rollbackGateInternals.runGit = (async () => ({
			ok: true as const,
			stdout: 'M  ../outside.txt ',
		})) as unknown as typeof _rollbackGateInternals.runGit;
		_rollbackGateInternals.runGitBuffered = (async (args: string[]) =>
			args[0] === 'ls-tree'
				? {
						ok: false as const,
						code: 'ETIMEDOUT' as const,
						status: null,
						stderrTail: 'child timed out',
					}
				: {
						ok: true as const,
						stdout: '',
					}) as unknown as typeof _rollbackGateInternals.runGitBuffered;

		const text = await handleRollbackCommand(root, ['c5-enum']);

		// PRR-004 render: the refusal names the LISTING, not git status, and
		// PRR-005 render: the already-parsed exclusion rides the refusal.
		expect(text).toContain('the target-tree listing could not be read');
		expect(text).toContain('target-tree listing read timed out (ETIMEDOUT)');
		expect(text).toContain(
			'1 out-of-root porcelain record(s) had been excluded from the scope before the read failed',
		);
		expect(text).not.toContain('git status unreadable');
	});

	test('checkpoint enumeration-failure refusal renders the same source-aware text (checkpoint render)', async () => {
		const root = makeRepo();
		seedCheckpoint(root, 'c5-ck-enum');

		const { checkpoint, _internals: ckInternals } = await import(
			'../../../src/tools/checkpoint'
		);
		const originalMeasure = ckInternals.measureGitDestruction;
		ckInternals.measureGitDestruction = (async () => ({
			kind: 'unreadable' as const,
			code: 'ETIMEDOUT' as const,
			status: null,
			stderrTail: 'child timed out',
			source: 'enumeration' as const,
			excludedOutOfRoot: ['../outside.txt'],
		})) as unknown as typeof originalMeasure;

		try {
			const result = await checkpoint.execute(
				{ action: 'restore', label: 'c5-ck-enum' },
				{ directory: root },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain(
				'the target-tree listing could not be read',
			);
			expect(parsed.error).toContain(
				'target-tree listing read timed out (ETIMEDOUT)',
			);
			expect(parsed.error).toContain(
				'1 out-of-root porcelain record(s) had been excluded from the scope before the read failed',
			);
		} finally {
			ckInternals.measureGitDestruction = originalMeasure;
		}
	});

	test('real corrupted .git/index: ls-files failure surfaces as failure, not an empty listing', async () => {
		const root = makeRepo();
		// Overwrite the index with garbage — the real readers run (no seam
		// stubs in this leg): ls-tree succeeds, ls-files fails.
		fs.writeFileSync(path.join(root, '.git', 'index'), 'garbage-not-an-index');

		const result = await untrackedPathsInTargetTree(root, 'HEAD');

		expect(result.paths).toEqual([]);
		expect(result.failure).not.toBeNull();
	});
});
