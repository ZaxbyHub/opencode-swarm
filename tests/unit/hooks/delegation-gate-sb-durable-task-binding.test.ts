/**
 * 2026-11-25 swarm_communication_debug (restart-era agent-gate wedge, layer B):
 * a critic_sounding_board dispatch carries NO task_id argument — the task id
 * rides only in free prompt prose, which the strict attribution policy
 * correctly refuses. Before the host-restart era the in-memory session
 * fallback (currentTaskId) supplied the binding; after a restart that map is
 * empty and the delegation record persisted task-less, making the completion
 * ingestion a no-op BY DEFINITION (taskId null → no Stage-B evidence side
 * effects) — the SB gate receipt can never land (live: ses_defd94c65ffe,
 * planTaskId null, terminalResult present, ingestion null). The gate now
 * binds the task durably via the LATEST coder delegation of the same parent
 * session; the helper is fail-closed (uncertain store or no coder delegation
 * keeps null).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	findByCorrelationId,
	findLatestCoderTaskForParentSession,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import {
	advanceTaskState,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';
import { ensureSessionDrained } from './_session-rehydration-drain';

const SESSION = 'sess-sb-task-bind';
const TASK = '1.1';

let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
const dirs: string[] = [];

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
	for (const dir of dirs.splice(0)) {
		closeAllProjectDbs();
		removeTreeWithRetry(dir);
	}
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

function git(directory: string, ...args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 20_000,
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || `git ${args.join(' ')} failed in fixture setup`,
		);
	}
}

function makeProject(): string {
	const dir = canonicalMkdtemp('sb-task-bind-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), 'export const value = 1;\n');
	git(dir, 'init');
	git(dir, 'config', 'user.email', 'test@example.com');
	git(dir, 'config', 'user.name', 'Test');
	git(dir, 'add', 'src/foo.ts');
	git(dir, 'commit', '-m', 'fixture');
	fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n.swarm/\n');
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'sb task binding',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: [
						{
							id: TASK,
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Exercise the SB gate',
							depends: [],
							files_touched: ['src/foo.ts'],
						},
					],
				},
			],
		}),
	);
	return dir;
}

async function seedWorkflow(dir: string): Promise<void> {
	await ensureSessionDrained(SESSION, dir);
	await transitionTaskWorkflowEvidence(dir, TASK, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:${TASK}`,
	});
	await transitionTaskWorkflowEvidence(dir, TASK, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `stage-a:${TASK}`,
	});
	const session = swarmState.agentSessions.get(SESSION)!;
	advanceTaskState(session, TASK, 'coder_delegated');
	advanceTaskState(session, TASK, 'pre_check_passed');
}

async function seedCoderDelegation(
	dir: string,
	correlationId: string,
	taskId: string,
	parentSessionId = SESSION,
): Promise<void> {
	await recordPendingDelegation(dir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId,
		callID: `call-${correlationId}`,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: taskId,
		evidenceTaskId: taskId,
	});
}

describe('findLatestCoderTaskForParentSession (durable SB task-binding source)', () => {
	it('returns the latest coder delegation task of the session and ignores non-coder or foreign records', async () => {
		const dir = makeProject();
		await seedCoderDelegation(dir, 'ses-coder-older', TASK);
		await seedCoderDelegation(dir, 'ses-coder-newer', '1.2');
		await recordPendingDelegation(dir, {
			correlationId: 'ses-reviewer-other',
			jobId: null,
			subagentSessionId: 'ses-reviewer-other',
			parentSessionId: SESSION,
			callID: 'call-reviewer',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '9.9',
			evidenceTaskId: '9.9',
		});
		const latest = findLatestCoderTaskForParentSession(dir, SESSION);
		expect(latest.status).toBe('ok');
		if (latest.status !== 'ok') return;
		expect(latest.taskId).toBe('1.2');
	});

	it('yields null for a session without coder delegations (fail-closed, no invention)', async () => {
		const dir = makeProject();
		await seedCoderDelegation(dir, 'ses-coder-foreign', TASK, 'sess-other');
		const latest = findLatestCoderTaskForParentSession(dir, SESSION);
		expect(latest.status).toBe('ok');
		if (latest.status !== 'ok') return;
		expect(latest.taskId).toBeNull();
	});
});

describe('sounding-board dispatch task binding through the delegation gate', () => {
	it('a task-less SB dispatch (post-restart shape) binds the durable latest-coder task', async () => {
		const dir = makeProject();
		await seedWorkflow(dir);
		await seedCoderDelegation(dir, 'ses-coder-leg', TASK);
		// Post-restart shape: the prompt names the task only in free prose
		// (no TASK: marker, no task_id argument, no currentTaskId).
		const hook = createDelegationGateHook(
			{
				hooks: { delegation_gate: true, background_subagents: true },
			} as unknown as PluginConfig,
			dir,
		);
		const callID = 'call-sb-bind';
		try {
			await hook.toolBefore(
				{ tool: 'Task', sessionID: SESSION, callID },
				{
					args: {
						subagent_type: 'critic_sounding_board',
						description: 'SB escalation for the retried coder chain',
						prompt:
							'astra_critic_sounding_board\nTASK: Stage-B-Gate critic_sounding_board für Task 1.1 — retry escalation\n',
					},
				},
			);
		} catch {
			// Later gate arms (scope/settlement fences) are outside this
			// binding assertion; the delegation record is written in toolAfter.
		}
		await hook.taskMetadata({
			callID,
			parentSessionID: SESSION,
			childSessionID: 'ses_sb_child',
		});
		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID: SESSION,
				callID,
				args: {
					subagent_type: 'critic_sounding_board',
					description: 'SB escalation for the retried coder chain',
					prompt:
						'astra_critic_sounding_board\nTASK: Stage-B-Gate critic_sounding_board für Task 1.1 — retry escalation\n',
					background: true,
				},
			},
			{
				state: 'running',
				output: '<task id="ses_sb_child" state="running"><task_result>running</task_result></task>',
				metadata: { jobId: 'job_sb_child', background: true },
			},
		);

		const record = findByCorrelationId(dir, 'ses_sb_child');
		expect(record?.normalizedAgent).toBe('critic_sounding_board');
		expect(record?.planTaskId).toBe(TASK);
		expect(record?.evidenceTaskId).toBe(TASK);
	});
});
