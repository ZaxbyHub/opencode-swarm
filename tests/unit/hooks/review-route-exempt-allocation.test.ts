/**
 * Regression (Wirtschaftssimulation session 29b8ccea, task 1.8): the
 * dispatch-time review route allocation demanded the complexity-routed
 * test-engineer count even when the task's durable evidence proved the
 * sanctioned test_engineer exemption (docs-only declared+observed Markdown
 * change, receipt-backed at coder settlement). An exempt task never
 * dispatches a test engineer, so its route receipt could never reach
 * completeness and the workflow wedged at reviewer_run with "all required
 * proof exists". The allocation must zero the test-engineer requirement when
 * the DURABLE evidence proves the exemption — observed attribution alone
 * still may not self-prove one (the anti-forgery property is unchanged).
 *
 * Env isolation: createIsolatedTestEnv redirects the hive/app-data roots the
 * route-receipt MAC secret lives under (never the developer's real app-data).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { readReviewRouteReceipt } from '../../../src/review/routing-enforcement';
import {
	recordModifiedFilesForTask,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';
import { ensureSessionDrained } from './_session-rehydration-drain';

function makeConfig(): PluginConfig {
	return { hooks: { delegation_gate: true } } as unknown as PluginConfig;
}

const writePlan = (dir: string): void => {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Exempt allocation fixture',
			swarm: 'test',
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
							description: 'Docs-only change',
							depends: [],
							files_touched: ['AGENTS.md'],
						},
					],
				},
			],
		}),
	);
};

const reviewerArgs = {
	subagent_type: 'reviewer',
	prompt:
		'TASK: 1.1 review the change\nACCEPTANCE: FR-001 the diff satisfies the requirement',
};

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

function gateDir(): string {
	const dir = canonicalMkdtemp('route-exempt-alloc-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	writePlan(dir);
	return dir;
}

async function seedEvidence(dir: string, exempt: boolean): Promise<void> {
	await transitionTaskWorkflowEvidence(dir, '1.1', {
		type: 'accepted_mutation',
		agentType: 'coder',
		...(exempt ? { context: { testEngineerExempt: true } } : {}),
		expectedGeneration: 0,
		transitionId: 'alloc-coder:1.1',
	});
	await transitionTaskWorkflowEvidence(dir, '1.1', {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: 'alloc-stage-a:1.1',
	});
}

async function dispatchReviewer(dir: string, sessionID: string): Promise<void> {
	// Drain the async session rehydration (see _session-rehydration-drain.ts)
	// so it cannot land mid-dispatch and overwrite the session's workflow
	// view while the routing block is persisting the receipt.
	await ensureSessionDrained(sessionID, dir);
	recordModifiedFilesForTask(
		swarmState.agentSessions.get(sessionID)!,
		'1.1',
		['AGENTS.md'],
		dir,
	);
	const hook = createDelegationGateHook(makeConfig(), dir);
	// The dispatch may be refused by gates after the routing block (the
	// routing bookkeeping still persists the receipt first — the ordering the
	// #3380 suite pins); only the persisted receipt matters here.
	await hook
		.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-alloc-1' },
			{ args: reviewerArgs },
		)
		.catch(() => undefined);
}

describe('review route allocation — durable test-engineer exemption', () => {
	it('regression: a durably exempt task is routed zero test-engineer slots', async () => {
		const dir = gateDir();
		await seedEvidence(dir, true);

		await dispatchReviewer(dir, 'sess-alloc-exempt');

		const receipt = await readReviewRouteReceipt({
			projectRoot: dir,
			sessionId: 'sess-alloc-exempt',
			taskId: '1.1',
		});
		expect(receipt?.kind).toBe('review_route_receipt');
		if (receipt?.kind !== 'review_route_receipt') return;
		// Previous code: required.testEngineers === 1 from the complexity
		// router — a slot the exempt task can never fill.
		expect(receipt.required).toEqual({ reviewers: 1, testEngineers: 0 });
		expect(receipt.identities.testEngineers).toEqual([]);
	});

	it('control: a non-exempt task still gets the routed test-engineer demand', async () => {
		const dir = gateDir();
		await seedEvidence(dir, false);

		await dispatchReviewer(dir, 'sess-alloc-control');

		const receipt = await readReviewRouteReceipt({
			projectRoot: dir,
			sessionId: 'sess-alloc-control',
			taskId: '1.1',
		});
		expect(receipt?.kind).toBe('review_route_receipt');
		if (receipt?.kind !== 'review_route_receipt') return;
		expect(receipt.required).toEqual({ reviewers: 1, testEngineers: 1 });
	});
});
