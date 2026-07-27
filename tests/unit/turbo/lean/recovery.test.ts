import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecoveryRecord } from '../../../../src/turbo/lean/recovery.js';
import {
	clearRecoveryRecord,
	hasRecoveryRecordForBranch,
	listRecoveryRecords,
	recoveryReadErrored,
	writeRecoveryRecord,
} from '../../../../src/turbo/lean/recovery.js';
import {
	LeanTurboRunner,
	type MergeBackFailureInfo,
} from '../../../../src/turbo/lean/runner.js';

let tempDir: string;
let swarmDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
	swarmDir = path.join(tempDir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

function baseRecord(
	overrides: Partial<RecoveryRecord> = {},
): Omit<RecoveryRecord, 'recordedAt'> {
	return {
		laneId: 'lane-1',
		sessionId: 'sess-abc',
		branchName: 'swarm-lane/sess-abc/lane-1',
		worktreePath: path.join(tempDir, 'wt-lane-1'),
		status: 'conflict',
		reason: 'merge conflict on src/shared.ts',
		conflictFiles: ['src/shared.ts'],
		replayHint: `cd ${path.join(tempDir, 'wt-lane-1')} && git status`,
		...overrides,
	};
}

describe('writeRecoveryRecord', () => {
	test('writes a record atomically and reads it back', () => {
		writeRecoveryRecord(tempDir, baseRecord());

		const records = listRecoveryRecords(tempDir);
		expect(records).toHaveLength(1);
		expect(records[0].laneId).toBe('lane-1');
		expect(records[0].sessionId).toBe('sess-abc');
		expect(records[0].branchName).toBe('swarm-lane/sess-abc/lane-1');
		expect(records[0].status).toBe('conflict');
		expect(records[0].conflictFiles).toEqual(['src/shared.ts']);
		expect(typeof records[0].recordedAt).toBe('number');
		expect(Number.isFinite(records[0].recordedAt)).toBe(true);
	});

	test('overwrites (not accumulates) when same session+lane written twice', () => {
		writeRecoveryRecord(tempDir, baseRecord({ reason: 'first failure' }));
		writeRecoveryRecord(tempDir, baseRecord({ reason: 'second failure' }));

		const records = listRecoveryRecords(tempDir);
		expect(records).toHaveLength(1);
		expect(records[0].reason).toBe('second failure');
	});

	test('records for different sessions/lanes coexist', () => {
		writeRecoveryRecord(tempDir, baseRecord({ laneId: 'lane-1' }));
		writeRecoveryRecord(
			tempDir,
			baseRecord({ laneId: 'lane-2', sessionId: 'sess-xyz' }),
		);

		const records = listRecoveryRecords(tempDir);
		expect(records).toHaveLength(2);
	});

	test('never throws on write failure (best-effort, non-fatal)', () => {
		// Point directory at a path that cannot be created (file in the way).
		fs.writeFileSync(path.join(swarmDir, 'recovery'), 'blocker', 'utf-8');
		expect(() => writeRecoveryRecord(tempDir, baseRecord())).not.toThrow();
	});
});

describe('listRecoveryRecords — tolerance', () => {
	test('returns [] when recovery dir absent', () => {
		fs.rmSync(path.join(swarmDir), { recursive: true, force: true });
		expect(listRecoveryRecords(tempDir)).toEqual([]);
	});

	test('skips malformed record files (continues, returns valid ones)', () => {
		writeRecoveryRecord(tempDir, baseRecord({ laneId: 'good' }));
		// Write a malformed record alongside the good one.
		fs.writeFileSync(
			path.join(swarmDir, 'recovery', 'sess-bad-bad.json'),
			'not valid json {',
			'utf-8',
		);
		// And a record with valid JSON but missing required fields.
		fs.writeFileSync(
			path.join(swarmDir, 'recovery', 'sess-shape-shape.json'),
			JSON.stringify({ foo: 'bar' }),
			'utf-8',
		);
		// And a non-json file that should be ignored entirely.
		fs.writeFileSync(
			path.join(swarmDir, 'recovery', 'notes.txt'),
			'ignore me',
			'utf-8',
		);

		const records = listRecoveryRecords(tempDir);
		expect(records).toHaveLength(1);
		expect(records[0].laneId).toBe('good');
	});

	test('F-008: rejects parseable records missing required fields and fails safe', () => {
		const recoveryDir = path.join(swarmDir, 'recovery');
		fs.mkdirSync(recoveryDir, { recursive: true });
		fs.writeFileSync(
			path.join(recoveryDir, 'incomplete.json'),
			JSON.stringify({
				laneId: 'lane-incomplete',
				sessionId: 'sess-incomplete',
				worktreePath: path.join(tempDir, 'worktree'),
				status: 'failed',
			}),
			'utf-8',
		);

		expect(listRecoveryRecords(tempDir)).toEqual([]);
		expect(recoveryReadErrored(tempDir)).toBe(true);
	});

	test.each([
		['non-string branchName', { branchName: 42 }],
		['non-string conflictFiles member', { conflictFiles: ['valid.ts', 42] }],
	])('F-008: rejects %s', (_label, invalidFields) => {
		const recoveryDir = path.join(swarmDir, 'recovery');
		fs.mkdirSync(recoveryDir, { recursive: true });
		fs.writeFileSync(
			path.join(recoveryDir, 'invalid-optional.json'),
			JSON.stringify({
				...baseRecord(),
				recordedAt: 1,
				...invalidFields,
			}),
			'utf-8',
		);

		expect(listRecoveryRecords(tempDir)).toEqual([]);
		expect(recoveryReadErrored(tempDir)).toBe(true);
	});

	test('F-008: rejects a non-finite timestamp', () => {
		const recoveryDir = path.join(swarmDir, 'recovery');
		fs.mkdirSync(recoveryDir, { recursive: true });
		const serialized = JSON.stringify({
			...baseRecord(),
			recordedAt: 0,
		}).replace('"recordedAt":0', '"recordedAt":1e400');
		fs.writeFileSync(
			path.join(recoveryDir, 'non-finite.json'),
			serialized,
			'utf-8',
		);

		expect(listRecoveryRecords(tempDir)).toEqual([]);
		expect(recoveryReadErrored(tempDir)).toBe(true);
	});
});

describe('hasRecoveryRecordForBranch', () => {
	test('true when a record references the branch', () => {
		writeRecoveryRecord(tempDir, baseRecord());
		expect(
			hasRecoveryRecordForBranch(tempDir, 'swarm-lane/sess-abc/lane-1'),
		).toBe(true);
	});

	test('false when no record references the branch', () => {
		writeRecoveryRecord(tempDir, baseRecord());
		expect(
			hasRecoveryRecordForBranch(tempDir, 'swarm-lane/sess-abc/lane-9'),
		).toBe(false);
	});

	test('false when recovery dir absent', () => {
		fs.rmSync(path.join(swarmDir), { recursive: true, force: true });
		expect(hasRecoveryRecordForBranch(tempDir, 'any')).toBe(false);
	});
});

describe('clearRecoveryRecord', () => {
	test('removes the record for the given session+lane', () => {
		writeRecoveryRecord(tempDir, baseRecord({ laneId: 'lane-1' }));
		writeRecoveryRecord(
			tempDir,
			baseRecord({ laneId: 'lane-2', sessionId: 'sess-xyz' }),
		);

		clearRecoveryRecord(tempDir, 'lane-1', 'sess-abc');

		const records = listRecoveryRecords(tempDir);
		expect(records).toHaveLength(1);
		expect(records[0].laneId).toBe('lane-2');
	});

	test('no-op when record absent (never throws)', () => {
		expect(() =>
			clearRecoveryRecord(tempDir, 'nonexistent', 'sess-none'),
		).not.toThrow();
	});
});

describe('recoveryReadErrored', () => {
	test('false when recovery dir absent (no error — just empty)', () => {
		fs.rmSync(path.join(swarmDir), { recursive: true, force: true });
		expect(recoveryReadErrored(tempDir)).toBe(false);
	});

	test('false when dir present and all records parse', () => {
		writeRecoveryRecord(tempDir, baseRecord());
		expect(recoveryReadErrored(tempDir)).toBe(false);
	});

	test('true when a record file is unreadable/corrupt', () => {
		writeRecoveryRecord(tempDir, baseRecord());
		fs.writeFileSync(
			path.join(swarmDir, 'recovery', 'corrupt.json'),
			'not valid json {',
			'utf-8',
		);
		expect(recoveryReadErrored(tempDir)).toBe(true);
	});
});

describe('auto-clear contract (used by runner on successful merge-back)', () => {
	test('a record exists only until clearRecoveryRecord is called for its lane', () => {
		// Simulate the runner lifecycle: failure → record; recovery → clear.
		writeRecoveryRecord(tempDir, baseRecord({ laneId: 'lane-1' }));
		expect(listRecoveryRecords(tempDir)).toHaveLength(1);

		clearRecoveryRecord(tempDir, 'lane-1', 'sess-abc');
		expect(listRecoveryRecords(tempDir)).toEqual([]);
	});
});

describe('runner recovery guidance', () => {
	test('F-006: paths with spaces stay structured instead of becoming shell commands', () => {
		const runner = new LeanTurboRunner({
			directory: tempDir,
			sessionID: 'sess-spaced-path',
		});
		const worktreePath = path.join(tempDir, 'preserved lane with spaces');
		const failure: MergeBackFailureInfo = {
			laneId: 'lane-spaced',
			branchName: 'swarm-lane/sess-spaced-path/lane-spaced',
			worktreePath,
			status: 'conflict',
			reason: 'merge conflict',
		};

		(
			runner as unknown as {
				_persistRecovery(info: MergeBackFailureInfo): void;
			}
		)._persistRecovery(failure);

		const [record] = listRecoveryRecords(tempDir);
		expect(record.worktreePath).toBe(worktreePath);
		expect(record.replayHint).toContain('worktreePath');
		expect(record.replayHint).not.toContain(worktreePath);
		expect(record.replayHint).not.toContain('cd ');
		expect(record.replayHint).not.toContain('&&');
	});
});
