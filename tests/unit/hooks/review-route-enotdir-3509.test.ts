/**
 * Issue #3516 item 7 (AC10, check C10) — per-task receipt-read fault
 * isolation. Selector group: 'enotdir'.
 *
 * A non-ENOENT receipt-read fault (POSIX ENOTDIR beneath a file-ancestor on
 * POSIX; the equivalent injected read fault on every platform) must isolate
 * to THAT task's settlement: the task is dropped with the route_read_fault
 * class (state unchanged, no completion recorded) while a SIBLING task in
 * the SAME settlement loop still settles. The faults are injected through
 * the `_internals.enforcePersistedReviewRouteReceiptAtSettlement` reader
 * seam so the sibling's read stays healthy (a shared on-disk sabotage would
 * fault both tasks' reads, so per-task injection is the deterministic form).
 *
 * Both read sites are covered: fault-on-FIRST-read (the admission enforce)
 * and fault-on-SECOND-read (the completeness enforce, reached only through a
 * bound dispatch with a full receipt).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import {
	_internals,
	createDelegationGateHook,
} from '../../../src/hooks/delegation-gate';
import {
	buildReviewRouteRouterError,
	persistReviewRouteReceipt,
} from '../../../src/review/routing-enforcement';
import {
	advanceTaskState,
	ensureAgentSession,
	getTaskState,
	recordModifiedFilesForTask,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const SESSION = 'sess-enotdir';
const FAULTED = '1.1';
const SIBLING = '1.2';

/** The real enforcement read, restored in afterEach. */
const realEnforce = _internals.enforcePersistedReviewRouteReceiptAtSettlement;

let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
const dirs: string[] = [];

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	_internals.enforcePersistedReviewRouteReceiptAtSettlement = realEnforce;
});

afterEach(() => {
	_internals.enforcePersistedReviewRouteReceiptAtSettlement = realEnforce;
	resetSwarmState();
	for (const dir of dirs.splice(0)) {
		closeAllProjectDbs();
		removeTreeWithRetry(dir);
	}
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

function writePlan(dir: string): void {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'enotdir 3509',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: [FAULTED, SIBLING].map((id) => ({
						id,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Exercise the gate',
						depends: [],
						files_touched: [`src/${id.replace('.', '-')}.ts`],
					})),
				},
			],
		}),
	);
}

async function prepareBoth(dir: string): Promise<void> {
	for (const taskId of [FAULTED, SIBLING]) {
		await transitionTaskWorkflowEvidence(dir, taskId, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: `coder:${taskId}`,
		});
		await transitionTaskWorkflowEvidence(dir, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: `stage-a:${taskId}`,
		});
	}
	const session = swarmState.agentSessions.get(SESSION)!;
	for (const taskId of [FAULTED, SIBLING]) {
		advanceTaskState(session, taskId, 'coder_delegated');
		advanceTaskState(session, taskId, 'pre_check_passed');
	}
}

/** Seed a fail-open router-error receipt for the sibling (its authorizer). */
async function seedSiblingReceipt(dir: string): Promise<void> {
	await persistReviewRouteReceipt({
		projectRoot: dir,
		receipt: buildReviewRouteRouterError({
			code: 'NO_CHANGED_FILES',
			sessionId: SESSION,
			taskId: SIBLING,
		}),
	});
}

const setDispatchPrompt = `TASK: ${FAULTED} and ${SIBLING} review the changes\nACCEPTANCE: FR-001 the diff satisfies the requirement`;

const reviewed = (taskId: string) =>
	`[REVIEWED] | task-${taskId} | APPROVED | enotdir fixture`;

/**
 * Fault the settlement reads for FAULTED only, on the given invocation
 * (1 = admission read, 2 = completeness read), via the reader seam.
 */
function injectFault(readIndex: 1 | 2): void {
	const seen = new Map<string, number>();
	_internals.enforcePersistedReviewRouteReceiptAtSettlement = ((args: {
		taskId?: string;
	}) => {
		const key = args.taskId ?? '(none)';
		const next = (seen.get(key) ?? 0) + 1;
		seen.set(key, next);
		if (key === FAULTED && next === readIndex) {
			const error = new Error(
				`ENOTDIR: not a directory, scandir '<redacted>/route-receipts/${key}.json'`,
			);
			(error as NodeJS.ErrnoException).code = 'ENOTDIR';
			throw error;
		}
		return realEnforce(args as Parameters<typeof realEnforce>[0]);
	}) as typeof realEnforce;
}

describe('route-receipt read-fault isolation (#3516 item 7 / AC10)', () => {
	it('enotdir fault on the FIRST read drops only the faulted task; the sibling still settles', async () => {
		const dir = canonicalMkdtemp('route-enotdir-3509-');
		dirs.push(dir);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		writePlan(dir);
		ensureAgentSession(SESSION, 'architect', dir);
		await prepareBoth(dir);
		await seedSiblingReceipt(dir);
		const session = swarmState.agentSessions.get(SESSION)!;
		// The faulted task gets a healthy full-receipt dispatch so its
		// settlement reaches the enforce read at all.
		recordModifiedFilesForTask(session, FAULTED, ['src/1-1.ts'], dir);
		const hook = createDelegationGateHook(
			{ hooks: { delegation_gate: true } } as unknown as PluginConfig,
			dir,
		);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: SESSION, callID: 'call-e1' },
			{
				args: {
					subagent_type: 'reviewer',
					task_id: FAULTED,
					prompt: setDispatchPrompt,
				},
			},
		);
		await hook.taskMetadata({
			callID: 'call-e1',
			parentSessionID: SESSION,
			childSessionID: 'child-e1',
		});
		injectFault(1);
		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID: SESSION,
				callID: 'call-e1',
				args: {
					subagent_type: 'reviewer',
					task_id: FAULTED,
					prompt: setDispatchPrompt,
				},
			},
			{ text: `${reviewed(FAULTED)}\n${reviewed(SIBLING)}` },
		);
		// The faulted task was dropped (route_read_fault): unchanged state,
		// no completion. The sibling settled and advanced on its receipt.
		expect(getTaskState(session, FAULTED)).toBe('pre_check_passed');
		expect(
			session.stageBCompletion?.get(FAULTED)?.has('reviewer') ?? false,
		).toBe(false);
		expect(getTaskState(session, SIBLING)).toBe('reviewer_run');
		expect(
			session.stageBCompletion?.get(SIBLING)?.has('reviewer') ?? false,
		).toBe(true);
	});

	it('enotdir fault on the SECOND read (completeness) drops only the faulted task; the sibling still settles', async () => {
		const dir = canonicalMkdtemp('route-enotdir-3509-');
		dirs.push(dir);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		writePlan(dir);
		ensureAgentSession(SESSION, 'architect', dir);
		await prepareBoth(dir);
		await seedSiblingReceipt(dir);
		const session = swarmState.agentSessions.get(SESSION)!;
		// A bound dispatch (full receipt + child identity) reaches the
		// completeness read for the faulted task.
		recordModifiedFilesForTask(session, FAULTED, ['src/1-1.ts'], dir);
		const hook = createDelegationGateHook(
			{ hooks: { delegation_gate: true } } as unknown as PluginConfig,
			dir,
		);
		await hook.toolBefore(
			{ tool: 'Task', sessionID: SESSION, callID: 'call-e2' },
			{
				args: {
					subagent_type: 'reviewer',
					task_id: FAULTED,
					prompt: setDispatchPrompt,
				},
			},
		);
		await hook.taskMetadata({
			callID: 'call-e2',
			parentSessionID: SESSION,
			childSessionID: 'child-e2',
		});
		injectFault(2);
		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID: SESSION,
				callID: 'call-e2',
				args: {
					subagent_type: 'reviewer',
					task_id: FAULTED,
					prompt: setDispatchPrompt,
				},
			},
			{ text: `${reviewed(FAULTED)}\n${reviewed(SIBLING)}` },
		);
		expect(getTaskState(session, FAULTED)).toBe('pre_check_passed');
		expect(
			session.stageBCompletion?.get(FAULTED)?.has('reviewer') ?? false,
		).toBe(false);
		expect(getTaskState(session, SIBLING)).toBe('reviewer_run');
		expect(
			session.stageBCompletion?.get(SIBLING)?.has('reviewer') ?? false,
		).toBe(true);
	});
});
