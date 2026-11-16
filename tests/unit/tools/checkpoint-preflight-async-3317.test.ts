/**
 * #3427 (trace 3427-3434-rollback-gate-hardening, check C1): the checkpoint
 * tool's TWO repository probes — the `execute` entry preflight and
 * `saveCheckpointRecord`'s probe inside the mutation lock — ride the shared
 * async reader instead of the local sync gitExec retry chain.
 *
 * Discrimination design: a spawn-slot counter on
 * `checkpoint._internals.resolveGitExecutable` (the call slot every local
 * gitExec spawn passes through) proves ZERO sync spawns on the probe paths,
 * while counting stubs on the reader seams prove the probes actually ran
 * through them. At base the probes were sync (slots >= 1, readers never
 * called); at head both legs are async (0 slots, reader called).
 *
 * The saveCheckpointRecord leg acquires the mutation lock (run() executes
 * only after acquisition). Feedback round: the save probe rides
 * `readGitStatusAsync` (bounded transient tolerance on the durable write —
 * branch on `.ok`, the result object is always truthy), the preflight rides
 * the DETAILED reader (`readGitRepositoryStatusDetailedAsync`, cause-
 * specific refusal per #3442), and BOTH are stubbed through the
 * `_internals` seams by PROPERTY ASSIGNMENT — no mock.module anywhere in
 * this file (feedback round PRR-011: the process-global module registration
 * poisoned co-run files even with a passthrough default).
 *
 * This file covers src/tools/checkpoint.ts; it is the DIFFERENT GUARD the
 * no-sync-spawn ratchet's SCANNED_FILES comment names for checkpoint.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

type DetailedStatus =
	| { isRepo: true }
	| {
			isRepo: false;
			reason: 'not_git_repo' | 'git_unavailable' | 'git_error';
			message: string;
	  };

const { checkpoint, _internals } = await import(
	'../../../src/tools/checkpoint'
);

const originalResolver = _internals.resolveGitExecutable;
const originalTryAcquireLock = _internals.tryAcquireLock;
const originalReadGitStatusAsync = _internals.readGitStatusAsync;
const originalReadDetailed = _internals.readGitRepositoryStatusDetailedAsync;

let syncSpawnSlots = 0;
let preflightCalls = 0;
let saveProbeCalls = 0;

function armSlotCounter(): void {
	syncSpawnSlots = 0;
	_internals.resolveGitExecutable = () => {
		syncSpawnSlots += 1;
		return originalResolver();
	};
}

function armPreflight(status: DetailedStatus): void {
	preflightCalls = 0;
	_internals.readGitRepositoryStatusDetailedAsync = (async () => {
		preflightCalls += 1;
		return status;
	}) as unknown as typeof _internals.readGitRepositoryStatusDetailedAsync;
}

function armSaveProbe(ok: boolean): void {
	saveProbeCalls = 0;
	_internals.readGitStatusAsync = (async () => {
		saveProbeCalls += 1;
		return ok
			? { ok: true as const, stdout: '.git\n' }
			: { ok: false as const, code: null, status: 1, stderrTail: '' };
	}) as unknown as typeof _internals.readGitStatusAsync;
}

function makeRealRepo(): string {
	const root = canonicalMkdtemp('c1-real-repo-');
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

function acquiredLock(taskId: string) {
	return {
		acquired: true,
		lock: {
			filePath: '.swarm/checkpoints.json',
			agent: 'checkpoint',
			taskId,
			// Static literals: inert fixture fields (the acquired stub
			// short-circuits every expiry check), kept off the raw
			// clock per check:test-clock.
			timestamp: '2026-10-24T00:00:00.000Z',
			expiresAt: 1_800_000_000_000,
			_release: async () => {},
		},
	};
}

afterEach(() => {
	// Property-assignment stubs only — every seam restored, nothing
	// process-global leaks to co-run files (feedback round PRR-011).
	_internals.resolveGitExecutable = originalResolver;
	_internals.tryAcquireLock = originalTryAcquireLock;
	_internals.readGitStatusAsync = originalReadGitStatusAsync;
	_internals.readGitRepositoryStatusDetailedAsync = originalReadDetailed;
	preflightCalls = 0;
	saveProbeCalls = 0;
});

describe('execute preflight rides the async detailed reader (#3427 C1)', () => {
	test('non-repo: zero sync spawn slots, reader called, not-a-repository refusal', async () => {
		const tempDir = canonicalMkdtemp('c1-preflight-');
		try {
			armSlotCounter();
			armPreflight({
				isRepo: false,
				reason: 'not_git_repo',
				message: 'fatal: not a git repository',
			});

			const result = await checkpoint.execute({ action: 'list' }, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe(
				'not a git repository - checkpoint tools require a git repository',
			);
			expect(preflightCalls).toBe(1);
			expect(syncSpawnSlots).toBe(0);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('#3442: unavailable executable names the cause, still zero sync spawns', async () => {
		const tempDir = canonicalMkdtemp('c1-preflight-noent-');
		try {
			armSlotCounter();
			armPreflight({
				isRepo: false,
				reason: 'git_unavailable',
				message: 'git executable is not available: spawning "git" failed',
			});

			const result = await checkpoint.execute({ action: 'list' }, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe(
				'git executable is not available - checkpoint tools require a git repository',
			);
			expect(preflightCalls).toBe(1);
			expect(syncSpawnSlots).toBe(0);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('#3442: git_error carries the reader message in the refusal', async () => {
		const tempDir = canonicalMkdtemp('c1-preflight-err-');
		try {
			armSlotCounter();
			armPreflight({
				isRepo: false,
				reason: 'git_error',
				message: 'git read failed (ETIMEDOUT)',
			});

			const result = await checkpoint.execute({ action: 'list' }, tempDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain(
				'git probe failed (git read failed (ETIMEDOUT))',
			);
			expect(parsed.error).toContain(
				'checkpoint tools require a git repository',
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe('saveCheckpointRecord probe rides readGitStatusAsync (#3427 C1)', () => {
	test('reader false: zero sync spawn slots, probe called, record saved without a SHA', async () => {
		const tempDir = canonicalMkdtemp('c1-save-record-');
		try {
			armSlotCounter();
			armSaveProbe(false);
			// run() executes only after lock ACQUISITION — supply the full
			// FileLock shape (checkpoint-locking.test.ts convention).
			_internals.tryAcquireLock = (async () =>
				acquiredLock(
					'c1-save-record',
				)) as unknown as typeof _internals.tryAcquireLock;

			const { saveCheckpointRecord } = await import(
				'../../../src/tools/checkpoint'
			);
			const result = await saveCheckpointRecord('c1-probe', tempDir);

			expect(result.success).toBe(true);
			// Probe-false skips getCurrentSha — nothing sync may spawn, and
			// the record ships without a SHA plus the no-restore-target
			// warning.
			expect(result.sha).toBe('');
			expect(result.warning).toContain('no git restore target');
			expect(saveProbeCalls).toBe(1);
			expect(syncSpawnSlots).toBe(0);
			// The record landed in the temp project's checkpoint log.
			expect(
				fs.existsSync(path.join(tempDir, '.swarm', 'checkpoints.json')),
			).toBe(true);
		} finally {
			_internals.tryAcquireLock = originalTryAcquireLock;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('reader TRUE against a real repo (feedback PRR-015): the intentional getCurrentSha spawn fires (slots === 1) and the record carries the real HEAD', async () => {
		const repo = makeRealRepo();
		try {
			armSlotCounter();
			armSaveProbe(true);
			_internals.tryAcquireLock = (async () =>
				acquiredLock(
					'c1-save-real',
				)) as unknown as typeof _internals.tryAcquireLock;

			const { saveCheckpointRecord } = await import(
				'../../../src/tools/checkpoint'
			);
			const result = await saveCheckpointRecord('c1-real', repo);

			expect(result.success).toBe(true);
			const realHead = execSync('git rev-parse HEAD', {
				cwd: repo,
				encoding: 'utf-8',
				timeout: 30_000,
			}).trim();
			// The ONE sync spawn on this path is the intentional
			// getCurrentSha — its slot proves the durable write recorded a
			// real SHA instead of silently shipping sha:''.
			expect(syncSpawnSlots).toBe(1);
			expect(result.sha).toBe(realHead);
			expect(result.warning).toBeUndefined();
			expect(saveProbeCalls).toBe(1);
		} finally {
			_internals.tryAcquireLock = originalTryAcquireLock;
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
