/** Issue #2402 — exact-identity legacy WAL transfer to background ownership. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	beginCoderSettlement,
	releaseCoderDispatchOwnership,
	transferCoderSettlementToBackground,
} from '../../../src/workflow/coder-settlement';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('coder settlement background ownership transfer', () => {
	let directory = '';
	let cleanup = (): void => {};
	const taskId = '1.1';
	const transitionId = 'coder:call-1';

	beforeEach(() => {
		const safe = createSafeTestDir('coder-background-transfer-');
		directory = safe.dir;
		cleanup = safe.cleanup;
	});

	afterEach(() => {
		releaseCoderDispatchOwnership(directory, taskId, transitionId);
		cleanup();
	});

	async function begin(worktreePath?: string): Promise<void> {
		await beginCoderSettlement({
			directory,
			taskId,
			transitionId,
			actor: 'test',
			expectedGeneration: 0,
			context: {
				declaredFiles: ['src/feature.ts'],
				workflowGeneration: 0,
				baseline: {
					directory,
					gitHead: 'a'.repeat(40),
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
			},
			...(worktreePath
				? {
						worktree: {
							callID: 'call-1',
							parentSessionId: 'parent',
							taskId,
							planTaskId: taskId,
							worktreePath,
							branchName: 'swarm/lane/1.1',
							worktreeId: 'lane-1',
							worktreeSessionId: 'child',
							mergeStrategy: 'merge' as const,
							laneIndex: 0,
							worktreeDir: null,
						},
					}
				: {}),
		});
	}

	function readWal(): Record<string, unknown> {
		return JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'coder-settlements', `${taskId}.json`),
				'utf8',
			),
		) as Record<string, unknown>;
	}

	test('is exact-identity and idempotent', async () => {
		await begin();
		await expect(
			transferCoderSettlementToBackground({
				directory,
				taskId,
				transitionId: 'coder:foreign-call',
			}),
		).rejects.toThrow('CODER_SETTLEMENT_WAL_REPLACED');
		expect(readWal().state).toBe('DISPATCHED');

		expect(
			await transferCoderSettlementToBackground({
				directory,
				taskId,
				transitionId,
			}),
		).toBe('transferred');
		expect(
			await transferCoderSettlementToBackground({
				directory,
				taskId,
				transitionId,
			}),
		).toBe('already-terminal');
	});

	test('does not physically clean a background-owned worktree', async () => {
		const worktreePath = path.join(directory, 'background-worktree');
		fs.mkdirSync(worktreePath, { recursive: true });
		fs.writeFileSync(path.join(worktreePath, 'preserved.txt'), 'owned\n');
		await begin(worktreePath);

		await transferCoderSettlementToBackground({
			directory,
			taskId,
			transitionId,
		});

		expect(
			fs.readFileSync(path.join(worktreePath, 'preserved.txt'), 'utf8'),
		).toBe('owned\n');
		expect(readWal()).toMatchObject({
			state: 'ABORTED',
			cleanupComplete: true,
		});
	});

	test('fails closed without mutating a PREPARED settlement', async () => {
		await begin();
		const walPath = path.join(
			directory,
			'.swarm',
			'coder-settlements',
			`${taskId}.json`,
		);
		fs.writeFileSync(
			walPath,
			JSON.stringify({
				...readWal(),
				state: 'PREPARED',
				observedFiles: [],
				accepted: false,
				testEngineerExempt: false,
				settlementFailed: false,
			}),
		);

		await expect(
			transferCoderSettlementToBackground({
				directory,
				taskId,
				transitionId,
			}),
		).rejects.toThrow('CODER_SETTLEMENT_IN_PROGRESS');
		expect(readWal().state).toBe('PREPARED');
	});
});
