import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canRunWhileTaskAwaitsCompletion } from '../../../src/hooks/delegation-gate';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

describe('issue #2098 completion recovery capabilities', () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.realpathSync(
			fs.mkdtempSync(
				path.join(canonicalTmpDir(), 'completion-capabilities-2098-'),
			),
		);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Capability plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'A',
								depends: [],
								files_touched: ['src/a.ts'],
							},
							{
								id: '1.2',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'B',
								depends: [],
								files_touched: ['src/b.ts'],
							},
							{
								id: '1.3',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'A conflict',
								depends: [],
								files_touched: ['src/a.ts'],
							},
						],
					},
				],
			}),
		);
		const scopes = path.join(directory, '.swarm', 'scopes');
		fs.mkdirSync(scopes, { recursive: true });
		for (const [taskId, files] of [
			['1.1', ['src/a.ts']],
			['1.2', ['src/b.ts']],
			['1.3', ['src/a.ts']],
		] as const) {
			fs.writeFileSync(
				path.join(scopes, `scope-${taskId}.json`),
				JSON.stringify({
					version: 1,
					taskId,
					files,
					declaredAt: 1,
					expiresAt: Number.MAX_SAFE_INTEGER,
				}),
			);
		}
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	const decide = (
		tool: string,
		args: Record<string, unknown> = {},
		requestedTaskId: string | null = null,
	) =>
		canRunWhileTaskAwaitsCompletion({
			directory,
			normalizedTool: tool,
			args,
			awaitingTaskId: '1.1',
			requestedTaskId,
		});

	test('keeps exact advertised recovery operations reachable', () => {
		expect(decide('read')).toBe(true);
		expect(decide('check_gate_status')).toBe(true);
		expect(decide('update_task_status', { task_id: '1.1' }, '1.1')).toBe(true);
		expect(decide('save_plan', { reconcile_ledger_projection: true })).toBe(
			true,
		);
	});

	test('allows mutable recovery tools only when their blocker is present', () => {
		expect(decide('approve_plan_critic')).toBe(false);
		expect(decide('spec_write')).toBe(false);
		fs.writeFileSync(
			path.join(directory, '.swarm', 'spec-staleness.json'),
			JSON.stringify({ marker: 'blocking drift' }),
		);
		expect(decide('spec_write')).toBe(true);
	});

	test('does not turn save_plan into a broad completion bypass', () => {
		expect(decide('save_plan', {})).toBe(false);
		expect(decide('phase_complete', {})).toBe(false);
		expect(decide('Task', { task_id: '1.1' }, '1.1')).toBe(false);
	});

	test('allows proven-disjoint task B but blocks overlapping work', () => {
		expect(decide('Task', { task_id: '1.2' }, '1.2')).toBe(true);
		expect(decide('Task', { task_id: '1.3' }, '1.3')).toBe(false);
	});
});
