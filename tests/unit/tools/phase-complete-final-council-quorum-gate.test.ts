/**
 * PRR-016 — gate-level coverage for `council.finalCompletionPolicy` quorum
 * mode. The writer path is covered by write-final-council-evidence-policy
 * tests; these tests drive `phase_complete` end-to-end so the GATE's quorum
 * branch (accept at the configured minimum, reject below, and policy-digest
 * binding) is exercised, not just the writer's.
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
import { loadPluginConfig } from '../../../src/config/loader';
import { PlanSchema } from '../../../src/config/plan-schema';
import { computeCouncilReviewIdentity } from '../../../src/council/council-review-identity';
import { closeProjectDb } from '../../../src/db/project-db';
import { setGatesForIdentity } from '../../../src/db/qa-gate-profile';
import { derivePlanIdentityHash } from '../../../src/plan/utils';
import { resetSwarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';

const PLAN_SWARM = 'quorum-swarm';
const PLAN_TITLE = 'quorum-plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');
const SESSION_ID = 'quorum-gate-session';
// The gate evaluates freshness against the real clock (no clock seam in
// PhaseCompleteRuntime), so the suite freezes Date.now at FIXED_TS: the
// evidence timestamp equals the frozen "now" and stays fresh forever instead
// of expiring 24h after authorship (review finding on PRR-016).
const FIXED_NOW_MS = Date.parse('2026-08-23T12:00:00.000Z');
const FIXED_TS = '2026-08-23T12:00:00.000Z';
let restoreClock: Restore | null = null;
const CANONICAL = ['critic', 'reviewer', 'sme', 'test_engineer', 'explorer'];

let tempDir: string;

function writePlan() {
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	writeFileSync(
		join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			swarm: PLAN_SWARM,
			title: PLAN_TITLE,
			phases: [
				{
					id: 1,
					name: 'Phase 1 (last)',
					tasks: [
						{ id: '1.1', phase: 1, status: 'completed', description: 'Task 1' },
					],
				},
			],
		}),
	);
}

function writeQuorumConfig(minimumMembers: number) {
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
			council: {
				enabled: true,
				finalCompletionPolicy: { mode: 'quorum', minimumMembers },
			},
		}),
	);
}

function writeRetro() {
	const retroPath = join(tempDir, '.swarm', 'evidence', 'retro-1');
	mkdirSync(retroPath, { recursive: true });
	writeFileSync(
		join(retroPath, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'retro-1',
			created_at: '2026-08-23T11:00:00.000Z',
			updated_at: '2026-08-23T11:00:00.000Z',
			entries: [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: '2026-08-23T11:00:00.000Z',
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase 1 done',
					phase_number: 1,
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

function writeFinalEvidence(options: {
	membersVoted: string[];
	quorumSize: number;
	policyDigestOverride?: string;
}) {
	const evidencePath = join(tempDir, '.swarm', 'evidence');
	mkdirSync(evidencePath, { recursive: true });
	const plan = PlanSchema.parse(
		JSON.parse(readFileSync(join(tempDir, '.swarm', 'plan.json'), 'utf8')),
	);
	const identity = computeCouncilReviewIdentity({
		level: 'final',
		scope: { kind: 'final', final: true },
		plan,
		config: loadPluginConfig(tempDir).council,
	});
	writeFileSync(
		join(evidencePath, 'final-council.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'final-council',
			created_at: FIXED_TS,
			updated_at: FIXED_TS,
			entries: [
				{
					type: 'final-council',
					timestamp: FIXED_TS,
					plan_id: PLAN_ID,
					plan_identity_hash: derivePlanIdentityHash(plan),
					identity_version: identity.version,
					review_hash: identity.reviewHash,
					policy_digest: options.policyDigestOverride ?? identity.policyDigest,
					identity_digest: identity.identityDigest,
					verdict: 'approved',
					quorumSize: options.quorumSize,
					membersVoted: options.membersVoted,
					membersAbsent: CANONICAL.filter(
						(m) => !options.membersVoted.includes(m),
					),
				},
			],
		}),
	);
}

async function complete(): Promise<Record<string, unknown>> {
	const result = await executePhaseComplete(
		{ phase: 1, summary: 'test', sessionID: SESSION_ID },
		tempDir,
		tempDir,
	);
	return JSON.parse(result) as Record<string, unknown>;
}

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FIXED_NOW_MS });
	resetSwarmState();
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-gate-')));
	writePlan();
	writeRetro();
	setGatesForIdentity(
		tempDir,
		{ swarm: PLAN_SWARM, title: PLAN_TITLE },
		{ final_council: true },
	);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	resetSwarmState();
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

describe('final_council gate — quorum completion policy (PRR-016)', () => {
	test('quorum 4 accepts evidence with exactly four distinct canonical members', async () => {
		writeQuorumConfig(4);
		const four = CANONICAL.slice(0, 4);
		writeFinalEvidence({ membersVoted: four, quorumSize: 4 });
		const parsed = await complete();
		expect(parsed.success).toBe(true);
	});

	test('quorum 4 rejects evidence with only three distinct canonical members', async () => {
		writeQuorumConfig(4);
		const three = CANONICAL.slice(0, 3);
		writeFinalEvidence({ membersVoted: three, quorumSize: 3 });
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('FINAL_COUNCIL_MISSING_QUORUM');
		expect(parsed.message).toContain('minimumMembers: 4');
	});

	test('cross-swarm duplicate aliases never satisfy the quorum minimum', async () => {
		writeQuorumConfig(4);
		// local_critic + mega_critic collapse to one canonical critic.
		writeFinalEvidence({
			membersVoted: ['local_critic', 'mega_critic', 'reviewer', 'sme'],
			quorumSize: 4,
		});
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('FINAL_COUNCIL_MISSING_QUORUM');
		expect(parsed.message).toContain('distinct canonical members: 3 of 4');
	});

	test('quorum evidence under a changed policy fails the digest binding', async () => {
		// Evidence minted under quorum 4...
		writeQuorumConfig(4);
		writeFinalEvidence({ membersVoted: CANONICAL.slice(0, 4), quorumSize: 4 });
		// ...then the policy changes to quorum 3 before completion.
		writeQuorumConfig(3);
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		// The identity digest embeds the policy digest, so a policy change
		// surfaces as a stale review identity (checked before policy_digest).
		expect(parsed.reason).toBe('FINAL_COUNCIL_STALE_REVIEW_IDENTITY');
	});
});
