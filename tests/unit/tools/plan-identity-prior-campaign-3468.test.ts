/**
 * PR #3468: prior-campaign classification of task-gate evidence.
 *
 * Only a POSITIVE plan-identity mismatch (evidence stamped for a different
 * plan) classifies evidence as predating the current campaign. Unstamped
 * legacy evidence is "unknown" and a missing plan.json means there is no
 * current identity to compare against; neither may be reported as
 * prior-campaign by check_gate_status or the checkReviewerGate refusal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TASK_WORKFLOW_SCHEMA_MARKER } from '../../../src/gate-evidence';
import { derivePlanIdentityHash } from '../../../src/plan/utils';
import {
	markStageBRouteRequired,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { check_gate_status } from '../../../src/tools/check-gate-status';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const CURRENT_PLAN = { swarm: 'current-swarm', title: 'Current Campaign' };
const OTHER_PLAN = { swarm: 'current-swarm', title: 'Previous Campaign' };
const CURRENT_HASH = derivePlanIdentityHash(CURRENT_PLAN);
const OTHER_HASH = derivePlanIdentityHash(OTHER_PLAN);

const PRIOR_WORDING = 'predates the current plan campaign';
const PRIOR_STAMP_WORDING = 'plan-identity stamp names a different plan';
const LEGACY_REASON_WORDING =
	'has not satisfied its exact v1 review route receipt';
const LEGACY_NEXT_ACTION = 'Recover the exact route receipt';

const SESSION_ID = 'parent-3468';

type Stamp = 'different' | 'current' | 'unstamped';

let directory: string;
let cleanup: () => void;

beforeEach(() => {
	resetSwarmState();
	({ dir: directory, cleanup } = createSafeTestDir('plan-identity-3468-'));
});

afterEach(() => {
	resetSwarmState();
	cleanup();
});

function writePlan(
	plan: { swarm: string; title: string } = CURRENT_PLAN,
): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({ schema_version: '1.0.0', ...plan, phases: [] }),
	);
}

function stampFields(stamp: Stamp): Record<string, string> {
	if (stamp === 'different') {
		return { planId: 'other-plan', planIdentityHash: OTHER_HASH };
	}
	if (stamp === 'current') {
		return { planId: 'current-plan', planIdentityHash: CURRENT_HASH };
	}
	return {};
}

/** Evidence with every required gate present and workflow complete. */
function writeCompleteEvidence(taskId: string, stamp: Stamp): void {
	const gate = (agent: string) => ({
		sessionId: `${agent}-session`,
		timestamp: '2026-09-14T00:00:00.000Z',
		agent,
	});
	const evidence = {
		taskId,
		required_gates: ['pre_check', 'reviewer', 'test_engineer'],
		gates: {
			pre_check: gate('pre_check'),
			reviewer: gate('reviewer'),
			test_engineer: gate('test_engineer'),
		},
		...stampFields(stamp),
		workflow: {
			schema: TASK_WORKFLOW_SCHEMA_MARKER,
			generation: 1,
			state: 'complete',
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: 'none',
			lastTransitionId: 'seed:complete',
			updatedAt: '2026-09-14T00:00:00.000Z',
		},
	};
	const evidenceDir = path.join(directory, '.swarm', 'evidence');
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, `${taskId}.json`),
		JSON.stringify(evidence),
	);
}

async function gateStatus(taskId: string): Promise<Record<string, unknown>> {
	const raw = await check_gate_status.execute(
		{ task_id: taskId },
		{ directory },
	);
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	// A thrown tool error must not masquerade as "no prior-campaign note".
	expect(parsed.failure_class).toBeUndefined();
	expect(typeof parsed.status).toBe('string');
	return parsed;
}

describe('check_gate_status prior_campaign_evidence (#3468)', () => {
	test('(a) stamp for a DIFFERENT plan sets prior_campaign_evidence and extends message', async () => {
		writePlan();
		writeCompleteEvidence('1.1', 'different');
		const result = await gateStatus('1.1');

		expect(typeof result.prior_campaign_evidence).toBe('string');
		const note = String(result.prior_campaign_evidence);
		expect(note).toContain(PRIOR_WORDING);
		expect(note).toContain(PRIOR_STAMP_WORDING);
		expect(note).toContain('repair_gate_evidence');
		expect(String(result.message)).toContain(note);
	});

	test('(a) the mismatch note does not change the reported status', async () => {
		writePlan();
		writeCompleteEvidence('1.1', 'different');
		writeCompleteEvidence('1.2', 'current');
		const mismatched = await gateStatus('1.1');
		const matching = await gateStatus('1.2');

		expect(mismatched.status).toBe(matching.status);
		expect(mismatched.passed_gates).toEqual(matching.passed_gates);
		expect(mismatched.missing_gates).toEqual(matching.missing_gates);
	});

	test('(b) stamp matching the CURRENT plan leaves prior_campaign_evidence absent', async () => {
		writePlan();
		writeCompleteEvidence('1.1', 'current');
		const result = await gateStatus('1.1');

		expect('prior_campaign_evidence' in result).toBe(false);
		expect(String(result.message)).not.toContain(PRIOR_WORDING);
	});

	test('(c) UNSTAMPED legacy evidence with plan.json present is not prior-campaign', async () => {
		writePlan();
		writeCompleteEvidence('1.1', 'unstamped');
		const result = await gateStatus('1.1');

		expect('prior_campaign_evidence' in result).toBe(false);
		expect(String(result.message)).not.toContain(PRIOR_WORDING);
	});

	test('(d) plan.json missing leaves prior_campaign_evidence absent even for a mismatched stamp', async () => {
		writeCompleteEvidence('1.1', 'different');
		expect(fs.existsSync(path.join(directory, '.swarm', 'plan.json'))).toBe(
			false,
		);
		const result = await gateStatus('1.1');

		expect('prior_campaign_evidence' in result).toBe(false);
		expect(String(result.message)).not.toContain(PRIOR_WORDING);
	});

	test('a plan edit that changes identity flips matching evidence to prior-campaign', async () => {
		writePlan();
		writeCompleteEvidence('1.1', 'current');
		expect('prior_campaign_evidence' in (await gateStatus('1.1'))).toBe(false);

		writePlan(OTHER_PLAN);
		writeCompleteEvidence('1.1', 'current');
		// Evidence still carries CURRENT_HASH while the plan is now OTHER_PLAN.
		expect('prior_campaign_evidence' in (await gateStatus('1.1'))).toBe(true);
	});
});

describe('checkReviewerGate route-receipt refusal wording (#3468)', () => {
	function gate(taskId: string) {
		// fallbackDir drives the exact-task (durable evidence) path. Marking the
		// task as route-required with no persisted review route receipt makes
		// routeGateAllowsTask() fail closed, which reaches the receipt refusal.
		startAgentSession(SESSION_ID, 'architect', directory);
		markStageBRouteRequired(swarmState.agentSessions.get(SESSION_ID)!, taskId);
		return checkReviewerGate(taskId, directory, false, SESSION_ID, directory);
	}

	function expectLegacyRefusal(taskId: string): void {
		const result = gate(taskId);
		expect(result.blocked).toBe(true);
		expect(result.missingGates).toEqual(['review_route_receipt']);
		expect(result.reason).toContain(LEGACY_REASON_WORDING);
		expect(result.reason).not.toContain(PRIOR_WORDING);
		expect(result.nextAction).toContain(LEGACY_NEXT_ACTION);
		expect(result.nextAction).not.toContain('repair_gate_evidence');
	}

	test('(a) stamp for a DIFFERENT plan blocks with prior-campaign reason and nextAction', () => {
		writePlan();
		writeCompleteEvidence('1.1', 'different');
		const result = gate('1.1');

		expect(result.blocked).toBe(true);
		expect(result.missingGates).toEqual(['review_route_receipt']);
		expect(result.reason).toContain(PRIOR_WORDING);
		expect(result.reason).toContain(PRIOR_STAMP_WORDING);
		expect(result.reason).toContain('repair_gate_evidence');
		expect(result.reason).not.toContain(LEGACY_REASON_WORDING);
		expect(result.nextAction).toContain('repair_gate_evidence');
		expect(result.nextAction).not.toContain(LEGACY_NEXT_ACTION);
	});

	test('(b) stamp matching the CURRENT plan keeps the pre-existing receipt wording', () => {
		writePlan();
		writeCompleteEvidence('1.1', 'current');
		expectLegacyRefusal('1.1');
	});

	test('(c) UNSTAMPED legacy evidence keeps the pre-existing receipt wording', () => {
		writePlan();
		writeCompleteEvidence('1.1', 'unstamped');
		expectLegacyRefusal('1.1');
	});

	test('(d) plan.json missing keeps the pre-existing receipt wording', () => {
		writeCompleteEvidence('1.1', 'different');
		expectLegacyRefusal('1.1');
	});
});
