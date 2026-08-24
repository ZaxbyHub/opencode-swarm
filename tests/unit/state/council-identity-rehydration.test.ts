/**
 * Issue #2102 contract H + invariant 7 — task-council rehydration cutover.
 *
 * Legacy `gates.council` evidence without identity proof fails closed (the
 * cached approval is dropped → fresh council run), and identity-bearing
 * evidence is validated against the CURRENT review identity.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginConfig } from '../../../src/config/loader';
import { computeCouncilReviewIdentity } from '../../../src/council/council-review-identity';
import type { AgentSessionState } from '../../../src/state';
import {
	rehydrateSessionFromDisk,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

let tmpDir: string;
let sessionCounter = 0;
// Fixed timestamp keeps the suite deterministic (no real-clock usage).
const FIXED_TS = '2026-08-23T12:00:00.000Z';

function writePlan(): void {
	mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
	writeFileSync(
		join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Cutover Plan',
			swarm: 'cutover',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							description: 'Task 1.1',
							status: 'in_progress',
							size: 'small',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		}),
	);
}

function councilEvidence(
	taskId: string,
	identityMode: 'current' | 'legacy' | 'wrong',
) {
	const gatesCouncil: Record<string, unknown> = {
		sessionId: 's1',
		timestamp: FIXED_TS,
		agent: 'architect',
		verdict: 'APPROVE',
		roundNumber: 1,
		quorumSize: 3,
		workflowGeneration: 1,
	};
	if (identityMode !== 'legacy') {
		const plan = JSON.parse(
			readFileSync(join(tmpDir, '.swarm', 'plan.json'), 'utf8'),
		);
		const identity = computeCouncilReviewIdentity({
			level: 'task',
			scope: { kind: 'task', taskId },
			plan,
			config: loadPluginConfig(tmpDir).council,
		});
		gatesCouncil.identity_version = identity.version;
		gatesCouncil.review_hash =
			identityMode === 'wrong' ? '0'.repeat(64) : identity.reviewHash;
		gatesCouncil.policy_digest = identity.policyDigest;
		gatesCouncil.identity_digest =
			identityMode === 'wrong' ? '1'.repeat(64) : identity.identityDigest;
	}
	return {
		taskId,
		required_gates: ['council'],
		gates: { council: gatesCouncil },
		workflow: {
			schema: 'exact-task-v1',
			generation: 1,
			state: 'pre_check_passed',
			updatedAt: FIXED_TS,
			lastTransitionId: 'seed',
		},
	};
}

function writeCouncilFile(
	taskId: string,
	identityMode: 'current' | 'legacy' | 'wrong',
) {
	const dir = join(tmpDir, '.swarm', 'evidence');
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${taskId}.json`),
		JSON.stringify(councilEvidence(taskId, identityMode)),
	);
}

function createSession(): AgentSessionState {
	sessionCounter += 1;
	startAgentSession(`cutover-session-${sessionCounter}`, 'architect');
	const session = swarmState.agentSessions.get(
		`cutover-session-${sessionCounter}`,
	);
	if (!session) throw new Error('failed to create session');
	return session;
}

beforeEach(() => {
	resetSwarmState();
	tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'council-cutover-')));
	writePlan();
});

afterEach(() => {
	resetSwarmState();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('council identity rehydration cutover (#2102)', () => {
	it('identity-bearing evidence bound to the current identity rehydrates', async () => {
		writeCouncilFile('1.1', 'current');
		const session = createSession();
		await rehydrateSessionFromDisk(tmpDir, session);
		expect(session.taskCouncilApproved?.get('1.1')).toBeDefined();
		expect(session.taskCouncilApproved?.get('1.1')?.verdict).toBe('APPROVE');
	});

	it('legacy evidence without identity proof fails closed (fresh council run)', async () => {
		writeCouncilFile('1.1', 'legacy');
		const session = createSession();
		await rehydrateSessionFromDisk(tmpDir, session);
		expect(session.taskCouncilApproved?.get('1.1')).toBeUndefined();
	});

	it('identity-bearing evidence bound to a stale generation fails closed', async () => {
		writeCouncilFile('1.1', 'wrong');
		const session = createSession();
		await rehydrateSessionFromDisk(tmpDir, session);
		expect(session.taskCouncilApproved?.get('1.1')).toBeUndefined();
	});

	it('a review-relevant plan change invalidates the rehydrated approval', async () => {
		writeCouncilFile('1.1', 'current');
		// Rewrite the plan with a changed requirement (review-relevant).
		const planPath = join(tmpDir, '.swarm', 'plan.json');
		const planJson = JSON.parse(readFileSync(planPath, 'utf8'));
		planJson.phases[0].tasks[0].description = 'Changed requirement';
		writeFileSync(planPath, JSON.stringify(planJson));

		const session = createSession();
		await rehydrateSessionFromDisk(tmpDir, session);
		expect(session.taskCouncilApproved?.get('1.1')).toBeUndefined();
	});

	it('a status-only plan change keeps the rehydrated approval', async () => {
		writeCouncilFile('1.1', 'current');
		const planPath = join(tmpDir, '.swarm', 'plan.json');
		const planJson = JSON.parse(readFileSync(planPath, 'utf8'));
		planJson.phases[0].tasks[0].status = 'completed';
		writeFileSync(planPath, JSON.stringify(planJson));

		const session = createSession();
		await rehydrateSessionFromDisk(tmpDir, session);
		expect(session.taskCouncilApproved?.get('1.1')?.verdict).toBe('APPROVE');
	});

	it.each([
		['APPROVE', 2],
		['REJECT', 1],
		['CONCERNS', 3],
	] as const)('%s verdict rehydrates correctly from identity-bearing evidence', async (verdict, roundNumber) => {
		writeCouncilFile('1.1', 'current');
		// Overwrite the verdict/round fields the way the shared fixture does.
		const dir = join(tmpDir, '.swarm', 'evidence');
		const file = join(dir, '1.1.json');
		const evidence = JSON.parse(readFileSync(file, 'utf8'));
		evidence.gates.council.verdict = verdict;
		evidence.gates.council.roundNumber = roundNumber;
		writeFileSync(file, JSON.stringify(evidence));
		const session = createSession();
		await rehydrateSessionFromDisk(tmpDir, session);
		expect(session.taskCouncilApproved?.get('1.1')).toEqual({
			verdict,
			roundNumber,
			quorumSize: 3,
		});
	});
});
