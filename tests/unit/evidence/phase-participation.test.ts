import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import {
	completeBackgroundPhaseParticipation,
	observePhaseParticipationToolResult,
	PHASE_PARTICIPATION_FILE,
	PHASE_PARTICIPATION_QUARANTINE_DIR,
	readPhaseParticipation,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function plan(taskStatus: 'pending' | 'completed' = 'pending'): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Participation Plan',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				required_agents: ['docs'],
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: taskStatus,
						size: 'small',
						description: 'Document behavior',
						depends: [],
						files_touched: ['docs/configuration.md'],
					},
				],
			},
		],
	};
}
function foregroundOutput(parent = 'parent', child = 'child'): object {
	return {
		output: 'Documentation updated and verified.',
		metadata: {
			status: 'completed',
			parentSessionId: parent,
			sessionId: child,
		},
	};
}
function runningOutput(child: string): object {
	return {
		output: `<task id="${child}" state="running"><summary>running</summary></task>`,
		metadata: { background: true, status: 'running', jobId: `job-${child}` },
	};
}
function backgroundRecord(input: {
	directory: string;
	child: string;
	taskId: string | null;
	ingestionConsumed?: boolean;
}): BackgroundDelegationRecord {
	const now = Date.now();
	return {
		schemaVersion: 3,
		correlationId: input.child,
		jobId: `job-${input.child}`,
		subagentSessionId: input.child,
		parentSessionId: 'parent',
		callID: 'call',
		normalizedAgent: 'docs',
		swarmPrefixedAgent: 'docs',
		planTaskId: input.taskId,
		evidenceTaskId: input.taskId,
		status: 'completed',
		createdAt: now,
		updatedAt: now,
		workspace: captureWorkspaceSnapshot(input.directory),
		...(input.ingestionConsumed
			? {
					ingestion: {
						state: 'consumed' as const,
						attempt: 1,
						claimToken: 'claim',
						claimedAt: now,
						updatedAt: now,
					},
				}
			: {}),
	};
}

describe('durable phase participation', () => {
	let directory: string;
	let cleanup: () => void;
	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('phase-participation-'));
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan(), null, 2),
		);
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetPhaseParticipationForTests();
		cleanup();
	});

	test('persists only an exact successful non-empty foreground docs completion', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs', prompt: 'TASK: 1.1\nUpdate docs' },
			policy: { require_docs: true },
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output: foregroundOutput(),
		});

		expect(readPhaseParticipation(directory, plan(), 1, 'docs')).toEqual({
			status: 'valid',
			found: true,
		});
	});

	test('rejects mismatched metadata and consumes the reservation', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'task',
			parentSessionId: 'parent',
			callId: 'call',
			output: foregroundOutput('other-parent'),
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'task',
			parentSessionId: 'parent',
			callId: 'call',
			output: foregroundOutput(),
		});

		expect(readPhaseParticipation(directory, plan(), 1, 'docs').found).toBe(
			false,
		);
	});

	test('fails closed for empty, failed, cancelled, and uncorrelated running results', async () => {
		const outputs = [
			{ output: '', metadata: { status: 'completed' } },
			{ output: 'failed', metadata: { status: 'failed' } },
			{ output: 'cancelled', metadata: { status: 'cancelled' } },
			{
				output: 'still running',
				metadata: { status: 'running', jobId: 'untrusted-without-envelope' },
			},
		];
		for (const [index, output] of outputs.entries()) {
			const callId = `failure-${index}`;
			await reserveApprovedPhaseParticipation({
				directory,
				tool: 'Task',
				parentSessionId: 'parent',
				callId,
				args: { subagent_type: 'docs' },
				policy: {},
			});
			await observePhaseParticipationToolResult({
				directory,
				tool: 'Task',
				parentSessionId: 'parent',
				callId,
				output,
			});
		}
		expect(readPhaseParticipation(directory, plan(), 1, 'docs').found).toBe(
			false,
		);
		const store = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', ...PHASE_PARTICIPATION_FILE.split('/')),
				'utf8',
			),
		) as { pending: unknown[] };
		expect(store.pending).toEqual([]);
	});

	test('promotes a raw running task envelope to a pending background binding', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output:
				'<task id="child-running" state="running"><summary>running</summary></task>',
		});

		expect(readPhaseParticipation(directory, plan(), 1, 'docs').found).toBe(
			false,
		);
		const store = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', ...PHASE_PARTICIPATION_FILE.split('/')),
				'utf8',
			),
		) as { pending: Array<{ childSessionId: string }>; receipts: unknown[] };
		expect(store.pending).toHaveLength(1);
		expect(store.pending[0]).toMatchObject({
			childSessionId: 'child-running',
		});
		expect(store.receipts).toEqual([]);
	});

	test('consumes a terminal failure reservation so a later success cannot mint proof', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output:
				'<task id="child-error" state="error"><task_error>boom</task_error></task>',
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output: foregroundOutput(),
		});

		expect(readPhaseParticipation(directory, plan(), 1, 'docs').found).toBe(
			false,
		);
	});

	test('normalizes a prefixed docs role without weakening the exact binding', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'prefixed',
			args: { subagent_type: 'mega_docs' },
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'prefixed',
			output: foregroundOutput(),
		});
		expect(readPhaseParticipation(directory, plan(), 1, 'docs').found).toBe(
			true,
		);
	});

	test('keeps identical call IDs isolated by parent session', async () => {
		for (const parentSessionId of ['parent-a', 'parent-b']) {
			await reserveApprovedPhaseParticipation({
				directory,
				tool: 'Task',
				parentSessionId,
				callId: 'shared-call',
				args: { subagent_type: 'docs' },
				policy: {},
			});
		}
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent-a',
			callId: 'shared-call',
			output: foregroundOutput('parent-a', 'child-a'),
		});
		expect(readPhaseParticipation(directory, plan(), 1, 'docs').found).toBe(
			true,
		);
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent-b',
			callId: 'shared-call',
			output: { output: '', metadata: { status: 'completed' } },
		});
		const store = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', ...PHASE_PARTICIPATION_FILE.split('/')),
				'utf8',
			),
		) as { receipts: unknown[] };
		expect(store.receipts).toHaveLength(1);
	});

	test('survives task status changes but rejects structural plan drift', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output: foregroundOutput(),
		});
		expect(
			readPhaseParticipation(directory, plan('completed'), 1, 'docs').found,
		).toBe(true);

		const changed = plan('completed');
		changed.phases[0]!.tasks[0]!.description = 'Different obligation';
		expect(readPhaseParticipation(directory, changed, 1, 'docs').found).toBe(
			false,
		);
	});

	test('quarantines exact corrupt bytes only on a genuine redispatch', async () => {
		const evidencePath = path.join(
			directory,
			'.swarm',
			...PHASE_PARTICIPATION_FILE.split('/'),
		);
		fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
		const corrupt = Buffer.from('{not-json}\u0000', 'utf8');
		fs.writeFileSync(evidencePath, corrupt);
		expect(readPhaseParticipation(directory, plan(), 1, 'docs').status).toBe(
			'corrupt',
		);

		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});
		const quarantine = path.join(
			directory,
			'.swarm',
			...PHASE_PARTICIPATION_QUARANTINE_DIR.split('/'),
		);
		const files = fs.readdirSync(quarantine);
		expect(files).toHaveLength(1);
		expect(fs.readFileSync(path.join(quarantine, files[0]!))).toEqual(corrupt);
		expect(readPhaseParticipation(directory, plan(), 1, 'docs').status).toBe(
			'valid',
		);
	});

	test('fails closed without destroying corrupt evidence when quarantine is full', async () => {
		const evidencePath = path.join(
			directory,
			'.swarm',
			...PHASE_PARTICIPATION_FILE.split('/'),
		);
		const quarantine = path.join(
			directory,
			'.swarm',
			...PHASE_PARTICIPATION_QUARANTINE_DIR.split('/'),
		);
		fs.mkdirSync(quarantine, { recursive: true });
		for (let index = 0; index < 16; index++) {
			fs.writeFileSync(
				path.join(quarantine, `${index.toString(16).padStart(64, '0')}.bin`),
				'x',
			);
		}
		const corrupt = Buffer.from('{still-corrupt}', 'utf8');
		fs.writeFileSync(evidencePath, corrupt);

		await expect(
			reserveApprovedPhaseParticipation({
				directory,
				tool: 'Task',
				parentSessionId: 'parent',
				callId: 'call',
				args: { subagent_type: 'docs' },
				policy: {},
			}),
		).rejects.toThrow('PHASE_PARTICIPATION_QUARANTINE_FULL');
		expect(fs.readFileSync(evidencePath)).toEqual(corrupt);
	});

	test('completes taskless background docs and allows its documentation writes', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output: runningOutput('child'),
		});
		fs.writeFileSync(path.join(directory, 'README.md'), 'documented');

		const record = backgroundRecord({
			directory,
			child: 'child',
			taskId: null,
		});
		for (let replay = 0; replay < 2; replay++) {
			expect(
				await completeBackgroundPhaseParticipation({
					directory,
					record,
					resultText: 'Documentation updated.',
				}),
			).toBe(true);
		}
		expect(readPhaseParticipation(directory, plan(), 1, 'docs').found).toBe(
			true,
		);
	});

	test('requires consumed Stage-B ingestion for task-bound background docs', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs', prompt: 'TASK: 1.1' },
			policy: {},
		});
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output: runningOutput('child'),
		});

		expect(
			await completeBackgroundPhaseParticipation({
				directory,
				record: backgroundRecord({ directory, child: 'child', taskId: '1.1' }),
				resultText: 'Done',
			}),
		).toBe(false);
		expect(
			await completeBackgroundPhaseParticipation({
				directory,
				record: backgroundRecord({
					directory,
					child: 'child',
					taskId: '1.1',
					ingestionConsumed: true,
				}),
				resultText: 'Done',
			}),
		).toBe(true);
	});
});
