/**
 * Integration test: micro-reflector end-to-end (Change 6 / Task 5.1).
 *
 * A failing trajectory + transcript → exactly one quota-gated LLM call → 0-2 v3
 * candidates appended to .swarm/insight-candidates.jsonl. A successful outcome
 * makes NO LLM call and writes nothing. Quota exhaustion blocks the call.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	resolveInsightCandidatesPath,
	runMicroReflection,
} from '../../src/hooks/micro-reflector.js';
import type { TrajectoryEntry } from '../../src/hooks/trajectory-logger.js';
import { resolveQuotaPath } from '../../src/services/skill-improver-quota.js';

const VALID_CANDIDATES = JSON.stringify([
	{
		lesson: 'Re-run the specific failing test before declaring a fix complete',
		applies_to_agents: ['coder'],
		required_actions: ['run the failing test file before finishing'],
		directive_priority: 'high',
	},
]);

function failingTrajectory(): TrajectoryEntry[] {
	return [
		{
			step: 1,
			agent: 'coder',
			action: 'edit',
			target: 'src/x.ts',
			intent: '',
			timestamp: '2026-01-01T00:00:00.000Z',
			result: 'success',
			tool: 'edit',
			args_summary: '',
			verdict: '',
			elapsed_ms: 10,
		},
		{
			step: 2,
			agent: 'coder',
			action: 'run tests',
			target: '',
			intent: '',
			timestamp: '2026-01-01T00:00:01.000Z',
			result: 'failure',
			tool: 'test_runner',
			args_summary: '',
			verdict: '3 failed',
			elapsed_ms: 50,
		},
	];
}

function readCandidates(dir: string): Array<Record<string, unknown>> {
	const p = resolveInsightCandidatesPath(dir);
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, 'utf-8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

describe('runMicroReflection (e2e)', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-reflect-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('on a test failure: one LLM call, candidates written to the queue', async () => {
		let calls = 0;
		const result = await runMicroReflection({
			directory: dir,
			taskId: 't-1',
			agent: 'coder',
			transcript: 'The tests are failing after my edit.',
			trajectory: failingTrajectory(),
			llmDelegate: async () => {
				calls++;
				return VALID_CANDIDATES;
			},
		});
		expect(result.outcome).toBe('failure_test');
		expect(result.reflected).toBe(true);
		expect(result.candidates).toBe(1);
		expect(calls).toBe(1);

		const queued = readCandidates(dir);
		expect(queued).toHaveLength(1);
		expect(queued[0].lesson).toContain('failing test');
		expect((queued[0].source as { kind: string }).kind).toBe(
			'micro_reflection',
		);
		expect((queued[0].source as { outcome: string }).outcome).toBe(
			'failure_test',
		);
	});

	it('on success: NO LLM call, nothing written', async () => {
		let calls = 0;
		const result = await runMicroReflection({
			directory: dir,
			taskId: 't-2',
			agent: 'coder',
			transcript: 'All tests passed, task complete.',
			trajectory: [
				{
					step: 1,
					agent: 'coder',
					action: 'done',
					target: '',
					intent: '',
					timestamp: '2026-01-01T00:00:00.000Z',
					result: 'success',
					tool: 'bash',
					args_summary: '',
					verdict: '',
					elapsed_ms: 5,
				},
			],
			llmDelegate: async () => {
				calls++;
				return VALID_CANDIDATES;
			},
		});
		expect(result.outcome).toBe('success');
		expect(result.reflected).toBe(false);
		expect(calls).toBe(0);
		expect(readCandidates(dir)).toHaveLength(0);
	});

	it('classification-only when no LLM delegate is available', async () => {
		const result = await runMicroReflection({
			directory: dir,
			taskId: 't-3',
			agent: 'coder',
			transcript: 'Result: 2 failed',
			trajectory: failingTrajectory(),
			// no llmDelegate
		});
		expect(result.outcome).toBe('failure_test');
		expect(result.reflected).toBe(false);
		expect(result.candidates).toBe(0);
		expect(readCandidates(dir)).toHaveLength(0);
	});

	it('respects the quota: no LLM call when the budget is exhausted', async () => {
		fs.writeFileSync(
			resolveQuotaPath(dir, 'knowledge-enrichment'),
			JSON.stringify({
				date: new Date().toISOString().slice(0, 10),
				calls_used: 1,
				max_calls: 1,
				window: 'utc',
			}),
		);
		let calls = 0;
		const result = await runMicroReflection({
			directory: dir,
			taskId: 't-4',
			agent: 'coder',
			transcript: 'Result: 1 failed',
			trajectory: failingTrajectory(),
			llmDelegate: async () => {
				calls++;
				return VALID_CANDIDATES;
			},
			quota: { maxCalls: 1, window: 'utc' },
		});
		expect(calls).toBe(0);
		expect(result.reflected).toBe(false);
		expect(readCandidates(dir)).toHaveLength(0);
	});

	it('writes nothing when the model returns no generalizable lesson ([])', async () => {
		const result = await runMicroReflection({
			directory: dir,
			taskId: 't-5',
			agent: 'coder',
			transcript: 'Result: 1 failed',
			trajectory: failingTrajectory(),
			llmDelegate: async () => '[]',
		});
		expect(result.reflected).toBe(true);
		expect(result.candidates).toBe(0);
		expect(readCandidates(dir)).toHaveLength(0);
	});
});
