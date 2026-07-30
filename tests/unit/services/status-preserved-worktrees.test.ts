/**
 * #1657: `/swarm status` preserved-worktrees section.
 *
 * Verifies that `getStatusData` surfaces durable merge-back recovery records
 * under `.swarm/recovery/` as `status.leanPreservedRecoveryWorktrees`, and that
 * `formatStatusMarkdown` renders a "Preserved recovery worktrees" block when
 * records exist (and omits it when none do).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	formatStatusMarkdown,
	getStatusData,
} from '../../../src/services/status-service';
import { writeRecoveryRecord } from '../../../src/turbo/lean/recovery';

let tempDir: string;
let swarmDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'status-recovery-')),
	);
	swarmDir = path.join(tempDir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('getStatusData — preserved recovery worktrees (#1657)', () => {
	test('surfaces recovery records when present', async () => {
		writeRecoveryRecord(tempDir, {
			laneId: 'lane-1',
			sessionId: 'sess-a',
			branchName: 'swarm-lane/sess-a/lane-1',
			worktreePath: path.join(tempDir, 'wt-lane-1'),
			status: 'conflict',
			reason: 'merge conflict on src/shared.ts',
			conflictFiles: ['src/shared.ts'],
			replayHint: `cd ${path.join(tempDir, 'wt-lane-1')} && git status`,
		});

		const status = await getStatusData(tempDir, {});

		expect(status.leanPreservedRecoveryWorktrees).toBeDefined();
		expect(status.leanPreservedRecoveryWorktrees).toHaveLength(1);
		expect(status.leanPreservedRecoveryWorktrees![0].laneId).toBe('lane-1');
		expect(status.leanPreservedRecoveryWorktrees![0].status).toBe('conflict');
		expect(status.leanPreservedRecoveryWorktrees![0].reason).toContain(
			'merge conflict',
		);
		expect(status.leanPreservedRecoveryWorktrees![0].replayHint).toContain(
			'git status',
		);
	});

	test('omits the field when no recovery records exist', async () => {
		// No recovery dir written.
		const status = await getStatusData(tempDir, {});
		expect(status.leanPreservedRecoveryWorktrees).toBeUndefined();
	});

	test('surfaces multiple records (one per preserved lane)', async () => {
		writeRecoveryRecord(tempDir, {
			laneId: 'lane-1',
			sessionId: 'sess-a',
			worktreePath: path.join(tempDir, 'wt-1'),
			status: 'conflict',
			reason: 'conflict 1',
			replayHint: 'cd wt-1 && git status',
		});
		writeRecoveryRecord(tempDir, {
			laneId: 'lane-2',
			sessionId: 'sess-a',
			worktreePath: path.join(tempDir, 'wt-2'),
			status: 'failed',
			reason: 'merge error 2',
			replayHint: 'cd wt-2 && git status',
		});

		const status = await getStatusData(tempDir, {});
		expect(status.leanPreservedRecoveryWorktrees).toHaveLength(2);
	});
});

describe('formatStatusMarkdown — preserved recovery worktrees rendering (#1657)', () => {
	test('renders a Preserved recovery worktrees block when records exist', () => {
		const md = formatStatusMarkdown({
			leanPreservedRecoveryWorktrees: [
				{
					laneId: 'lane-1',
					status: 'conflict',
					worktreePath: '/tmp/wt-1',
					reason: 'merge conflict on src/shared.ts',
					replayHint: 'cd /tmp/wt-1 && git status',
				},
			],
		} as never);
		expect(md).toContain('Preserved recovery worktrees');
		expect(md).toContain('1 lane(s) preserved');
		expect(md).toContain('lane-1');
		expect(md).toContain('conflict');
	});

	test('omits the block when no records', () => {
		const md = formatStatusMarkdown({} as never);
		expect(md).not.toContain('Preserved recovery worktrees');
	});
});
