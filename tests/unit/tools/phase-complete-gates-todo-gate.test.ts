/**
 * Unit tests for the phase-complete todo_gate gate (issue #2581).
 *
 * Drives runTodoGateGate directly against real temp projects (real plan.json
 * + real flat evidence files + the real readTaskEvidence reader):
 * - no todo_scan evidence anywhere → pass with zero warnings
 *   (a gate cannot block without an available producer)
 * - below/at threshold → pass
 * - above + advisory → pass with a todo_gate warning
 * - above + blocking → blocked with exact file:line evidence and recovery
 * - enabled false → plain pass
 * - plan missing / phase absent / corrupt evidence → pass (skip, never block)
 * - multi-task phase where only ONE task exceeds → blocked (ANY predicate)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runTodoGateGate } from '../../../src/tools/phase-complete/gates/todo-gate';
import type { GateContext } from '../../../src/tools/phase-complete/gates/types';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NOW = '2026-09-19T00:00:00.000Z';

interface TodoGateBlock {
	enabled?: boolean;
	max_high_priority?: number;
	block_on_threshold?: boolean;
}

function makeCtx(
	dir: string,
	todoGate: TodoGateBlock | undefined,
	phase = 1,
): GateContext {
	return {
		phase,
		dir,
		sessionID: 'sess-test',
		pluginConfig: {
			todo_gate: todoGate,
		} as GateContext['pluginConfig'],
		agentsDispatched: ['coder'],
		safeWarn: () => {},
		preflightNowMs: 0,
	};
}

function writePlan(dir: string, taskIds: string[], phase = 1): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'todo gate test plan',
			swarm: 'local',
			current_phase: phase,
			migration_status: 'migrated',
			phases: [
				{
					id: phase,
					name: 'p1',
					status: 'completed',
					tasks: taskIds.map((id) => ({
						id,
						phase,
						description: `task ${id}`,
						status: 'completed',
					})),
				},
			],
		}),
	);
}

function writeEvidence(
	dir: string,
	taskId: string,
	todoScan: { count: number; details?: string[] } | null,
): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence');
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, `${taskId}.json`),
		JSON.stringify({
			taskId,
			required_gates: ['pre_check'],
			gates: {
				pre_check: { sessionId: 's', timestamp: NOW, agent: 'pre_check' },
			},
			...(todoScan
				? {
						todo_scan: {
							priority: 'high',
							count: todoScan.count,
							details: todoScan.details ?? [],
							recorded_at: NOW,
						},
					}
				: {}),
			workflow: {
				schema: 'exact-task-v1',
				generation: 0,
				state: 'tests_run',
				retryCount: 0,
				retryHistory: [],
				retryEpoch: 0,
				lastOutcome: 'none',
				lastTransitionId: null,
				updatedAt: NOW,
			},
		}),
	);
}

describe('runTodoGateGate', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('todo-gate-phase-');
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('passes with zero warnings when no task carries todo_scan evidence', async () => {
		writePlan(dir, ['1.1']);
		writeEvidence(dir, '1.1', null);
		const result = await runTodoGateGate(
			makeCtx(dir, { max_high_priority: 0, block_on_threshold: true }),
		);
		expect(result.blocked).toBe(false);
		expect(result.warnings).toEqual([]);
	});

	it('passes below and at the threshold', async () => {
		writePlan(dir, ['1.1']);
		writeEvidence(dir, '1.1', { count: 1 });
		expect(
			(await runTodoGateGate(makeCtx(dir, { max_high_priority: 2 }))).blocked,
		).toBe(false);
		writeEvidence(dir, '1.1', { count: 2 });
		const at = await runTodoGateGate(makeCtx(dir, { max_high_priority: 2 }));
		expect(at.blocked).toBe(false);
		expect(at.warnings).toEqual([]);
	});

	it('advisory mode warns but never blocks', async () => {
		writePlan(dir, ['1.1']);
		writeEvidence(dir, '1.1', {
			count: 3,
			details: ['src/x.ts:9 FIXME alpha'],
		});
		const result = await runTodoGateGate(
			makeCtx(dir, { max_high_priority: 0 }),
		);
		expect(result.blocked).toBe(false);
		expect(result.warnings.length).toBe(1);
		expect(result.warnings[0]).toContain('todo_gate');
		expect(result.warnings[0]).toContain('3');
	});

	it('blocking mode blocks with exact evidence and a recovery step', async () => {
		writePlan(dir, ['1.1']);
		writeEvidence(dir, '1.1', {
			count: 2,
			details: ['src/x.ts:12 FIXME alpha', 'src/y.ts:4 HACK beta'],
		});
		const result = await runTodoGateGate(
			makeCtx(dir, { max_high_priority: 0, block_on_threshold: true }),
		);
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe('TODO_GATE_THRESHOLD_EXCEEDED');
		expect(result.message).toContain('src/x.ts:12 FIXME alpha');
		expect(result.message).toContain('src/y.ts:4 HACK beta');
		const recovery = result.recovery as
			| { kind: string; action: string; args: { task_id: string } }
			| undefined;
		expect(recovery?.kind).toBe('tool');
		expect(recovery?.action).toBe('todo_extract');
		expect(recovery?.args.task_id).toBe('1.1');
		const guidance = String(result.recoveryGuidance ?? '');
		expect(guidance).toMatch(/resolve or remove/i);
		expect(guidance).toMatch(/max_high_priority|todo_gate/);
	});

	it('enabled false short-circuits to a plain pass', async () => {
		writePlan(dir, ['1.1']);
		writeEvidence(dir, '1.1', { count: 9 });
		const result = await runTodoGateGate(
			makeCtx(dir, {
				enabled: false,
				max_high_priority: 0,
				block_on_threshold: true,
			}),
		);
		expect(result.blocked).toBe(false);
		expect(result.warnings).toEqual([]);
	});

	it('negative max disables the threshold check', async () => {
		writePlan(dir, ['1.1']);
		writeEvidence(dir, '1.1', { count: 50 });
		const result = await runTodoGateGate(
			makeCtx(dir, { max_high_priority: -1, block_on_threshold: true }),
		);
		expect(result.blocked).toBe(false);
		expect(result.warnings).toEqual([]);
	});

	it('missing plan or absent phase passes without blocking', async () => {
		const noPlan = await runTodoGateGate(
			makeCtx(dir, { max_high_priority: 0, block_on_threshold: true }),
		);
		expect(noPlan.blocked).toBe(false);
		writePlan(dir, ['1.1'], 1);
		writeEvidence(dir, '1.1', { count: 5 });
		const wrongPhase = await runTodoGateGate(
			makeCtx(dir, { max_high_priority: 0, block_on_threshold: true }, 7),
		);
		expect(wrongPhase.blocked).toBe(false);
	});

	it('skips a task whose evidence file is corrupt', async () => {
		writePlan(dir, ['1.1', '1.2']);
		writeEvidence(dir, '1.1', { count: 1 });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'evidence', '1.2.json'),
			'{not json',
		);
		const result = await runTodoGateGate(
			makeCtx(dir, { max_high_priority: 2, block_on_threshold: true }),
		);
		expect(result.blocked).toBe(false);
	});

	it('blocks when only one task of several exceeds (ANY predicate)', async () => {
		writePlan(dir, ['1.1', '1.2', '1.3']);
		writeEvidence(dir, '1.1', { count: 0 });
		writeEvidence(dir, '1.2', {
			count: 4,
			details: ['src/z.ts:3 XXX gamma'],
		});
		writeEvidence(dir, '1.3', null);
		const result = await runTodoGateGate(
			makeCtx(dir, { max_high_priority: 0, block_on_threshold: true }),
		);
		expect(result.blocked).toBe(true);
		expect(result.message).toContain('src/z.ts:3 XXX gamma');
		expect(result.message).toContain('1.2');
	});
});
