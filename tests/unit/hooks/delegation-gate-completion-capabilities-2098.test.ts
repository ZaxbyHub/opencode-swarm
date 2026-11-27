import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canRunWhileTaskAwaitsCompletion } from '../../../src/hooks/delegation-gate';
import { executeDeclareScope } from '../../../src/tools/declare-scope';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

describe('issue #2098 completion recovery capabilities', () => {
	let directory: string;

	beforeEach(async () => {
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
		// #2532: declare through the REGISTERED v2 authority — the verdict
		// resolves the binding store and ignores the legacy v1 projection.
		for (const [taskId, files] of [
			['1.1', ['src/a.ts']],
			['1.2', ['src/b.ts']],
			['1.3', ['src/a.ts']],
		] as const) {
			const declared = await executeDeclareScope(
				{ taskId, files: [...files], working_directory: directory },
				directory,
				{ sessionID: 'cap-2098-architect', messageID: `m-${taskId}` },
			);
			expect(declared.success).toBe(true);
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

describe('issue #2098 completion recovery — Code Mode wrapper pass-through', () => {
	// Regression (live session, 2026-11-22, Wirtschaftssimulation): the
	// completion gate judged the outer Code Mode `execute` wrapper as an
	// opaque non-read-only tool, so once a task reached tests_run it denied
	// every plugin call — including the update_task_status remedy its own
	// violation message prescribes — and the task could never leave the
	// gate. Fixed upstream (a31927667, "let the Code Mode execute wrapper
	// through the completion gate"): the adapter-marked wrapper is admitted,
	// while nested tools.<name>() calls re-enter tool.execute.before under
	// their own names and stay gated. These tests pin that contract.
	const decideCodeMode = (code: unknown, hostMarked: boolean) =>
		canRunWhileTaskAwaitsCompletion({
			directory: undefined,
			normalizedTool: 'execute',
			args: { code },
			awaitingTaskId: '1.1',
			requestedTaskId: null,
			codeModeWrapper: hostMarked,
		});

	const LITERAL_COMPLETION_CALL =
		'return await tools.update_task_status({ task_id: "1.1", status: "completed", working_directory: "/workspace/project" })';

	test('regression: adapter-marked literal recovery call passes the outer gate', () => {
		expect(decideCodeMode(LITERAL_COMPLETION_CALL, true)).toBe(true);
	});

	test('marked save_plan reconciliation wrapper passes the outer gate', () => {
		expect(
			decideCodeMode(
				'return await tools.save_plan({ reconcile_ledger_projection: true, working_directory: "/workspace/project" })',
				true,
			),
		).toBe(true);
	});

	test('marked multi-call program also passes: nested calls re-enter the gate individually', () => {
		// The wrapper only carries a program; the nested tool calls are
		// dispatched under their own names and judged there. The outer
		// wrapper itself grants nothing.
		const multiCall =
			'const res = await tools.todo_extract({ paths: ["pyproject.toml"] });\nreturn JSON.stringify(res);';
		expect(decideCodeMode(multiCall, true)).toBe(true);
	});

	test('unmarked execute never passes, even for the literal recovery form', () => {
		expect(decideCodeMode(LITERAL_COMPLETION_CALL, false)).toBe(false);
	});

	test('marked wrapper with a non-string program stays denied', () => {
		expect(decideCodeMode({ script: 'not-a-string' }, true)).toBe(false);
	});

	test('the mark does not bypass the gate for non-execute tools', () => {
		expect(
			canRunWhileTaskAwaitsCompletion({
				directory: undefined,
				normalizedTool: 'write',
				args: { path: '/etc/evil', content: 'x' },
				awaitingTaskId: '1.1',
				requestedTaskId: null,
				codeModeWrapper: true,
			}),
		).toBe(false);
	});
});
