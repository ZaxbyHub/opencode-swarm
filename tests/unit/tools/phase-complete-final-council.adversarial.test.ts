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
 * 9. Missing plan.json entirely — gate should skip gracefully
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import { getOrCreateProfile, setGates } from '../../../src/db/qa-gate-profile';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

let tempDir: string;

const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'test-plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');
const SESSION_ID = 'test-session-fc-adversarial';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
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
	getOrCreateProfile(tempDir, PLAN_ID);
	setGates(tempDir, PLAN_ID, { final_council: true });
}

function writeFinalCouncilEvidence(options: {
	verdict: string;
	entries?: Array<Record<string, unknown>>;
	summary?: string;
}) {
	const evidencePath = join(tempDir, '.swarm', 'evidence');
	mkdirSync(evidencePath, { recursive: true });
	const ts = new Date().toISOString();
	const defaultEntry = {
		type: 'final-council',
		timestamp: ts,
		plan_id: PLAN_ID,
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('final_council gate (Gate 6) — adversarial attack vectors', () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'pc-fc-adv-'));
	});

	afterEach(() => {
		closeProjectDb(tempDir);
		try {
			rmSync(tempDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		} catch {
			// Windows can briefly retain SQLite handles after closeProjectDb.
		}
	});

	// =======================================================================
	// ATTACK VECTOR 1: final_council=true but phase=0 (invalid phase)
	// Gate should NOT bypass — invalid phase rejected before gate logic runs
	// =======================================================================
	test('ATTACK-1: blocks phase=0 even when final_council is enabled', async () => {
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
		writeRetro(0);
		enableFinalCouncil();
		writeFinalCouncilEvidence({ verdict: 'approved' });

		const result = await executePhaseComplete(
			{ phase: 0, summary: 'test', sessionID: SESSION_ID },
			tempDir,
			tempDir,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('Invalid phase number');
	});

	// =======================================================================
	// ATTACK VECTOR 2: Plan with empty phases array
	// lastPhaseId = undefined, gate should skip (phase !== lastPhaseId)
	// =======================================================================
	test('ATTACK-2: skips gate gracefully when plan has empty phases array', async () => {
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
		writeFileSync(
			join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				swarm: PLAN_SWARM,
				title: PLAN_TITLE,
				spec: '',
				phases: [],
			}),
		);
		writePluginConfig();
		enableFinalCouncil();

		const result = await executePhaseComplete(
			{ phase: 1, summary: 'test', sessionID: SESSION_ID },
			tempDir,
			tempDir,
		);
		const parsed = JSON.parse(result);
		// Gate checks: lastPhaseId = plan.phases[plan.phases.length - 1]?.id
		// With empty array: lastPhaseId = undefined, so phase === lastPhaseId is false (0 !== undefined)
		// Gate should not fire, but phase 1 doesn't exist so retro fails
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('RETROSPECTIVE_MISSING');
	});

	// =======================================================================
	// ATTACK VECTOR 3: Evidence file with empty entries array
	// Should block as FINAL_COUNCIL_REQUIRED (no valid entries found)
	// =======================================================================
	test('ATTACK-3: blocks with FINAL_COUNCIL_REQUIRED when entries array is empty', async () => {
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
		writeFinalCouncilEvidence({ verdict: 'approved', entries: [] });

		const result = await executePhaseComplete(
			{ phase: 1, summary: 'test', sessionID: SESSION_ID },
			tempDir,
			tempDir,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('FINAL_COUNCIL_REQUIRED');
	});

	// =======================================================================
	// ATTACK VECTOR 4: Multiple entries — first rejected, second approved
	// Should block on FIRST rejected entry (order matters)
	// =======================================================================
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
		const ts = new Date().toISOString();
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

	// =======================================================================
	// ATTACK VECTOR 5: Non-sequential phase IDs (1, 5, 10)
	// Gate fires ONLY on phase 10 (the last phase), not on phase 5
	// =======================================================================
	test('ATTACK-5: gate fires only on last phase (id=10) not intermediate (id=5)', async () => {
		writePlan([
			{
				id: 1,
				name: 'Phase 1',
				tasks: [
					{ id: '1.1', phase: 1, status: 'completed', description: 'Task 1' },
				],
			},
			{
				id: 5,
				name: 'Phase 5',
				tasks: [
					{ id: '5.1', phase: 5, status: 'completed', description: 'Task 5' },
				],
			},
			{
				id: 10,
				name: 'Phase 10 (last)',
				tasks: [
					{
						id: '10.1',
						phase: 10,
						status: 'completed',
						description: 'Task 10',
					},
				],
			},
		]);
		writePluginConfig();
		writeRetro(5);
		enableFinalCouncil();
		// No final-council.json

		// Completing phase 5 (NOT last) — gate should NOT fire
		const result5 = await executePhaseComplete(
			{ phase: 5, summary: 'test', sessionID: SESSION_ID },
			tempDir,
			tempDir,
		);
		const parsed5 = JSON.parse(result5);
		expect(parsed5.success).toBe(true);

		// Completing phase 10 (last) — gate SHOULD fire
		writeRetro(10);

		const result10 = await executePhaseComplete(
			{ phase: 10, summary: 'test', sessionID: SESSION_ID },
			tempDir,
			tempDir,
		);
		const parsed10 = JSON.parse(result10);
		expect(parsed10.success).toBe(false);
		expect(parsed10.reason).toBe('FINAL_COUNCIL_REQUIRED');
	});

	// =======================================================================
	// ATTACK VECTOR 6: Malformed evidence JSON (not valid JSON)
	// Should handle gracefully — treat as missing evidence
	// =======================================================================
	test('ATTACK-6: handles malformed final-council.json gracefully', async () => {
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
		writeFileSync(
			join(evidencePath, 'final-council.json'),
			'{ "schema_version": "1.0.0", INVALID JSON<<<',
		);

		const result = await executePhaseComplete(
			{ phase: 1, summary: 'test', sessionID: SESSION_ID },
			tempDir,
			tempDir,
		);
		const parsed = JSON.parse(result);
		// JSON parse error in try/catch sets fcVerdictFound = false, should block
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('FINAL_COUNCIL_REQUIRED');
	});

	// =======================================================================
	// ATTACK VECTOR 7: Evidence verdict is a number (42) not string
	// Should block as FINAL_COUNCIL_INVALID_VERDICT
	// =======================================================================
	test('ATTACK-7: blocks when verdict is a number instead of string', async () => {
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
		const ts = new Date().toISOString();
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
						verdict: 42, // number, not string
						summary: 'Numeric verdict',
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
		// Gate code checks typeof entry.verdict === 'string' before processing,
		// so numeric verdicts are skipped entirely — gate reports FINAL_COUNCIL_REQUIRED
		// because no valid string-verdict entry was found.
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('FINAL_COUNCIL_REQUIRED');
	});

	// =======================================================================
	// ATTACK VECTOR 8: Single-phase plan (id=1)
	// Gate should fire for phase 1 since it's both first and last
	// =======================================================================
	test('ATTACK-8: fires gate for single-phase plan where id=1 is last phase', async () => {
		writePlan([
			{
				id: 1,
				name: 'Phase 1 (only and last)',
				tasks: [
					{ id: '1.1', phase: 1, status: 'completed', description: 'Task 1' },
				],
			},
		]);
		writePluginConfig();
		writeRetro(1);
		enableFinalCouncil();
		// No final-council.json

		const result = await executePhaseComplete(
			{ phase: 1, summary: 'test', sessionID: SESSION_ID },
			tempDir,
			tempDir,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('FINAL_COUNCIL_REQUIRED');
	});

	// =======================================================================
	// ATTACK VECTOR 9: Missing plan.json entirely
	// Gate should skip gracefully (no plan means no last phase to compare)
	// =======================================================================
	test('ATTACK-9: skips gate gracefully when plan.json is missing', async () => {
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
		// No plan.json written
		writePluginConfig();
		enableFinalCouncil();
		writeRetro(1);

		const result = await executePhaseComplete(
			{ phase: 1, summary: 'test', sessionID: SESSION_ID },
			tempDir,
			tempDir,
		);
		const parsed = JSON.parse(result);
		// Gate code: if (!plan) { /* skips gate entirely */ }
		// Missing plan.json means gate skips, but phase_complete still fails
		// on a different check (plan.json not available for phase status update)
		expect(parsed.success).toBe(true); // Gate skipped, phase completes (plan status update is non-blocking)
	});

	// =======================================================================
	// ATTACK VECTOR 10: Evidence with mismatched plan_id
	// Should be blocked with final_council_plan_mismatch
	// =======================================================================
	test('ATTACK-10: blocks evidence with mismatched plan_id', async () => {
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
		const ts = new Date().toISOString();
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
						plan_id: 'different-plan-id', // mismatched plan_id
						verdict: 'approved',
						summary: 'Evidence with wrong plan_id',
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
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('final_council_plan_mismatch');
	});

	// =======================================================================
	// ATTACK VECTOR 11: Evidence with valid verdict but missing plan_id
	// Should be blocked with FINAL_COUNCIL_PLAN_ID_REQUIRED
	// =======================================================================
	test('ATTACK-11: blocks evidence missing plan_id field', async () => {
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
		const ts = new Date().toISOString();
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
						// plan_id intentionally omitted
						verdict: 'approved',
						summary: 'Evidence without plan_id',
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
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('FINAL_COUNCIL_PLAN_ID_REQUIRED');
	});
});
