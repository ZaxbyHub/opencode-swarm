/**
 * Adversarial tests for Gate 6 (final_council) enforcement in phase_complete.
 * Focused attack vectors per FR-001 requirements.
 *
 * Attack vectors tested:
 * 1. final_council=true but phase=0 — invalid phase, gate should not bypass
 * 2. Plan with empty phases array — lastPhaseId undefined, gate should skip
 * 3. Evidence file with empty entries array — should block as FINAL_COUNCIL_REQUIRED
 * 4. Evidence with multiple entries: first rejected, second approved — should block on first rejected
 * 5. Non-sequential phase IDs (1, 5, 10) — gate fires only on phase 10
 * 6. Malformed evidence JSON (not valid JSON) — should handle gracefully
 * 7. Evidence verdict is a number (42) not string — should block
 * 8. Single-phase plan (id=1) — fires for phase 1
 * 9. Missing plan.json entirely
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
import { executePhaseComplete } from '../../../src/tools/phase-complete';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';

let tempDir: string;

const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'test-plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');
const SESSION_ID = 'test-session-fc-adversarial';

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
			phase_complete: { enabled: true, required_agents: [], policy: 'warn' },
		}),
	);
}

function writeRetro(phase: number) {
	const retroPath = join(tempDir, '.swarm', 'evidence', `retro-${phase}`);
	mkdirSync(retroPath, { recursive: true });
	writeFileSync(
		join(retroPath, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			created_at: '2026-08-23T12:00:00.000Z',
			updated_at: '2026-08-23T12:00:00.000Z',
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp: '2026-08-23T12:00:00.000Z',
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

function readCurrentPlan() {
	return PlanSchema.parse(
		JSON.parse(readFileSync(join(tempDir, '.swarm', 'plan.json'), 'utf-8')),
	);
}

function writeFinalCouncilEvidence(options: {
	verdict: string;
	entries?: Array<Record<string, unknown>>;
	summary?: string;
}) {
	const evidencePath = join(tempDir, '.swarm', 'evidence');
	mkdirSync(evidencePath, { recursive: true });
	const ts = '2026-08-23T12:00:00.000Z';
	const plan = readCurrentPlan();
	const defaultEntry = {
		type: 'final-council',
		timestamp: ts,
		plan_id: PLAN_ID,
		plan_hash: computePlanHash(plan),
		plan_identity_hash: derivePlanIdentityHash(plan),
		...identityFieldsForCurrentPlan(),
		verdict: options.verdict,
		summary: options.summary ?? 'Final council verdict',
	};
	writeFileSync(
		join(evidencePath, 'final-council.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'final-council',
			created_at: ts,
			updated_at: ts,
			entries: options.entries ?? [defaultEntry],
		}),
	);
}

function identityFieldsForCurrentPlan() {
	const plan = readCurrentPlan();
	const identity = computeCouncilReviewIdentity({
		level: 'final',
		scope: { kind: 'final', final: true },
		plan,
		config: undefined,
	});
	return {
		identity_version: identity.version,
		review_hash: identity.reviewHash,
		policy_digest: identity.policyDigest,
		identity_digest: identity.identityDigest,
	};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('final_council gate — entry ordering', () => {
	let restoreClock: Restore | null = null;

	beforeEach(() => {
		restoreClock = freezeClock({
			fixedNow: Date.parse('2026-08-23T12:00:00.000Z'),
		});
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'pc-fc-order-')));
	});

	afterEach(() => {
		restoreClock?.();
		restoreClock = null;
		closeProjectDb(tempDir);
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('ATTACK-4: blocks on first rejected entry even when second is approved', async () => {
		writePlan([
			{
				id: 1,
				name: 'Phase 1 (last)',
				tasks: [
					{ id: '1.1', phase: 1, status: 'completed', description: 'Task 1' },
				],
			},
		]);
		writePluginConfig();
		writeRetro(1);
		enableFinalCouncil();

		const evidencePath = join(tempDir, '.swarm', 'evidence');
		mkdirSync(evidencePath, { recursive: true });
		const ts = '2026-08-23T12:00:00.000Z';
		const plan = readCurrentPlan();
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
						plan_hash: computePlanHash(plan),
						plan_identity_hash: derivePlanIdentityHash(plan),
						...identityFieldsForCurrentPlan(),
						verdict: 'rejected',
						summary: 'First verdict - rejected',
						quorumSize: 5,
						membersVoted: [
							'critic',
							'reviewer',
							'sme',
							'test_engineer',
							'explorer',
						],
						membersAbsent: [],
					},
					{
						type: 'final-council',
						timestamp: ts,
						plan_id: PLAN_ID,
						plan_hash: computePlanHash(plan),
						plan_identity_hash: derivePlanIdentityHash(plan),
						...identityFieldsForCurrentPlan(),
						verdict: 'approved',
						summary: 'Second verdict - approved',
						quorumSize: 5,
						membersVoted: [
							'critic',
							'reviewer',
							'sme',
							'test_engineer',
							'explorer',
						],
						membersAbsent: [],
					},
				],
			}),
		);

		const result = await executePhaseComplete(
			{ phase: 1, summary: 'test', sessionID: SESSION_ID },
			tempDir,
			tempDir,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('FINAL_COUNCIL_REJECTED');
	});
});
