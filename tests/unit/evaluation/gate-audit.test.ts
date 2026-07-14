import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleGateAuditCommand } from '../../../src/commands/gate-audit.js';
import { _gateAuditInternals } from '../../../src/evaluation/gate-audit.js';

const originalFingerprint = _gateAuditInternals.captureWorkingTreeFingerprint;
const packageRoot = path.resolve(import.meta.dir, '../../..');

afterEach(() => {
	_gateAuditInternals.captureWorkingTreeFingerprint = originalFingerprint;
});

describe('Tier-1 gate audit', () => {
	test('executes the complete defect by gate matrix with real local adapters', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-matrix-')),
		);
		try {
			_gateAuditInternals.captureWorkingTreeFingerprint = async () => ({
				head: 'a'.repeat(40),
				porcelainHash: 'b'.repeat(64),
			});
			const raw = await handleGateAuditCommand(
				root,
				[
					'--run-id',
					'audit-complete-matrix',
					'--model',
					'fake-model',
					'--runs',
					'1',
					'--max-concurrency',
					'2',
					'--max-retries',
					'0',
					'--max-time-ms',
					'120000',
					'--json',
				],
				{
					packageRoot,
					dispatcher: async (request) => ({
						status: 'completed',
						modelId: request.modelId,
						text: '{"v":1,"caught":true,"reason":"fixture defect"}',
						durationMs: 1,
					}),
				},
			);
			const result = JSON.parse(raw);
			expect(result.status).toBe('complete');
			expect(result.cells).toHaveLength(120);
			expect(
				new Set(result.cells.map((cell: { taskId: string }) => cell.taskId))
					.size,
			).toBe(12);
			expect(
				new Set(result.cells.map((cell: { gate: string }) => cell.gate)).size,
			).toBe(5);
			expect(result.qualityMetricAvailability).toEqual({
				complexity_delta: 'unavailable',
				public_api_delta: 'unavailable',
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	test('runs the production mutation adapter in isolation and resumes by run id', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-run-')),
		);
		try {
			_gateAuditInternals.captureWorkingTreeFingerprint = async () => ({
				head: 'a'.repeat(40),
				porcelainHash: 'b'.repeat(64),
			});
			const args = [
				'--run-id',
				'audit-mutation-test',
				'--gates',
				'mutation',
				'--tasks',
				'mutation-off-by-one',
				'--runs',
				'1',
				'--max-concurrency',
				'1',
				'--max-retries',
				'0',
				'--max-time-ms',
				'60000',
				'--json',
			];
			const first = JSON.parse(
				await handleGateAuditCommand(root, args, { packageRoot }),
			);
			expect(first.status).toBe('complete');
			expect(first.cells).toHaveLength(2);
			expect(
				first.cells.find((cell: { candidateId: string }) =>
					cell.candidateId.startsWith('defect-'),
				)?.outcome,
			).toBe('caught');
			expect(
				first.cells.find((cell: { candidateId: string }) =>
					cell.candidateId.startsWith('clean-'),
				)?.outcome,
			).toBe('missed');
			const resumed = JSON.parse(
				await handleGateAuditCommand(root, args, { packageRoot }),
			);
			expect(resumed).toEqual(first);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects conflicting reuse of an immutable run id', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-conflict-')),
		);
		try {
			_gateAuditInternals.captureWorkingTreeFingerprint = async () => ({
				head: 'a'.repeat(40),
				porcelainHash: 'b'.repeat(64),
			});
			const base = [
				'--run-id',
				'audit-conflict',
				'--gates',
				'sast',
				'--tasks',
				'injection-prone-string',
				'--max-retries',
				'0',
				'--max-time-ms',
				'60000',
			];
			await handleGateAuditCommand(root, base, { packageRoot });
			await expect(
				handleGateAuditCommand(root, [...base, '--seed', 'different'], {
					packageRoot,
				}),
			).rejects.toThrow('different manifest');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('passes an immutable swarm preference and persists actual model identity', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-model-')),
		);
		try {
			_gateAuditInternals.captureWorkingTreeFingerprint = async () => ({
				head: 'a'.repeat(40),
				porcelainHash: 'b'.repeat(64),
			});
			const seenSwarms: Array<string | undefined> = [];
			const result = JSON.parse(
				await handleGateAuditCommand(
					root,
					[
						'--run-id',
						'audit-model-identity',
						'--gates',
						'reviewer',
						'--tasks',
						'mutation-off-by-one',
						'--model',
						'provider/requested',
						'--swarm',
						'mega',
						'--max-retries',
						'0',
						'--max-time-ms',
						'60000',
						'--json',
					],
					{
						packageRoot,
						dispatcher: async (request) => {
							seenSwarms.push(request.preferredSwarm);
							return {
								status: 'completed',
								modelId: 'provider/actual',
								agentName: 'mega_reviewer',
								text: '{"v":1,"caught":false,"reason":"control-aware"}',
								durationMs: 1,
							};
						},
					},
				),
			);
			expect(seenSwarms).toEqual(['mega', 'mega']);
			expect(
				result.cells.every(
					(cell: { model: string }) => cell.model === 'provider/actual',
				),
			).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
