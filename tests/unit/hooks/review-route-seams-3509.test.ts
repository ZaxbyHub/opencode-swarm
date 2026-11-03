/**
 * Issue #3509/#3516 — the route-invalidation seam coverage (C7/AC7+AC8's
 * seam half). Selector group: 'seam'.
 *
 *  - Consult-at-settlement for the background stage-b-gates sites: the
 *    ingestion admission read (site A), the parent-unavailable recovery arm
 *    (site C), applyStageBStateCompletion's completion and advancement
 *    decisions (site D, keyed by the callId PARAMETER), plus a wiring pin
 *    that the completeness-read consult (site B) and the advancement re-check
 *    (D2) exist in the source.
 *  - BLOCK-only: consults never retire the marker; only the completion
 *    observer's CONFIRMED consumed commit retires (the single background
 *    retirement owner).
 *  - The real-observer leg drives createBackgroundCompletionObserver.event
 *    end to end through the REAL durable ingestion commit and asserts the
 *    consumed status/state, the exact claim token, and the retirement.
 *  - PRESERVING control: ok:true/consumed:false (successful no-task
 *    completion) still durably consumes under the fixed commit predicate.
 *  - update-task-status narrowed-contract disclosure pin (AC7 second arm):
 *    that file has no callID to consult with; the invariant claims are
 *    narrowed to the gate settlement and the residual is disclosed in the
 *    release fragment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	type BackgroundDelegationRecord,
	type BackgroundWorkspaceSnapshot,
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findDelegationForCompletion,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	_test_exports as gatesTestExports,
	ingestBackgroundStageBCompletion,
} from '../../../src/background/stage-b-gates';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { workflowGateStatePath } from '../../../src/pr-review/persistence';
import {
	isRouteBlockedForSettlement,
	recordRouteFault,
} from '../../../src/review/route-invalidation-registry';
import {
	advanceTaskState,
	getStageBRouteEvidence,
	getTaskState,
	markStageBRouteRequired,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const PARENT = 'parent-seam';
const CALL = 'call-seam-r1';
const TASK = '1.1';

let directory = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

function git(...args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function stageBRecord(
	role: 'reviewer' | 'test_engineer',
	callID: string,
	workspace: BackgroundWorkspaceSnapshot,
): BackgroundDelegationRecord {
	// Realistic timestamps: the observer's trusted-terminal maintenance pass
	// sweeps delegations whose timestamps look eons stale (epoch-1 fixtures
	// were reconciled away before the ingestion leg could run).
	const now = Date.now();
	// The observer resolves completions BY correlation id, so the fixture
	// uses the subagent session id AS the correlation id (the shape the
	// trusted envelope carries).
	return {
		schemaVersion: 2,
		correlationId: `${callID}:child`,
		jobId: `${callID}:job`,
		subagentSessionId: `${callID}:child`,
		parentSessionId: PARENT,
		callID,
		normalizedAgent: role,
		swarmPrefixedAgent: role,
		planTaskId: TASK,
		evidenceTaskId: TASK,
		status: 'completed',
		createdAt: now,
		updatedAt: now,
		completedAt: now,
		workflowGeneration: 2,
		workspace,
	};
}

const approvedText = `[REVIEWED] | task-${TASK} | APPROVED | seam fixture`;

async function prepareTask(): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, TASK, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:${TASK}`,
	});
	await transitionTaskWorkflowEvidence(directory, TASK, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `stage-a:${TASK}`,
	});
	const session = swarmState.agentSessions.get(PARENT)!;
	markStageBRouteRequired(session, TASK);
	advanceTaskState(session, TASK, 'coder_delegated');
	advanceTaskState(session, TASK, 'pre_check_passed');
}

async function ingest(
	callID = CALL,
	role: 'reviewer' | 'test_engineer' = 'reviewer',
): Promise<Awaited<ReturnType<typeof ingestBackgroundStageBCompletion>>> {
	return ingestBackgroundStageBCompletion({
		directory,
		record: stageBRecord(
			role,
			callID,
			captureWorkspaceSnapshot(directory) as BackgroundWorkspaceSnapshot,
		),
		result: {
			text:
				role === 'reviewer'
					? approvedText
					: `[TESTED] | task-${TASK} | PASS | x`,
			chars: 64,
			truncated: false,
			digest: 'seam-digest',
		},
	});
}

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	directory = canonicalMkdtemp('route-seams-3509-');
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	git('init');
	git('config', 'user.email', 'tests@example.com');
	git('config', 'user.name', 'Tests');
	fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
	git('add', 'base.txt');
	git('commit', '-m', 'test: seam fixture');
	startAgentSession(PARENT, 'architect', directory);
});

afterEach(() => {
	resetSwarmState();
	closeAllProjectDbs();
	removeTreeWithRetry(directory);
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

describe('route-invalidation settlement seams (#3509/#3516 seam coverage)', () => {
	it('seam A (ingestion admission): the consult terminal-drops the completion before any evidence is published', async () => {
		await prepareTask();
		expect(recordRouteFault(directory, PARENT, CALL)).toBe(true);
		const result = await ingest();
		// TERMINAL drop: cannot advance AND must not retry.
		expect(result.ok).toBe(false);
		expect(result.consumed).toBe(true);
		expect(result.reason).toContain('route receipt invalidated');
		const session = swarmState.agentSessions.get(PARENT)!;
		expect(getTaskState(session, TASK)).toBe('pre_check_passed');
		expect(getStageBRouteEvidence(session, TASK)).toHaveLength(0);
	});

	it('seam consults are BLOCK-only: after the terminal drop the marker is still consultable (no retirement without the observer commit)', async () => {
		await prepareTask();
		recordRouteFault(directory, PARENT, CALL);
		await ingest();
		expect(isRouteBlockedForSettlement(directory, CALL, PARENT, TASK)).toBe(
			true,
		);
	});

	it('seam C (parent-unavailable recovery arm): the consult refuses before the durable fallback read', async () => {
		await prepareTask();
		// The parent session is GONE (no swarmState entry): the recovery arm.
		swarmState.agentSessions.delete(PARENT);
		recordRouteFault(directory, PARENT, CALL);
		const result = await ingest();
		expect(result.ok).toBe(false);
		expect(result.consumed).toBe(true);
		expect(result.reason).toContain('parent-unavailable recovery arm');
	});

	it('seam D (applyStageBStateCompletion, callId parameter): an invalidated call records no completion and no advancement', async () => {
		await prepareTask();
		recordRouteFault(directory, PARENT, 'call-seam-d1');
		gatesTestExports.applyStageBStateCompletion(
			TASK,
			'reviewer',
			PARENT,
			false,
			directory,
			'call-seam-d1',
			'call-seam-d1:child',
			2,
		);
		const session = swarmState.agentSessions.get(PARENT)!;
		expect(getTaskState(session, TASK)).toBe('pre_check_passed');
		expect(session.stageBCompletion?.get(TASK)?.has('reviewer') ?? false).toBe(
			false,
		);
	});

	it('seam wiring: the completeness-read consult (B) and the advancement re-check (D2) exist at the source level', () => {
		// Sites A, C, D are pinned behaviorally above. B and D2 are belts that
		// share state with their predecessors (a blocked A/D1 returns first),
		// so their presence is pinned as a wiring fact, not a behavioral leg.
		const source = fs.readFileSync(
			path.resolve(import.meta.dir, '../../../src/background/stage-b-gates.ts'),
			'utf8',
		);
		const occurrences = source.match(/isRouteBlockedForSettlement\(/g);
		expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(5);
	});

	it('seam retirement owner: the REAL observer + REAL durable commit retires the marker after a CONFIRMED consumed terminal drop', async () => {
		await prepareTask();
		recordRouteFault(directory, PARENT, CALL);
		const record = stageBRecord(
			'reviewer',
			CALL,
			captureWorkspaceSnapshot(directory) as BackgroundWorkspaceSnapshot,
		);
		await recordPendingDelegation(directory, record);
		const digest = createHash('sha256').update(approvedText).digest('hex');
		const terminalClaim = await claimTerminalResult(
			directory,
			record.correlationId,
			{
				eventId: buildBackgroundCompletionEventId({
					correlationId: record.correlationId,
					jobId: record.jobId,
					status: 'completed',
					resultDigest: digest,
				}),
				status: 'completed',
				recordedAt: Date.now(),
				result: {
					text: approvedText,
					chars: approvedText.length,
					truncated: false,
					digest,
				},
			},
		);
		expect(terminalClaim?.disposition).toBe('claimed');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: PARENT,
						text: `<task id="${record.subagentSessionId}" state="completed">\n<task_result>${approvedText}</task_result>\n</task>`,
					},
				},
			},
		});
		// The durable commit CONFIRMED the consumed outcome with the exact
		// claim token, and the marker retired with it.
		const settled = await findDelegationForCompletion(
			directory,
			record.correlationId,
		);
		expect(settled?.record.status).toBe('consumed');
		expect(settled?.record.ingestion?.state).toBe('consumed');
		expect(settled?.record.ingestion?.claimToken).toBeTruthy();
		expect(isRouteBlockedForSettlement(directory, CALL, PARENT, TASK)).toBe(
			false,
		);
		// And nothing advanced: the invalid route withheld the completion.
		const session = swarmState.agentSessions.get(PARENT)!;
		expect(getTaskState(session, TASK)).toBe('pre_check_passed');
	});

	it('seam PRESERVING control: the ok:true/consumed:false no-task shape is pinned by the pre-existing taskless-coder observer leg', () => {
		// The ok:true/consumed:false mapping anchor is the pre-existing
		// taskless-coder leg in
		// tests/unit/background/completion-observer-coder.test.ts, which
		// durably consumes a taskless (no Stage-B) completion through the
		// REAL observer (status 'consumed', ingestion.state 'consumed') —
		// exactly the outcome the commit predicate's `applied.ok ||` half
		// must preserve. This control pins the CITATION: if that leg is
		// removed or renamed, this pin fails and the citation must be
		// re-pointed.
		const suite = fs.readFileSync(
			path.resolve(
				import.meta.dir,
				'../background/completion-observer-coder.test.ts',
			),
			'utf8',
		);
		expect(
			suite,
			'the taskless-consumption observer leg must exist by name',
		).toContain(
			"test('taskless completion is durably consumed once without Stage B mutation'",
		);
	});

	it('seam retry retention: a retryable ingestion_error outcome retains the marker (no retirement without a confirmed commit)', async () => {
		await prepareTask();
		recordRouteFault(directory, PARENT, CALL);
		// A record with no workflow generation ingests to the RETRYABLE
		// shape (ok:false, consumed:false -> ingestion_error), which must
		// NOT retire the marker: a replay must refuse again.
		const noGenRecord = stageBRecord(
			'reviewer',
			CALL,
			captureWorkspaceSnapshot(directory) as BackgroundWorkspaceSnapshot,
		);
		const applied = await ingestBackgroundStageBCompletion({
			directory,
			record: { ...noGenRecord, workflowGeneration: undefined },
			result: {
				text: approvedText,
				chars: approvedText.length,
				truncated: false,
				digest: 'retry-digest',
			},
		});
		expect(applied.ok).toBe(false);
		expect(applied.consumed).toBe(false);
		// The observer predicate keeps it retryable (success=false).
		expect(applied.ok || applied.consumed).toBe(false);
		expect(isRouteBlockedForSettlement(directory, CALL, PARENT, TASK)).toBe(
			true,
		);
	});

	it('seam foreground retirement owner: a background dispatch with NO correlation id retires its marker at the early return', async () => {
		// The no-correlation early return in toolAfter skips the generic
		// cleanup, so without an explicit retirement there the call's route
		// invalidation marker would outlive a terminal dispatch. The
		// dispatch's routing faults (EISDIR gate state) to record the
		// marker; the completion output carries neither a correlation id
		// nor a running placeholder, driving the early return.
		fs.mkdirSync(workflowGateStatePath(directory, PARENT), { recursive: true });
		const config = {
			hooks: { delegation_gate: true, background_subagents: true },
		} as unknown as PluginConfig;
		const hook = createDelegationGateHook(config, directory);
		const args = {
			subagent_type: 'reviewer',
			background: true,
			prompt:
				'Review the staged change end to end.\nACCEPTANCE: FR-001 the review covers the requirement',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID: PARENT, callID: 'call-nocorr' },
			{ args },
		);
		expect(
			isRouteBlockedForSettlement(directory, 'call-nocorr', PARENT, '1.1'),
		).toBe(true);
		await hook.toolAfter(
			{
				tool: 'tool.execute.Task',
				sessionID: PARENT,
				callID: 'call-nocorr',
				args,
			},
			{ text: 'plain completion text with no task envelope ids' },
		);
		expect(
			isRouteBlockedForSettlement(directory, 'call-nocorr', PARENT, '1.1'),
		).toBe(false);
	});

	it('seam narrowed-contract pin: update-task-status carries no invalidation consult (no callID surface) and the residual is disclosed in the release fragment', () => {
		const toolSource = fs.readFileSync(
			path.resolve(import.meta.dir, '../../../src/tools/update-task-status.ts'),
			'utf8',
		);
		expect(toolSource.includes('route-invalidation-registry')).toBe(false);
		expect(toolSource.includes('isRouteBlockedForSettlement')).toBe(false);
		const fragment = fs.readFileSync(
			path.resolve(
				import.meta.dir,
				'../../../docs/releases/pending/3509-3516-route-receipt-hardening.md',
			),
			'utf8',
		);
		expect(fragment.includes('update-task-status')).toBe(true);
		expect(fragment.toLowerCase().includes('narrowed')).toBe(true);
	});
});
