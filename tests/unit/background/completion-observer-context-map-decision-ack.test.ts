/**
 * r16 audit (P2): a preserved TERMINAL task status must not ack the whole
 * context-map closeout step when the current completion's mandatory payload
 * was lost to a suppressed save failure.
 *
 * `verifyContextMapWrite`'s terminal-verdict branch (r15) accepted
 * `!releaseProven && entry.final_status !== 'pending'` as proof. But
 * `updateContextMapAfterAgent` also persists this completion's DECISIONS
 * (and best-effort file summaries). When the save fails, the OLD terminal
 * verdict survives untouched — the read-back still sees a non-pending
 * status — and the branch acked the context_map step 'completed' although
 * the current completion's decisions never landed. The closeout obligation
 * was discharged by data from a PREVIOUS completion.
 *
 * r16 repair: decisions are mandatory closeout payload in every verifier
 * branch (exact-text presence — the writer's dedup semantics make presence
 * the idempotent-correct check). File summaries stay explicitly best-effort
 * (documented weaker guarantee, separate from the status/decision release).
 * A completion with no decisions still acks on the preserved verdict alone —
 * no endless retry when the intended durable state is already reached.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendTaskHistory,
	createEmptyContextMap,
	loadContextMap,
	saveContextMap,
} from '../../../src/context-map/persistence';
import { _internals as postAgentInternals } from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_r16p2_parent';
const NEW_SUMMARY = 'architect lane finished: decided and reported';
const NEW_BODY = `<task_result>${NEW_SUMMARY}</task_result>`;
const DECISION_TEXT = 'use bounded seq reconstruction for restart floors';

function writePlan(directory: string): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'P2 Closeout Decision Ack Plan',
		swarm: 'p2-decision-ack',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
	fs.mkdirSync(join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.writeFileSync(
		join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ context_map: { enabled: true } }),
	);
}

/** `.swarm/context.md` with one decision bullet under `## Decisions`. */
function writeContextMd(directory: string): void {
	fs.writeFileSync(
		join(directory, '.swarm', 'context.md'),
		[
			'# Context',
			'',
			'## Decisions',
			`- ${DECISION_TEXT}: survives a restart boundary at one shared mtime`,
			'',
		].join('\n'),
		'utf-8',
	);
}

function completionEvent(childSessionId: string, body: string) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: PARENT,
					text: `<task id="${childSessionId}" state="completed">\n${body}\n</task>`,
				},
			},
		},
	};
}

function seedRejectedEntry(directory: string): void {
	const map = loadContextMap(directory) ?? createEmptyContextMap();
	saveContextMap(
		appendTaskHistory(map, {
			task_id: '1.1',
			goal: '',
			files_touched: [],
			implementation_summary: 'OLD-NEGATIVE',
			final_status: 'rejected',
		}),
		directory,
	);
}

/**
 * Seed an ARCHITECT-role child delegation — only architect-role completions
 * carry decisions (extractContextDecisionsFromContextMd returns [] for
 * other roles).
 */
async function seedArchitectChild(
	directory: string,
	taskId: string,
	childSessionId: string,
): Promise<void> {
	const parent = ensureAgentSession(PARENT, 'architect', directory);
	parent.taskWorkflowStates.set(taskId, 'coder_delegated');
	const generation = await seedStageAPassed(directory, taskId);
	await recordPendingDelegation(directory, {
		correlationId: childSessionId,
		jobId: `job-${childSessionId}`,
		subagentSessionId: childSessionId,
		parentSessionId: PARENT,
		callID: `call-${childSessionId}`,
		normalizedAgent: 'architect',
		swarmPrefixedAgent: 'architect',
		planTaskId: taskId,
		evidenceTaskId: taskId,
		workflowGeneration: generation,
		workspace: captureWorkspaceSnapshot(directory),
	});
}

describe('background completion observer — terminal verdict must not ack lost decisions (r16 P2)', () => {
	let directory: string;
	let cleanup: () => void;
	let origSave: typeof postAgentInternals.saveContextMap;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-ctxmap-decision-'));
		writePlan(directory);
		writeContextMd(directory);
		seedRejectedEntry(directory);
		origSave = postAgentInternals.saveContextMap;
	});

	afterEach(() => {
		postAgentInternals.saveContextMap = origSave;
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('a suppressed save failure must NOT ack the closeout step off the preserved terminal verdict', async () => {
		await seedArchitectChild(directory, '1.1', 'ses_r16p2_arch');
		// The completion carries a NEW decision (from .swarm/context.md) that
		// is NOT yet in the map — and the save fails.
		postAgentInternals.saveContextMap = () => {
			throw new Error('injected disk full');
		};

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(completionEvent('ses_r16p2_arch', NEW_BODY));

		// The terminal 'rejected' verdict survives (correctly untouched)...
		expect(loadContextMap(directory)?.task_history['1.1']?.final_status).toBe(
			'rejected',
		);
		// ...but the current completion's decision never landed, so the
		// context_map closeout step must NOT be acked 'completed'.
		const record = findByCorrelationId(directory, 'ses_r16p2_arch');
		expect(record?.closeout?.steps.context_map?.state).toBe('pending');

		// Recovery: persistence works again; the replay lands the decision,
		// preserves the terminal verdict, and ONLY THEN acks the step — no
		// endless retry.
		postAgentInternals.saveContextMap = origSave;
		await observer.event(completionEvent('ses_r16p2_arch', NEW_BODY));
		const recovered = findByCorrelationId(directory, 'ses_r16p2_arch');
		expect(recovered?.closeout?.steps.context_map?.state).toBe('completed');
		const map = loadContextMap(directory);
		expect(map?.task_history['1.1']?.final_status).toBe('rejected');
		expect(
			map?.decisions.some(
				(entry) => String(entry?.decision ?? '').trim() === DECISION_TEXT,
			),
		).toBe(true);
	});

	test('an already-present decision is idempotent: the preserved verdict alone acks', async () => {
		// The decision from a PREVIOUS completion is already durably present.
		// The intended state (terminal verdict + decision recorded) is fully
		// achieved — the step must ack even though this replay's save is a
		// no-op for the decision (dedup) and the task-history append is
		// guarded off.
		const map = loadContextMap(directory)!;
		saveContextMap(
			{
				...map,
				decisions: [
					...map.decisions,
					{
						id: 'A1',
						decision: DECISION_TEXT,
						rationale: 'previously recorded',
						timestamp: new Date().toISOString(),
						task_id: '1.1',
					},
				],
			},
			directory,
		);
		await seedArchitectChild(directory, '1.1', 'ses_r16p2_idem');

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(completionEvent('ses_r16p2_idem', NEW_BODY));

		const record = findByCorrelationId(directory, 'ses_r16p2_idem');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(loadContextMap(directory)?.task_history['1.1']?.final_status).toBe(
			'rejected',
		);
		// No duplicate decision entry (exact-text dedup).
		const matches = loadContextMap(directory)!.decisions.filter(
			(entry) => String(entry?.decision ?? '').trim() === DECISION_TEXT,
		);
		expect(matches).toHaveLength(1);
	});

	test('a completion with NO decisions still acks on the preserved verdict (no retry loop)', async () => {
		// No context.md decisions for this completion (architect role but the
		// decisions file carries nothing new — simulate by removing the file).
		fs.rmSync(join(directory, '.swarm', 'context.md'));
		await seedArchitectChild(directory, '1.1', 'ses_r16p2_none');

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			contextMap: { enabled: true },
		});
		await observer.event(completionEvent('ses_r16p2_none', NEW_BODY));

		const record = findByCorrelationId(directory, 'ses_r16p2_none');
		expect(record?.closeout?.steps.context_map?.state).toBe('completed');
		expect(loadContextMap(directory)?.task_history['1.1']?.final_status).toBe(
			'rejected',
		);
	});
});
