import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleGateAuditCommand } from '../../../src/commands/gate-audit.js';
import { _gateAuditInternals } from '../../../src/evaluation/gate-audit.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalFingerprint = _gateAuditInternals.captureWorkingTreeFingerprint;
const originalResolveBase = _gateAuditInternals.resolveQualityMergeBase;
const packageRoot = path.resolve(import.meta.dir, '../../..');

afterEach(() => {
	_gateAuditInternals.captureWorkingTreeFingerprint = originalFingerprint;
	_gateAuditInternals.resolveQualityMergeBase = originalResolveBase;
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
			// Availability is derived from merge-base resolution state; the
			// temp root is not a repo, so pin the resolved branch explicitly.
			_gateAuditInternals.resolveQualityMergeBase = async () => 'c'.repeat(40);
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
				complexity_delta: 'available',
				public_api_delta: 'available',
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	test('qualityMetricAvailability reports unavailable when no merge base resolves', async () => {
		const root = canonicalMkdtemp('gate-audit-nobase-');
		try {
			_gateAuditInternals.captureWorkingTreeFingerprint = async () => ({
				head: 'a'.repeat(40),
				porcelainHash: 'b'.repeat(64),
			});
			// Degraded mode: no merge base resolves in the audited project, so
			// quality metrics collapse to head-only absolute values — the
			// availability flag must disclose that instead of asserting
			// 'available'.
			_gateAuditInternals.resolveQualityMergeBase = async () => null;
			const raw = await handleGateAuditCommand(
				root,
				[
					'--run-id',
					'audit-quality-unavailable',
					'--gates',
					'quality',
					'--runs',
					'1',
					'--max-concurrency',
					'1',
					'--max-retries',
					'0',
					'--max-time-ms',
					'60000',
					'--json',
				],
				{ packageRoot },
			);
			const result = JSON.parse(raw);
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

	test('#2009: binds the model-gate session to the project root, not the isolated fixture directory', async () => {
		// OpenCode keys permission state per directory. The evaluation model
		// gate must create its session in the project root (the invoking
		// instance's directory) so it lands in the SAME permission universe.
		// The fixture location is conveyed via the prompt as an absolute path.
		const root = canonicalMkdtemp('gate-audit-sessiondir-');
		try {
			_gateAuditInternals.captureWorkingTreeFingerprint = async () => ({
				head: 'a'.repeat(40),
				porcelainHash: 'b'.repeat(64),
			});
			const seenSessionDirs: string[] = [];
			const seenPrompts: string[] = [];
			await handleGateAuditCommand(
				root,
				[
					'--run-id',
					'audit-sessiondir-2009',
					'--gates',
					'reviewer',
					'--tasks',
					'curated-off-by-one',
					'--model',
					'provider/requested',
					'--runs',
					'1',
					'--max-retries',
					'0',
					'--max-time-ms',
					'60000',
					'--json',
				],
				{
					packageRoot,
					dispatcher: async (request) => {
						seenSessionDirs.push(request.sessionDirectory);
						seenPrompts.push(request.prompt);
						return {
							status: 'completed',
							modelId: 'provider/requested',
							text: '{"v":1,"caught":true,"reason":"ok"}',
							durationMs: 1,
						};
					},
				},
			);
			// Every model-gate dispatch used the project root as the session
			// directory (same permission partition as the invoking instance),
			// NOT the isolated temp fixture directory.
			for (const dir of seenSessionDirs) {
				expect(dir).toBe(root);
			}
			expect(seenSessionDirs.length).toBeGreaterThan(0);
			// The prompt directs the agent to the fixture directory absolutely,
			// and that fixture path is NOT the project root.
			for (const prompt of seenPrompts) {
				expect(prompt).toContain('Inspect ONLY the files under:');
				const match = prompt.match(/Inspect ONLY the files under: (.+)/);
				expect(match).not.toBeNull();
				expect(match![1]).not.toBe(root);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
