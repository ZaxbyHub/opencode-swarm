/**
 * Tests for Gate 6 (final_council) enforcement in phase_complete.
 *
 * Tests verify that:
 * 1. Blocks last phase when final_council enabled and evidence missing (FINAL_COUNCIL_REQUIRED)
 * 2. Blocks last phase when final_council enabled and evidence has rejected verdict (FINAL_COUNCIL_REJECTED)
 * 3. Allows last phase when final_council enabled and evidence has approved verdict
 * 4. Blocks last phase when final_council enabled and evidence has invalid verdict (FINAL_COUNCIL_INVALID_VERDICT)
 * 5. Skips gate for intermediate (non-last) phases even when final_council enabled
 * 6. Skips gate when final_council is disabled (default)
 * 7. Skips gate when final_council enabled but phase is not the last phase
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import { getOrCreateProfile, setGates } from '../../../src/db/qa-gate-profile';
import { resetSwarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

let tempDir: string;

const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'test-plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');
const SESSION_ID = 'test-session-final-council';

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
	summary?: string;
	quorumSize?: number;
	omitQuorum?: boolean;
	membersVoted?: string[];
	membersAbsent?: string[];
}) {
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

beforeEach(() => {
	resetSwarmState();
	tempDir = mkdtempSync(join(tmpdir(), 'pc-final-council-'));
});

afterEach(() => {
	resetSwarmState();
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('final_council gate (Gate 6)', () => {
	describe('final_council disabled (default)', () => {
		test('allows completion of last phase without final-council evidence', async () => {
			setupLastPhaseOnly(false);
			// No final_council evidence written - should succeed since gate is disabled
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});
	});

	describe('final_council enabled on last phase', () => {
		test('blocks with FINAL_COUNCIL_REQUIRED when evidence is missing', async () => {
			setupLastPhaseOnly(true);
			// No final-council.json written - should block
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_REQUIRED');
			expect(parsed.final_council_required).toBe(true);
			expect(parsed.message).toContain('final_council is enabled');
			expect(parsed.message).toContain('final-council.json');
		});

		test('blocks with FINAL_COUNCIL_REJECTED when evidence has rejected verdict', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'rejected',
				summary: 'Needs more work',
			});
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_REJECTED');
			expect(parsed.message).toContain('REJECTED');
		});

		test('blocks with FINAL_COUNCIL_REJECTED when evidence has REJECTED (uppercase) verdict', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'REJECTED',
				summary: 'Needs more work',
			});
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_REJECTED');
		});

		test('allows completion when evidence has approved verdict', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'All checks passed',
			});
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('allows completion when evidence has APPROVED (uppercase) verdict', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'APPROVED',
				summary: 'All checks passed',
			});
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('blocks approved evidence without quorum metadata', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Old minimal final council evidence',
				omitQuorum: true,
			});
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_MISSING_QUORUM');
			expect(parsed.message).toContain('quorum metadata');
		});

		test('blocks approved evidence with fewer than five council members', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Partial final council evidence',
				quorumSize: 3,
			});
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_MISSING_QUORUM');
			expect(parsed.message).toContain('five-member final council');
		});

		test('blocks approved evidence with quorumSize 5 but malformed member metadata', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Forged final council evidence',
				quorumSize: 5,
				membersVoted: ['critic'],
				membersAbsent: ['reviewer', 'sme', 'test_engineer', 'explorer'],
			});
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_MISSING_QUORUM');
			expect(parsed.message).toContain('all five required members voted');
		});

		test('allows completion when evidence has concerns verdict', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'concerns',
				summary: 'Some concerns',
			});
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('allows completion when evidence has CONCERNS (uppercase) verdict', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({
				verdict: 'CONCERNS',
				summary: 'Some concerns',
			});
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('blocks with FINAL_COUNCIL_INVALID_VERDICT when evidence has invalid verdict string', async () => {
			setupLastPhaseOnly(true);
			writeFinalCouncilEvidence({ verdict: 'MAYBE', summary: 'Undecided' });
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_INVALID_VERDICT');
		});

		test('emits warning but allows completion when evidence timestamp is older than 24 hours', async () => {
			setupLastPhaseOnly(true);
			// Manually write evidence with a timestamp 25 hours in the past so the
			// stale-timestamp branch fires.  writeFinalCouncilEvidence does not accept
			// a custom timestamp, so we bypass it here.
			const staleTimestamp = new Date(
				Date.now() - 25 * 60 * 60 * 1000,
			).toISOString();
			const evidencePath = join(
				tempDir,
				'.swarm',
				'evidence',
				'final-council.json',
			);
			mkdirSync(join(tempDir, '.swarm', 'evidence'), { recursive: true });
			writeFileSync(
				evidencePath,
				JSON.stringify({
					schema_version: '1.0.0',
					task_id: 'final-council',
					created_at: staleTimestamp,
					updated_at: staleTimestamp,
					entries: [
						{
							type: 'final-council',
							timestamp: staleTimestamp,
							plan_id: PLAN_ID,
							verdict: 'approved',
							summary: 'Stale final council evidence',
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
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings.length).toBeGreaterThanOrEqual(1);
			expect(
				parsed.warnings.some((w: string) => w.includes('older than 24 hours')),
			).toBe(true);
		});

		test('fail-open when plan is missing: returns blocked:false with warning', async () => {
			// Enable final_council but do NOT write a plan.json — the gate should
			// fail-open (non-blocking) with a warning instead of throwing.
			mkdirSync(join(tempDir, '.swarm'), { recursive: true });
			writePluginConfig();
			writeRetro(3);
			enableFinalCouncil();

			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.status).not.toBe('blocked');
			expect(parsed.warnings).toBeDefined();
			expect(parsed.warnings.length).toBeGreaterThanOrEqual(1);
			expect(
				parsed.warnings.some((w: string) => w.includes('plan.json is missing')),
			).toBe(true);
		});
	});

	describe('final_council enabled but phase is not last phase', () => {
		test('skips gate for intermediate phase (phase 1 when phase 3 is last)', async () => {
			setupIntermediatePhase(true);
			// final_council is enabled but we're completing phase 1, not the last phase (3)
			// Should succeed without final-council evidence
			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('skips gate for intermediate phase (phase 2 when phase 3 is last)', async () => {
			// 3-phase plan: phase 2 is NOT the last phase (phase 3 is)
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
						{
							id: '3.1',
							phase: 3,
							status: 'in_progress',
							description: 'Task 3',
						},
					],
				},
			]);
			writePluginConfig();
			writeRetro(2);
			enableFinalCouncil();

			// final_council is enabled but we're completing phase 2, not the last phase (3)
			// Should succeed without final-council evidence
			const result = await executePhaseComplete(
				{ phase: 2, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});
	});

	describe('single-phase plan (only phase is last phase)', () => {
		test('blocks with FINAL_COUNCIL_REQUIRED when evidence is missing on single-phase plan', async () => {
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

			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_REQUIRED');
		});

		test('allows completion on single-phase plan when evidence has approved verdict', async () => {
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
			writeFinalCouncilEvidence({
				verdict: 'approved',
				summary: 'Single phase approved',
			});

			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});
	});

	describe('turbo mode does NOT skip final_council gate (Gate 6 always runs)', () => {
		test('final_council gate blocks with FINAL_COUNCIL_REQUIRED when evidence is missing', async () => {
			// Gate 6 (final_council) is NOT turbo-bypassed — it always runs for
			// the last phase regardless of turbo mode. When evidence is missing,
			// it blocks with FINAL_COUNCIL_REQUIRED.
			setupLastPhaseOnly(true);
			// No final-council.json written - should block
			const result = await executePhaseComplete(
				{ phase: 3, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('FINAL_COUNCIL_REQUIRED');
			expect(parsed.final_council_required).toBe(true);
			expect(parsed.message).toContain('final_council is enabled');
			expect(parsed.message).toContain('final-council.json');
		});
	});
});
