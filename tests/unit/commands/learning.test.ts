import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	handleLearningCommand,
} from '../../../src/commands/learning';

const originalComputeLearningMetrics = _internals.computeLearningMetrics;

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), 'swarm-learning-cmd-'));
});

afterEach(() => {
	_internals.computeLearningMetrics = originalComputeLearningMetrics;
	rmSync(tmp, { recursive: true, force: true });
});

function seedSwarmDir(events: object[], entries: object[]) {
	const swarmDir = path.join(tmp, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	if (events.length > 0) {
		writeFileSync(
			path.join(swarmDir, 'knowledge-events.jsonl'),
			events.map((e) => JSON.stringify(e)).join('\n') + '\n',
			'utf-8',
		);
	}
	if (entries.length > 0) {
		writeFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
			'utf-8',
		);
	}
}

describe('handleLearningCommand', () => {
	it('returns markdown for empty .swarm/', async () => {
		const result = await handleLearningCommand(tmp, []);
		expect(result).toContain('Learning Summary');
		expect(result).toContain('No learning data yet');
	});

	it('returns markdown with data', async () => {
		seedSwarmDir(
			[
				{
					type: 'retrieved',
					event_id: 'evt-1',
					trace_id: 'tr-1',
					timestamp: '2026-06-10T12:00:00.000Z',
					session_id: 'sess-1',
					agent: 'architect',
					query: 'test',
					retrieval_mode: 'auto_injection',
					result_ids: ['e1'],
					ranks: { e1: 1 },
					scores: { e1: 0.9 },
				},
				{
					type: 'violated',
					event_id: 'evt-2',
					trace_id: 'tr-1',
					timestamp: '2026-06-10T12:00:00.000Z',
					session_id: 'sess-1',
					knowledge_id: 'e1',
					agent: 'coder',
					reason: 'did not follow',
				},
			],
			[
				{
					id: 'e1',
					tier: 'swarm',
					lesson: 'Always run tests',
					category: 'testing',
					tags: ['testing'],
					scope: 'global',
					confidence: 0.9,
					status: 'established',
					confirmed_by: [
						{
							phase_number: 1,
							confirmed_at: '2026-06-01T00:00:00.000Z',
							project_name: 'test',
						},
					],
					retrieval_outcomes: {
						applied_count: 0,
						succeeded_after_count: 0,
						failed_after_count: 0,
					},
					schema_version: 2,
					created_at: '2026-06-01T00:00:00.000Z',
					updated_at: '2026-06-05T00:00:00.000Z',
					project_name: 'test',
					directive_priority: 'critical',
				},
			],
		);

		const result = await handleLearningCommand(tmp, []);
		expect(result).toContain('Learning Summary');
		expect(result).toContain('Violation Trends');
		expect(result).toContain('Application Rates');
	});

	it('returns JSON when --json flag is set', async () => {
		const result = await handleLearningCommand(tmp, ['--json']);
		expect(result).toContain('[LEARNING_JSON]');
		expect(result).toContain('[/LEARNING_JSON]');
		const jsonStr = result
			.replace('[LEARNING_JSON]\n', '')
			.replace('\n[/LEARNING_JSON]', '');
		const parsed = JSON.parse(jsonStr);
		expect(parsed).toHaveProperty('violationTrends');
		expect(parsed).toHaveProperty('overallViolationRate');
		expect(parsed).toHaveProperty('learningSummary');
	});

	it('accepts --phase flag', async () => {
		const result = await handleLearningCommand(tmp, ['--phase', '5']);
		expect(result).toContain('Learning Summary');
	});

	it('ignores non-numeric --phase value', async () => {
		const result = await handleLearningCommand(tmp, ['--phase', 'abc']);
		expect(result).toContain('Learning Summary');
	});

	describe('error handling', () => {
		it('returns error message when computeLearningMetrics throws', async () => {
			_internals.computeLearningMetrics = async () => {
				throw new Error('disk failure');
			};
			const result = await handleLearningCommand(tmp, []);
			expect(result).toContain(
				'Error computing learning metrics: disk failure',
			);
			expect(result).toContain('Run /swarm diagnose');
		});

		it('handles non-Error throw values', async () => {
			_internals.computeLearningMetrics = async () => {
				throw 'unexpected string error';
			};
			const result = await handleLearningCommand(tmp, []);
			expect(result).toContain(
				'Error computing learning metrics: unexpected string error',
			);
		});
	});

	it('returns a structured markdown timeout when metric computation hangs', async () => {
		_internals.computeLearningMetrics = (_directory, options) =>
			new Promise((_, reject) => {
				options?.signal?.addEventListener('abort', () =>
					reject(new Error('aborted')),
				);
			});

		const result = await handleLearningCommand(tmp, ['--timeout-ms', '5']);

		expect(result).toContain('LEARNING_METRICS_TIMEOUT');
		expect(result).toContain('5ms');
	});

	it('returns a structured JSON timeout when metric computation hangs in JSON mode', async () => {
		_internals.computeLearningMetrics = (_directory, options) =>
			new Promise((_, reject) => {
				options?.signal?.addEventListener('abort', () =>
					reject(new Error('aborted')),
				);
			});

		const result = await handleLearningCommand(tmp, [
			'--json',
			'--timeout-ms',
			'5',
		]);

		const jsonStr = result
			.replace('[LEARNING_JSON]\n', '')
			.replace('\n[/LEARNING_JSON]', '');
		const parsed = JSON.parse(jsonStr);
		expect(parsed.ok).toBe(false);
		expect(parsed.error.code).toBe('LEARNING_METRICS_TIMEOUT');
		expect(parsed.error.timeout_ms).toBe(5);
	});

	it('uses the default timeout when --timeout-ms is invalid', async () => {
		let observedSignal: AbortSignal | undefined;
		_internals.computeLearningMetrics = async (_directory, options) => {
			observedSignal = options?.signal;
			return originalComputeLearningMetrics(_directory, options);
		};

		const result = await handleLearningCommand(tmp, ['--timeout-ms', 'nope']);

		expect(result).toContain('Learning Summary');
		expect(observedSignal).toBeDefined();
	});
});
