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
	microReflectorAfter,
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

	it('resolves a plan-aware TASK marker before reading the trajectory', async () => {
		const plan = {
			schema_version: '1.0.0',
			title: 'Micro-reflector task resolution',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.2',
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'Resolve task IDs consistently',
							depends: [],
							files_touched: ['src/hooks/micro-reflector.ts'],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		const evidenceDir = path.join(dir, '.swarm', 'evidence', '1.2');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'trajectory.jsonl'),
			`${failingTrajectory()
				.map((entry) => JSON.stringify(entry))
				.join('\n')}\n`,
		);

		await microReflectorAfter(
			dir,
			{
				tool: 'Task',
				args: {
					subagent_type: 'coder',
					prompt: 'TASK: 1.2\nReturn the completed implementation.',
				},
			},
			{ output: 'The tests are failing after my edit.' },
			async () => VALID_CANDIDATES,
		);

		const queued = readCandidates(dir);
		expect(queued).toHaveLength(1);
		const source = queued[0].source as {
			task_id?: string;
			trajectory_steps: number;
		};
		expect(source.task_id).toBe('1.2');
		expect(source.trajectory_steps).toBe(2);
	});

	it('keeps parallel Task calls bound to their own plan trajectories', async () => {
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Parallel micro-reflection',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: ['1.1', '1.2'].map((id) => ({
							id,
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: `Task ${id}`,
							depends: [],
							files_touched: [`src/${id}.ts`],
						})),
					},
				],
			}),
		);
		for (const taskId of ['1.1', '1.2']) {
			const evidenceDir = path.join(dir, '.swarm', 'evidence', taskId);
			fs.mkdirSync(evidenceDir, { recursive: true });
			const trajectory = failingTrajectory().map((entry) => ({
				...entry,
				target: `src/${taskId}.ts`,
			}));
			fs.writeFileSync(
				path.join(evidenceDir, 'trajectory.jsonl'),
				`${trajectory.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
			);
		}

		await Promise.all(
			['1.1', '1.2'].map((taskId) =>
				microReflectorAfter(
					dir,
					{
						tool: 'Task',
						sessionID: `session-${taskId}`,
						args: {
							subagent_type: 'coder',
							prompt: `TASK: ${taskId}\nReturn only this task`,
						},
					},
					{ output: `Tests failed for ${taskId}` },
					async (prompt) =>
						JSON.stringify([
							{
								lesson: prompt.includes('src/1.1.ts')
									? 'Verify the first isolated task before returning'
									: 'Verify the second isolated task before returning',
								applies_to_agents: ['coder'],
								required_actions: ['run the focused task test'],
							},
						]),
				),
			),
		);

		const taskIds = readCandidates(dir)
			.map(
				(candidate) =>
					(candidate.source as { task_id?: string } | undefined)?.task_id,
			)
			.filter((taskId): taskId is string => typeof taskId === 'string')
			.sort();
		expect(taskIds).toEqual(['1.1', '1.2']);
	});

	it('falls back to named generic attribution when plan.json is corrupt', async () => {
		fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), '{broken');
		const evidenceDir = path.join(dir, '.swarm', 'evidence', '2.3');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'trajectory.jsonl'),
			`${failingTrajectory()
				.map((entry) => JSON.stringify(entry))
				.join('\n')}\n`,
		);
		await microReflectorAfter(
			dir,
			{
				tool: 'Task',
				args: {
					subagent_type: 'coder',
					prompt: 'task_id: 2.3\nReturn the completed implementation',
				},
			},
			{ output: 'The focused test is failing.' },
			async () => VALID_CANDIDATES,
		);
		expect(
			(readCandidates(dir)[0].source as { task_id?: string }).task_id,
		).toBe('2.3');
	});
});
