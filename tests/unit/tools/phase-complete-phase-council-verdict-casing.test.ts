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
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';

let tempDir: string;

const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'test-plan';
const SESSION_ID = 'test-session-1';

function writePlan() {
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	writeFileSync(
		join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			swarm: PLAN_SWARM,
			title: PLAN_TITLE,
			spec: '',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							description: 'Test task',
						},
					],
				},
			],
		}),
	);
}

/** Write plugin config with optional council overrides. */
function writePluginConfig(
	councilOverrides?: Record<string, unknown> | null,
	extraConfig?: Record<string, unknown>,
) {
	mkdirSync(join(tempDir, '.opencode'), { recursive: true });
	const config: Record<string, unknown> = {
		phase_complete: {
			enabled: true,
			required_agents: [],
			require_docs: false,
			policy: 'warn',
		},
		...extraConfig,
	};
	if (councilOverrides === null) {
		// Explicitly set council to null to test how loader handles it
		config.council = null;
	} else if (councilOverrides !== undefined) {
		config.council = {
			enabled: true,
			phaseConcernsAllowComplete: true,
			...councilOverrides,
		};
	}
	// If councilOverrides is undefined, no council key is written at all
	writeFileSync(
		join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config),
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
			created_at: '2026-08-23T12:00:00.000Z',
			updated_at: '2026-08-23T12:00:00.000Z',
			entries: [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: '2026-08-23T12:00:00.000Z',
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

function enableCouncilMode() {
	setGatesForIdentity(
		tempDir,
		{ swarm: PLAN_SWARM, title: PLAN_TITLE },
		{ phase_council: true },
	);
}

function writePhaseCouncil(options: {
	verdict: string;
	quorumSize?: number;
	timestamp?: string;
	phaseNumber?: number;
}) {
	const evidencePath = join(tempDir, '.swarm', 'evidence', '1');
	mkdirSync(evidencePath, { recursive: true });
	const ts = options.timestamp ?? '2026-08-23T12:00:00.000Z';
	// Identity bound to the ACTUAL phase being completed (1), mirroring what
	// the gate recomputes; wrong-phase-number entries must surface the
	// precise PHASE_COUNCIL_PHASE_MISMATCH, not an identity failure.
	const plan = PlanSchema.parse(
		JSON.parse(readFileSync(join(tempDir, '.swarm', 'plan.json'), 'utf-8')),
	);
	const identity = computeCouncilReviewIdentity({
		level: 'phase',
		scope: { kind: 'phase', phaseNumber: 1 },
		plan,
		config: loadPluginConfig(tempDir).council,
	});
	writeFileSync(
		join(evidencePath, 'phase-council.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'phase-1',
			created_at: ts,
			updated_at: ts,
			entries: [
				{
					type: 'phase-council',
					phase_number: options.phaseNumber ?? 1,
					scope: 'phase',
					timestamp: ts,
					verdict: options.verdict,
					quorumSize: options.quorumSize ?? 3,
					requiredFixes: [],
					advisoryNotes: [],
					advisoryFindings: [],
					roundNumber: 1,
					allCriteriaMet: true,
					identity_version: identity.version,
					review_hash: identity.reviewHash,
					policy_digest: identity.policyDigest,
					identity_digest: identity.identityDigest,
				},
			],
		}),
	);
}

function setup(councilMode: boolean) {
	writePlan();
	writePluginConfig(councilMode ? {} : undefined);
	writeRetro();
	ensureAgentSession(SESSION_ID);
	recordPhaseAgentDispatch(SESSION_ID, 'coder');
	recordPhaseAgentDispatch(SESSION_ID, 'reviewer');
	recordPhaseAgentDispatch(SESSION_ID, 'test_engineer');
	recordPhaseAgentDispatch(SESSION_ID, 'docs');
	if (councilMode) enableCouncilMode();
}

async function phaseComplete() {
	return executePhaseComplete(
		{ phase: 1, summary: 'adversarial test', sessionID: SESSION_ID },
		tempDir,
		tempDir,
	);
}

let restoreClock: Restore | null = null;

beforeEach(() => {
	restoreClock = freezeClock({
		fixedNow: Date.parse('2026-08-23T12:00:00.000Z'),
	});
	resetSwarmState();
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'pc-adv-')));
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	resetSwarmState();
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

// =============================================================================
// ADVERSARIAL TESTS: phaseConcernsAllowComplete config path
// =============================================================================

/**
 * Attack Vector 1: phaseConcernsAllowComplete is absent from config
 * Expected: ?? true fallback applies, phase completes successfully
 *
 * Mechanism: config.council is written WITHOUT phaseConcernsAllowComplete key.
 * Zod default(true) applies during PluginConfigSchema.parse → parsed config has
 * phaseConcernsAllowComplete = true. The ?? true is never reached (no null/undef).
 */
describe('adversarial: verdict case sensitivity', () => {
	test('AV8: verdict="Concerns" (mixed case) — NOT matched by CONCERNS or concerns checks, blocked as INVALID', async () => {
		setup(true);
		writePhaseCouncil({ verdict: 'Concerns', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PHASE_COUNCIL_INVALID');
	});

	test('AV8b: verdict="concerns" (lowercase) — MATCHES code at line 1130, treated as advisory', async () => {
		setup(true);
		writePhaseCouncil({ verdict: 'concerns', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		// 'concerns' is explicitly matched at line 1130
		// With default (no council key), ?? true → true → allows completion
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});

	test('AV8c: verdict="reject" (lowercase) — MATCHES code at line 1103, blocks as PHASE_COUNCIL_REJECTED', async () => {
		setup(true);
		writePhaseCouncil({ verdict: 'reject', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PHASE_COUNCIL_REJECTED');
	});

	test('AV8d: verdict="approve" (lowercase) — MATCHES code at line 1167, allows completion', async () => {
		setup(true);
		writePhaseCouncil({ verdict: 'approve', quorumSize: 3, phaseNumber: 1 });
		const result = await phaseComplete();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});
});
