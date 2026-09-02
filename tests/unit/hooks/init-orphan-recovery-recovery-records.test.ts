/**
 * PR #1966 recovery safety regressions.
 *
 * F-002: init orphan cleanup must preserve worktree directories referenced by
 * valid recovery records and fail safe before any deletion when a recovery
 * record is unreadable or violates the complete schema.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	runInitOrphanRecovery,
} from '../../../src/hooks/init-orphan-recovery';
import { writeRecoveryRecord } from '../../../src/turbo/lean/recovery';

const realInternals = { ..._internals };

let rootDir: string;
let projectDir: string;

function worktreePath(sessionId: string, laneId: string): string {
	return path.join(rootDir, '.swarm-worktrees', sessionId, laneId);
}

function makeWorktree(sessionId: string, laneId: string): string {
	const worktree = worktreePath(sessionId, laneId);
	fs.mkdirSync(worktree, { recursive: true });
	fs.writeFileSync(path.join(worktree, 'unmerged.txt'), 'preserve me\n');
	return worktree;
}

beforeEach(() => {
	rootDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'init-recovery-record-')),
	);
	projectDir = path.join(rootDir, 'project');
	fs.mkdirSync(projectDir, { recursive: true });

	_internals.isLocked = mock(() => null);
	_internals.listActiveLocks = mock(() => []);
	_internals.tryAcquireLock = mock(async () => ({
		acquired: true as const,
		lock: {
			filePath: '.swarm/locks/init-orphan-recovery.lock',
			agent: 'init-orphan-recovery',
			taskId: 'init',
			timestamp: '2024-01-01T00:00:00.000Z',
			expiresAt: Number.MAX_SAFE_INTEGER,
			_release: async () => {},
		},
	}));
	// Force the production filesystem fallback so each test observes whether the
	// candidate directory was actually deleted.
	_internals.removeWorktree = mock(async () => ({
		error: 'not a registered git worktree',
	}));
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('init orphan recovery records', () => {
	test('F-002: preserves a valid recorded worktree while reclaiming its unrecorded sibling', async () => {
		const preserved = makeWorktree('dead-session', 'lane with spaces');
		const unrecorded = makeWorktree('old-session', 'lane-orphan');
		writeRecoveryRecord(projectDir, {
			laneId: 'lane with spaces',
			sessionId: 'dead-session',
			branchName: 'swarm-lane/dead-session/lane-with-spaces',
			worktreePath: preserved,
			status: 'conflict',
			reason: 'merge conflict',
			replayHint:
				'Open the directory in worktreePath and run git status with that directory as the working directory.',
		});

		const result = await runInitOrphanRecovery(projectDir);

		expect(fs.existsSync(preserved)).toBe(true);
		expect(fs.existsSync(path.join(preserved, 'unmerged.txt'))).toBe(true);
		expect(fs.existsSync(unrecorded)).toBe(false);
		expect(result.removedWorktrees).toEqual([unrecorded]);
		expect(
			result.warnings.some(
				(warning) =>
					warning.includes('Preserved recovery worktree') &&
					warning.includes(preserved),
			),
		).toBe(true);

		const advisory = JSON.parse(
			fs.readFileSync(
				path.join(
					projectDir,
					'.swarm',
					'advisories',
					'init-orphan-recovery.json',
				),
				'utf-8',
			),
		) as { warnings: string[] };
		expect(
			advisory.warnings.some((warning) => warning.includes(preserved)),
		).toBe(true);
	});

	test('F-002: preserves a recorded worktree through a physical path alias', async () => {
		const preserved = makeWorktree('dead-session', 'aliased-lane');
		const alias = path.join(rootDir, 'recovery-worktree-alias');
		fs.symlinkSync(
			preserved,
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		writeRecoveryRecord(projectDir, {
			laneId: 'aliased-lane',
			sessionId: 'dead-session',
			branchName: 'swarm-lane/dead-session/aliased-lane',
			worktreePath: alias,
			status: 'conflict',
			reason: 'merge conflict',
			replayHint: 'Resume the recorded worktree.',
		});

		const result = await runInitOrphanRecovery(projectDir);
		expect(fs.existsSync(preserved)).toBe(true);
		expect(fs.existsSync(path.join(preserved, 'unmerged.txt'))).toBe(true);
		expect(result.removedWorktrees).not.toContain(preserved);
		expect(
			result.warnings.some(
				(warning) =>
					warning.includes('Preserved recovery worktree') &&
					warning.includes(preserved),
			),
		).toBe(true);
	});

	test('F-002/F-008: parseable schema errors skip all worktree deletion and surface fail-safe evidence', async () => {
		const wouldBeDeleted = makeWorktree('dead-session', 'lane-unsafe');
		const recoveryDir = path.join(projectDir, '.swarm', 'recovery');
		fs.mkdirSync(recoveryDir, { recursive: true });
		fs.writeFileSync(
			path.join(recoveryDir, 'incomplete.json'),
			JSON.stringify({
				laneId: 'lane-unsafe',
				sessionId: 'dead-session',
				worktreePath: wouldBeDeleted,
				status: 'conflict',
			}),
			'utf-8',
		);

		const result = await runInitOrphanRecovery(projectDir);

		expect(fs.existsSync(wouldBeDeleted)).toBe(true);
		expect(result.removedWorktrees).toEqual([]);
		expect(result.prunedWorktrees).toBe(false);
		expect(
			result.warnings.some((warning) =>
				warning.includes('fail schema validation'),
			),
		).toBe(true);

		const advisory = JSON.parse(
			fs.readFileSync(
				path.join(
					projectDir,
					'.swarm',
					'advisories',
					'init-orphan-recovery.json',
				),
				'utf-8',
			),
		) as {
			recoveryReadError?: boolean;
			warnings: string[];
		};
		expect(advisory.recoveryReadError).toBe(true);
		expect(
			advisory.warnings.some((warning) =>
				warning.includes('skipped all orphaned worktree deletion'),
			),
		).toBe(true);
	});
});
