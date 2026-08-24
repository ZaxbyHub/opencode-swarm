/**
 * Tests for Gate 6 (final_council) enforcement in phase_complete.
 *
 * Tests verify that:
 * 1. Blocks last phase when final_council enabled and evidence missing (FINAL_COUNCIL_REQUIRED)
 * 2. Blocks last phase when final_council enabled and evidence has rejected verdict (FINAL_COUNCIL_REJECTED)
 * 3. Allows last phase when final_council enabled and evidence has approved verdict
 * 4. Blocks last phase when final_council enabled and evidence has invalid verdict (FINAL_COUNCIL_INVALID_VERDICT)
 * 5. Skips gate for intermediate (non-last) phases even when final_council enabled
 * 6. Skips gate when final_council is disabled
 * 7. Skips gate when final_council enabled but phase is not the last phase
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { PlanSchema } from '../../../src/config/plan-schema';
import { computeCouncilReviewIdentity } from '../../../src/council/council-review-identity';
import { closeProjectDb } from '../../../src/db/project-db';
import { setGatesForIdentity } from '../../../src/db/qa-gate-profile';
import { computePlanHash } from '../../../src/plan/ledger';
import { derivePlanIdentityHash } from '../../../src/plan/utils';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';

let tempDir: string;

const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'test-plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');
const SESSION_ID = 'test-session-final-council';

function writePlan(
	phases: Array<{
		id: number;
		name: string;
		tasks: Array<{
			id: string;
			phase: number;
			status: string;
			description: string;
		}>;
	}>,
) {
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	writeFileSync(
		join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			swarm: PLAN_SWARM,
			title: PLAN_TITLE,
			spec: '',
			phases,
		}),
	);
}

function writePluginConfig() {
	mkdirSync(join(tempDir, '.opencode'), { recursive: true });
	writeFileSync(
		join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: [],
				require_docs: false,
				policy: 'warn',
			},
		}),
	);
}

function writeRetro(phase: number) {
	writeRetroBundle(`retro-${phase}`, phase, '2026-08-23T12:00:00.000Z');
}

function writeRetroBundle(taskId: string, phase: number, timestamp: string) {
	const retroPath = join(tempDir, '.swarm', 'evidence', taskId);
	mkdirSync(retroPath, { recursive: true });
	writeFileSync(
		join(retroPath, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: taskId,
			created_at: timestamp,
			updated_at: timestamp,
			entries: [
				{
					task_id: taskId,
					type: 'retrospective',
					timestamp,
					agent: 'architect',
					verdict: 'pass',
					summary: `Phase ${phase} done`,
					phase_number: phase,
					total_tool_calls: 5,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
		}),
	);
}

function enableFinalCouncil() {
	setGatesForIdentity(
		tempDir,
		{ swarm: PLAN_SWARM, title: PLAN_TITLE },
		{ final_council: true },
	);
}

function writeFinalCouncilEvidence(options: {
	verdict: string;
	summary?: string;
	quorumSize?: number;
	omitQuorum?: boolean;
	membersVoted?: string[];
	membersAbsent?: string[];
	timestamp?: string;
	omitPlanHash?: boolean;
	planHash?: string;
	omitPlanIdentityHash?: boolean;
	planIdentityHash?: string;
	omitIdentity?: boolean;
	reviewHashOverride?: string;
	identityDigestOverride?: string;
	policyDigestOverride?: string;
	identityVersionOverride?: number;
}) {
	const evidencePath = join(tempDir, '.swarm', 'evidence');
	mkdirSync(evidencePath, { recursive: true });
	const ts = options.timestamp ?? '2026-08-23T12:00:00.000Z';
	const plan = PlanSchema.parse(
		JSON.parse(readFileSync(join(tempDir, '.swarm', 'plan.json'), 'utf-8')),
	);
	// The gate recomputes the identity from the SAME shared implementation
	// (with no council config in these fixtures), so evidence written with the
	// real helper passes identity checks byte-for-byte.
	const identity = computeCouncilReviewIdentity({
		level: 'final',
		scope: { kind: 'final', final: true },
		plan,
		config: undefined,
	});
	writeFileSync(
		join(evidencePath, 'final-council.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'final-council',
			created_at: ts,
			updated_at: ts,
			entries: [
				{
					type: 'final-council',
					timestamp: ts,
					plan_id: PLAN_ID,
					...(options.omitPlanHash
						? {}
						: { plan_hash: options.planHash ?? computePlanHash(plan) }),
					...(options.omitPlanIdentityHash
						? {}
						: {
								plan_identity_hash:
									options.planIdentityHash ?? derivePlanIdentityHash(plan),
							}),
					...(options.omitIdentity
						? {}
						: {
								identity_version:
									options.identityVersionOverride ?? identity.version,
								review_hash: options.reviewHashOverride ?? identity.reviewHash,
								policy_digest:
									options.policyDigestOverride ?? identity.policyDigest,
								identity_digest:
									options.identityDigestOverride ?? identity.identityDigest,
							}),
					verdict: options.verdict,
					summary: options.summary ?? 'Final council verdict',
					...(options.omitQuorum
						? {}
						: {
								quorumSize: options.quorumSize ?? 5,
								membersVoted: options.membersVoted ?? [
									'critic',
									'reviewer',
									'sme',
									'test_engineer',
									'explorer',
								],
								membersAbsent: options.membersAbsent ?? [],
							}),
				},
			],
		}),
	);
}

function setupLastPhaseOnly(finalCouncilEnabled: boolean) {
	// 3-phase plan: phase 3 is the last phase
	writePlan([
		{
			id: 1,
			name: 'Phase 1',
			tasks: [
				{ id: '1.1', phase: 1, status: 'completed', description: 'Task 1' },
			],
		},
		{
			id: 2,
			name: 'Phase 2',
			tasks: [
				{ id: '2.1', phase: 2, status: 'completed', description: 'Task 2' },
			],
		},
		{
			id: 3,
			name: 'Phase 3 (last)',
			tasks: [
				{ id: '3.1', phase: 3, status: 'completed', description: 'Task 3' },
			],
		},
	]);
	writePluginConfig();
	// Write retro for phase 3 (the phase we're completing)
	writeRetro(3);
	if (finalCouncilEnabled) {
		enableFinalCouncil();
	}
}

function setupIntermediatePhase(finalCouncilEnabled: boolean) {
	// 3-phase plan: phase 1 is NOT the last phase (phase 3 is)
	writePlan([
		{
			id: 1,
			name: 'Phase 1',
			tasks: [
				{ id: '1.1', phase: 1, status: 'completed', description: 'Task 1' },
			],
		},
		{
			id: 2,
			name: 'Phase 2',
			tasks: [
				{ id: '2.1', phase: 2, status: 'completed', description: 'Task 2' },
			],
		},
		{
			id: 3,
			name: 'Phase 3 (last)',
			tasks: [
				{ id: '3.1', phase: 3, status: 'in_progress', description: 'Task 3' },
			],
		},
	]);
	writePluginConfig();
	writeRetro(1);
	if (finalCouncilEnabled) {
		enableFinalCouncil();
	}
}

let restoreClock: Restore | null = null;

beforeEach(() => {
	restoreClock = freezeClock({
		fixedNow: Date.parse('2026-08-23T12:00:00.000Z'),
	});
	resetSwarmState();
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'pc-final-council-id-')));
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	resetSwarmState();
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

describe('final_council gate (Gate 6) — council review identity (#2102)', () => {
	describe('final_council enabled on last phase', () => {
		test('status-only plan change after evidence no longer invalidates the review (#2102)', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Evidence bound to review-relevant plan content',
			});
			// Flip a task status AFTER the council approved — pure execution
			// progress. The status-sensitive ledger hash changes, but the
			// review-relevant identity must not, so the gate still accepts.
			const planPath = join(tempDir, '.swarm', 'plan.json');
			const planJson = JSON.parse(readFileSync(planPath, 'utf-8'));
			planJson.phases[0].tasks[0].status = 'in_progress';
			writeFileSync(planPath, JSON.stringify(planJson));

			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
		});

		test('blocks approved evidence when a review-relevant plan requirement changes', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Evidence for older review-relevant plan content',
			});
			// Change a task DESCRIPTION after the council approved — a
			// review-relevant change that must invalidate the evidence.
			const planPath = join(tempDir, '.swarm', 'plan.json');
			const planJson = JSON.parse(readFileSync(planPath, 'utf-8'));
			planJson.phases[0].tasks[0].description = 'Changed requirement';
			writeFileSync(planPath, JSON.stringify(planJson));

			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_STALE_REVIEW_IDENTITY');
		});

		test('blocks approved evidence when the recorded review identity does not match', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Evidence bound to a different review generation',
				reviewHashOverride: '0'.repeat(64),
			});

			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_STALE_REVIEW_IDENTITY');
		});

		test('blocks approved evidence when policy digest does not match', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Evidence produced under a different council policy',
				policyDigestOverride: '1'.repeat(64),
			});

			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_POLICY_MISMATCH');
		});

		test('blocks approved evidence predating the council identity cutover (legacy, no identity proof)', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Legacy evidence without identity binding',
				omitIdentity: true,
			});

			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_IDENTITY_REQUIRED');
		});

		test('plan_hash mismatch alone no longer blocks (audit-only field; identity binding is enforced instead)', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Evidence whose audit-only ledger hash drifted',
				planHash: '0'.repeat(64),
			});

			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
		});

		test('plan_hash missing entirely no longer blocks (audit-only field; identity binding is enforced instead)', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Evidence without the audit-only plan_hash field',
				omitPlanHash: true,
			});

			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
		});
	});
});
