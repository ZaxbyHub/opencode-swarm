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

function writePluginConfig(overrides?: { council?: Record<string, unknown> }) {
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
			...(overrides?.council ? { council: overrides.council } : {}),
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
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			entries: [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: new Date().toISOString(),
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
	getOrCreateProfile(tempDir, PLAN_ID);
	setGates(tempDir, PLAN_ID, { council_mode: true });
}

function writePhaseCouncil(options: {
	verdict: string;
	quorumSize?: number;
	timestamp?: string;
	phaseNumber?: number;
}) {
	const evidencePath = join(tempDir, '.swarm', 'evidence', '1');
	mkdirSync(evidencePath, { recursive: true });
	const ts = options.timestamp ?? new Date().toISOString();
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
				},
			],
		}),
	);
}

function setup(councilMode: boolean) {
	writePlan();
	writePluginConfig();
	writeRetro();
	if (councilMode) enableCouncilMode();
}

beforeEach(() => {
	resetSwarmState();
	tempDir = mkdtempSync(join(tmpdir(), 'pc-council-'));
});

afterEach(() => {
	resetSwarmState();
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

describe('phase-council gate', () => {
	describe('council_mode=false (default)', () => {
		test('completes without phase-council evidence', async () => {
			setup(false);
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

	describe('council_mode=true with APPROVE verdict', () => {
		test('allows completion', async () => {
			setup(true);
			writePhaseCouncil({ verdict: 'APPROVE', quorumSize: 3, phaseNumber: 1 });
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

	describe('council_mode=true with REJECT verdict', () => {
		test('blocks with PHASE_COUNCIL_REJECTED', async () => {
			setup(true);
			writePhaseCouncil({ verdict: 'REJECT', quorumSize: 3, phaseNumber: 1 });
			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('PHASE_COUNCIL_REJECTED');
		});
	});

	describe('council_mode=true with unrecognized verdict', () => {
		test('blocks as PHASE_COUNCIL_INVALID', async () => {
			setup(true);
			writePhaseCouncil({ verdict: 'MAYBE', quorumSize: 3, phaseNumber: 1 });
			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('PHASE_COUNCIL_INVALID');
		});
	});

	describe('council_mode=true with CONCERNS verdict (default: phaseConcernsAllowComplete=true)', () => {
		test('allows completion despite CONCERNS (default config)', async () => {
			setup(true);
			writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
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

	describe('council_mode=true missing evidence', () => {
		test('returns PHASE_COUNCIL_REQUIRED', async () => {
			setup(true);
			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('PHASE_COUNCIL_REQUIRED');
			expect(parsed.phase_council_required).toBe(true);
		});
	});

	describe('council_mode=true stale timestamp', () => {
		test('blocks with PHASE_COUNCIL_STALE_EVIDENCE', async () => {
			setup(true);
			const staleTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
			writePhaseCouncil({
				verdict: 'APPROVE',
				quorumSize: 3,
				timestamp: staleTs,
				phaseNumber: 1,
			});
			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('PHASE_COUNCIL_STALE_EVIDENCE');
		});
	});

	describe('council_mode=true future timestamp', () => {
		test('blocks with PHASE_COUNCIL_FUTURE_TIMESTAMP', async () => {
			setup(true);
			const futureTs = new Date(Date.now() + 60 * 60 * 1000).toISOString();
			writePhaseCouncil({
				verdict: 'APPROVE',
				quorumSize: 3,
				timestamp: futureTs,
				phaseNumber: 1,
			});
			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('PHASE_COUNCIL_FUTURE_TIMESTAMP');
		});
	});

	describe('council_mode=true quorum < 3', () => {
		test('blocks with PHASE_COUNCIL_INSUFFICIENT_QUORUM', async () => {
			setup(true);
			writePhaseCouncil({ verdict: 'APPROVE', quorumSize: 2, phaseNumber: 1 });
			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('PHASE_COUNCIL_INSUFFICIENT_QUORUM');
		});
	});

	describe('council_mode=true wrong phase_number', () => {
		test('blocks with PHASE_COUNCIL_PHASE_MISMATCH', async () => {
			setup(true);
			writePhaseCouncil({ verdict: 'APPROVE', quorumSize: 3, phaseNumber: 2 });
			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('PHASE_COUNCIL_PHASE_MISMATCH');
		});
	});

	describe('council_mode=true with CONCERNS verdict and phaseConcernsAllowComplete=true (default)', () => {
		test('allows completion despite CONCERNS', async () => {
			setup(true);
			writePluginConfig({ council: { phaseConcernsAllowComplete: true } });
			writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
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

	describe('council_mode=true with CONCERNS verdict and phaseConcernsAllowComplete=false', () => {
		test('blocks with PHASE_COUNCIL_CONCERNS', async () => {
			setup(true);
			writePluginConfig({ council: { phaseConcernsAllowComplete: false } });
			writePhaseCouncil({ verdict: 'CONCERNS', quorumSize: 3, phaseNumber: 1 });
			const result = await executePhaseComplete(
				{ phase: 1, summary: 'test', sessionID: SESSION_ID },
				tempDir,
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('PHASE_COUNCIL_CONCERNS');
		});
	});
});
