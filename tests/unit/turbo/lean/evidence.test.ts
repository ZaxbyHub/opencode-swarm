/**
 * Tests for Lean Turbo Lane Evidence Module.
 *
 * Tests lane and phase evidence write/read/list operations using real temp
 * directories. No mock.module usage — all I/O is real.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type LaneEvidence,
	listLaneEvidence,
	type PhaseEvidence,
	readLaneEvidence,
	readPhaseEvidence,
	writeLaneEvidence,
	writePhaseEvidence,
} from '../../../../src/turbo/lean/evidence';

const PHASE = 1;

function makeTmpDir(): string {
	return fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lean-evidence-')),
	);
}

function cleanup(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

describe('LaneEvidence', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	test('writeLaneEvidence creates file in correct location', async () => {
		const evidence: LaneEvidence = {
			laneId: 'lane-1',
			taskIds: ['task-1', 'task-2'],
			files: ['src/a.ts', 'src/b.ts'],
			status: 'completed',
			startedAt: '2025-01-01T00:00:00.000Z',
			completedAt: '2025-01-01T00:01:00.000Z',
			agent: 'coder',
			sessionId: 'sess-123',
		};

		await writeLaneEvidence(tmpDir, PHASE, evidence);

		const filePath = path.join(
			tmpDir,
			'.swarm',
			'evidence',
			String(PHASE),
			'lean-turbo',
			'lane-1.json',
		);
		expect(fs.existsSync(filePath)).toBe(true);
	});

	test('readLaneEvidence round-trip', async () => {
		const evidence: LaneEvidence = {
			laneId: 'lane-roundtrip',
			taskIds: ['task-a', 'task-b'],
			files: ['src/x.ts'],
			status: 'running',
			startedAt: '2025-01-01T00:00:00.000Z',
			agent: 'mega_coder',
			sessionId: 'sess-456',
		};

		await writeLaneEvidence(tmpDir, PHASE, evidence);
		const result = await readLaneEvidence(tmpDir, PHASE, 'lane-roundtrip');

		expect(result).not.toBeNull();
		expect(result!.laneId).toBe('lane-roundtrip');
		expect(result!.taskIds).toEqual(['task-a', 'task-b']);
		expect(result!.files).toEqual(['src/x.ts']);
		expect(result!.status).toBe('running');
		expect(result!.startedAt).toBe('2025-01-01T00:00:00.000Z');
		expect(result!.agent).toBe('mega_coder');
		expect(result!.sessionId).toBe('sess-456');
	});

	test('readLaneEvidence returns null for missing file', async () => {
		const result = await readLaneEvidence(tmpDir, PHASE, 'nonexistent-lane');
		expect(result).toBeNull();
	});

	test('readLaneEvidence returns null for invalid JSON', async () => {
		// Manually create an invalid JSON file to test graceful handling
		const dir = path.join(
			tmpDir,
			'.swarm',
			'evidence',
			String(PHASE),
			'lean-turbo',
		);
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, 'bad-lane.json');
		fs.writeFileSync(filePath, '{ invalid json }');

		const result = await readLaneEvidence(tmpDir, PHASE, 'bad-lane');
		expect(result).toBeNull();
	});
});

describe('PhaseEvidence', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	test('writePhaseEvidence creates file in correct location', async () => {
		const evidence: PhaseEvidence = {
			phase: PHASE,
			planId: 'plan-abc',
			lanes: [],
			degradedTasks: [],
			startedAt: '2025-01-01T00:00:00.000Z',
			status: 'running',
		};

		await writePhaseEvidence(tmpDir, evidence);

		const filePath = path.join(
			tmpDir,
			'.swarm',
			'evidence',
			String(PHASE),
			'lean-turbo',
			'lean-turbo-phase.json',
		);
		expect(fs.existsSync(filePath)).toBe(true);
	});

	test('readPhaseEvidence round-trip', async () => {
		const evidence: PhaseEvidence = {
			phase: PHASE,
			planId: 'plan-xyz',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: [],
					status: 'completed',
				},
			],
			degradedTasks: [{ taskId: 'task-2', reason: 'no files' }],
			startedAt: '2025-01-01T00:00:00.000Z',
			completedAt: '2025-01-01T00:05:00.000Z',
			status: 'completed',
		};

		await writePhaseEvidence(tmpDir, evidence);
		const result = await readPhaseEvidence(tmpDir, PHASE);

		expect(result).not.toBeNull();
		expect(result!.phase).toBe(PHASE);
		expect(result!.planId).toBe('plan-xyz');
		expect(result!.lanes).toHaveLength(1);
		expect(result!.lanes[0].laneId).toBe('lane-1');
		expect(result!.degradedTasks).toHaveLength(1);
		expect(result!.degradedTasks[0].taskId).toBe('task-2');
		expect(result!.status).toBe('completed');
	});

	test('PhaseEvidence round-trip with all optional boundary fields', async () => {
		const evidence: PhaseEvidence = {
			phase: PHASE,
			planId: 'plan-boundary',
			lanes: [
				{
					laneId: 'lane-1',
					taskIds: ['task-1'],
					files: ['src/a.ts'],
					status: 'completed',
				},
				{
					laneId: 'lane-2',
					taskIds: ['task-2'],
					files: ['src/b.ts'],
					status: 'completed',
				},
			],
			degradedTasks: [],
			startedAt: '2025-01-01T00:00:00.000Z',
			completedAt: '2025-01-01T00:10:00.000Z',
			status: 'completed',
			evidencePaths: [
				'.swarm/evidence/1/lean-turbo/lane-1.json',
				'.swarm/evidence/1/lean-turbo/lane-2.json',
			],
			integratedDiffSummary: '+10 lines, -2 lines across 2 files',
			reviewerVerdict: 'APPROVED',
			criticVerdict: 'APPROVED',
			configSnapshot: {
				maxConcurrency: 4,
				conflictResolution: 'task-order',
				taskConflictThreshold: 0.3,
				requireExplicitScope: false,
				lean: { maxLanes: 4, taskTimeout: 300000 },
			},
			timestamp: '2025-01-01T00:10:01.000Z',
		};

		await writePhaseEvidence(tmpDir, evidence);
		const result = await readPhaseEvidence(tmpDir, PHASE);

		expect(result).not.toBeNull();
		expect(result!.phase).toBe(PHASE);
		expect(result!.planId).toBe('plan-boundary');
		expect(result!.lanes).toHaveLength(2);
		expect(result!.evidencePaths).toHaveLength(2);
		expect(result!.evidencePaths).toContain(
			'.swarm/evidence/1/lean-turbo/lane-1.json',
		);
		expect(result!.integratedDiffSummary).toBe(
			'+10 lines, -2 lines across 2 files',
		);
		expect(result!.reviewerVerdict).toBe('APPROVED');
		expect(result!.criticVerdict).toBe('APPROVED');
		expect(result!.configSnapshot).toEqual({
			maxConcurrency: 4,
			conflictResolution: 'task-order',
			taskConflictThreshold: 0.3,
			requireExplicitScope: false,
			lean: { maxLanes: 4, taskTimeout: 300000 },
		});
		expect(result!.timestamp).toBe('2025-01-01T00:10:01.000Z');
	});

	test('readPhaseEvidence returns null for missing file', async () => {
		const result = await readPhaseEvidence(tmpDir, PHASE);
		expect(result).toBeNull();
	});
});

describe('listLaneEvidence', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	test('listLaneEvidence returns all lane evidences', async () => {
		const lane1: LaneEvidence = {
			laneId: 'lane-alpha',
			taskIds: ['task-1'],
			files: ['a.ts'],
			status: 'completed',
		};
		const lane2: LaneEvidence = {
			laneId: 'lane-beta',
			taskIds: ['task-2'],
			files: ['b.ts'],
			status: 'running',
		};

		await writeLaneEvidence(tmpDir, PHASE, lane1);
		await writeLaneEvidence(tmpDir, PHASE, lane2);

		const result = await listLaneEvidence(tmpDir, PHASE);

		expect(result).toHaveLength(2);
		const laneIds = result.map((l) => l.laneId).sort();
		expect(laneIds).toEqual(['lane-alpha', 'lane-beta']);
	});

	test('listLaneEvidence skips invalid JSON files', async () => {
		const lane1: LaneEvidence = {
			laneId: 'lane-valid',
			taskIds: ['task-1'],
			files: [],
			status: 'pending',
		};
		await writeLaneEvidence(tmpDir, PHASE, lane1);

		// Create an invalid JSON file alongside valid ones
		const dir = path.join(
			tmpDir,
			'.swarm',
			'evidence',
			String(PHASE),
			'lean-turbo',
		);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'invalid.json'), '{ bad }');
		fs.writeFileSync(path.join(dir, 'lean-turbo-phase.json'), '{}');

		const result = await listLaneEvidence(tmpDir, PHASE);

		expect(result).toHaveLength(1);
		expect(result[0].laneId).toBe('lane-valid');
	});

	test('listLaneEvidence returns empty array for missing directory', async () => {
		const result = await listLaneEvidence(tmpDir, PHASE);
		expect(result).toEqual([]);
	});
});

describe('Path traversal security', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	const invalidLaneIds = [
		{ laneId: '../../outside', description: 'parent directory traversal' },
		{ laneId: 'lane/with/slash', description: 'forward slash' },
		{ laneId: 'lane\\with\\backslash', description: 'backslash' },
		{ laneId: '..', description: 'just parent directory' },
		{ laneId: '', description: 'empty string' },
		{ laneId: 'C:\\windows', description: 'windows absolute path' },
		{ laneId: '/absolute/path', description: 'unix absolute path' },
	];

	for (const { laneId, description } of invalidLaneIds) {
		test(`writeLaneEvidence rejects laneId: ${description}`, async () => {
			const evidence: LaneEvidence = {
				laneId,
				taskIds: ['task-1'],
				files: [],
				status: 'completed',
			};

			await expect(
				writeLaneEvidence(tmpDir, PHASE, evidence),
			).rejects.toThrow();
		});

		test(`readLaneEvidence rejects laneId: ${description}`, async () => {
			await expect(readLaneEvidence(tmpDir, PHASE, laneId)).rejects.toThrow();
		});

		test(`writeLaneEvidence does NOT create file outside expected directory for: ${description}`, async () => {
			const evidence: LaneEvidence = {
				laneId,
				taskIds: ['task-1'],
				files: [],
				status: 'completed',
			};

			try {
				await writeLaneEvidence(tmpDir, PHASE, evidence);
			} catch {
				// Expected to throw
			}

			// Verify no files exist outside the expected evidence directory
			const expectedDir = path.join(
				tmpDir,
				'.swarm',
				'evidence',
				String(PHASE),
				'lean-turbo',
			);

			// Check that the expected directory doesn't exist or has no files
			if (fs.existsSync(expectedDir)) {
				const files = fs.readdirSync(expectedDir);
				// Should not contain the malicious laneId as a file
				expect(
					files.some(
						(f) => f.includes('..') || f.includes('/') || f.includes('\\'),
					),
				).toBe(false);
			}
		});
	}

	test('valid laneIds work correctly', async () => {
		const validLaneIds = [
			'lane-1',
			'mega-lane-42',
			'lane_with_underscore',
			'a'.repeat(128),
		];

		for (const laneId of validLaneIds) {
			const evidence: LaneEvidence = {
				laneId,
				taskIds: ['task-1'],
				files: [],
				status: 'completed',
			};

			await writeLaneEvidence(tmpDir, PHASE, evidence);
			const result = await readLaneEvidence(tmpDir, PHASE, laneId);

			expect(result).not.toBeNull();
			expect(result!.laneId).toBe(laneId);
		}
	});

	test('rejects laneId exceeding 128 characters', async () => {
		const longLaneId = 'a'.repeat(129);
		const evidence: LaneEvidence = {
			laneId: longLaneId,
			taskIds: ['task-1'],
			files: [],
			status: 'completed',
		};

		await expect(writeLaneEvidence(tmpDir, PHASE, evidence)).rejects.toThrow(
			/exceeds maximum length/i,
		);
	});
});

describe('Atomic write', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	test('atomic write does not leave temp files on success', async () => {
		const evidence: LaneEvidence = {
			laneId: 'lane-atomic',
			taskIds: ['task-1'],
			files: [],
			status: 'completed',
		};

		await writeLaneEvidence(tmpDir, PHASE, evidence);

		const evidenceDir = path.join(
			tmpDir,
			'.swarm',
			'evidence',
			String(PHASE),
			'lean-turbo',
		);
		const files = fs.readdirSync(evidenceDir);
		const tempFiles = files.filter((f) => f.includes('.tmp.'));
		expect(tempFiles).toHaveLength(0);
	});
});
