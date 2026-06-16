import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeAllProjectDbs } from '../../../src/db/project-db';
import { getOrCreateProfile, setGates } from '../../../src/db/qa-gate-profile';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

const { phase_complete } = await import('../../../src/tools/phase-complete');

// planId must match what loadPlan derives: "${swarm}-${title}".replace(...)
const PLAN_SWARM = 'mega';
const PLAN_TITLE = 'Test Plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');

function setupSwarmDir(dir: string): void {
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });

	const planJson = {
		schema_version: '1.0.0',
		title: PLAN_TITLE,
		swarm: PLAN_SWARM,
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						description: 'Test task',
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(planJson, null, 2),
	);

	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
			},
			curator: { enabled: false },
		}),
	);
}

function writeRetroBundle(dir: string, phase: number): void {
	const retroDir = path.join(dir, '.swarm', 'evidence', `retro-${phase}`);
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: phase,
					total_tool_calls: 10,
					coder_revisions: 1,
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
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		}),
	);
}

function writeDriftEvidence(
	dir: string,
	phase: number,
	verdict: 'approved' | 'rejected' = 'approved',
): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', String(phase));
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'drift-verifier.json'),
		JSON.stringify({
			entries: [
				{
					type: 'drift-verification',
					verdict,
					summary: 'Drift check',
					timestamp: new Date().toISOString(),
				},
			],
		}),
	);
}

function writeMutationEvidence(
	dir: string,
	phase: number,
	verdict: string,
): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', String(phase));
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'mutation-gate.json'),
		JSON.stringify({
			entries: [
				{
					type: 'mutation-gate',
					verdict,
					killRate: 0.85,
					adjustedKillRate: 0.87,
					summary: 'Mutation gate check',
					timestamp: new Date().toISOString(),
				},
			],
		}),
	);
}

describe('phase_complete — mutation gate (Gate 4)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-mutation-gate-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		setupSwarmDir(tempDir);
		writeRetroBundle(tempDir, 1);

		ensureAgentSession('sess1');
		recordPhaseAgentDispatch('sess1', 'coder');
		swarmState.agentSessions.get('sess1')!.turboMode = false;
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		closeAllProjectDbs();
		resetSwarmState();
	});

	test('1. gate disabled (default) + no evidence → phase completes (gate skipped)', async () => {
		// No QA profile created at all → gate reads profile=null → skips
		writeDriftEvidence(tempDir, 1, 'approved');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(true);
	});

	test('2. gate enabled + evidence missing (ENOENT) → blocked MUTATION_GATE_MISSING', async () => {
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { mutation_test: true });
		writeDriftEvidence(tempDir, 1, 'approved');
		// No mutation-gate.json written

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('MUTATION_GATE_MISSING');
		expect(result.message).toContain('mutation-gate.json');
	});

	test('3. gate enabled + pass verdict → phase completes', async () => {
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { mutation_test: true });
		writeDriftEvidence(tempDir, 1, 'approved');
		writeMutationEvidence(tempDir, 1, 'pass');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(true);
	});

	test('4. gate enabled + warn verdict → non-blocking, phase completes', async () => {
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { mutation_test: true });
		writeDriftEvidence(tempDir, 1, 'approved');
		writeMutationEvidence(tempDir, 1, 'warn');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(true);
	});

	test('5. gate enabled + skip verdict → phase completes', async () => {
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { mutation_test: true });
		writeDriftEvidence(tempDir, 1, 'approved');
		writeMutationEvidence(tempDir, 1, 'skip');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(true);
	});

	test('6. gate enabled + fail verdict → blocked MUTATION_GATE_FAIL', async () => {
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { mutation_test: true });
		writeDriftEvidence(tempDir, 1, 'approved');
		writeMutationEvidence(tempDir, 1, 'fail');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('MUTATION_GATE_FAIL');
		expect(result.message).toContain("returned verdict 'fail'");
	});

	test('7. gate enabled + unrecognized verdict → blocked MUTATION_GATE_FAIL', async () => {
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { mutation_test: true });
		writeDriftEvidence(tempDir, 1, 'approved');
		// 'PASSED' is uppercase/unrecognized — fails closed
		writeMutationEvidence(tempDir, 1, 'PASSED');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('MUTATION_GATE_FAIL');
		expect(result.message).toContain('unrecognized verdict');
	});

	test('8. gate enabled + malformed JSON → blocked MUTATION_GATE_MISSING', async () => {
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { mutation_test: true });
		writeDriftEvidence(tempDir, 1, 'approved');

		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'mutation-gate.json'),
			'{ not valid json <<<',
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('MUTATION_GATE_MISSING');
	});

	test('9. gate enabled + wrong entry type (substring match rejected) → blocked MUTATION_GATE_MISSING', async () => {
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { mutation_test: true });
		writeDriftEvidence(tempDir, 1, 'approved');

		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'mutation-gate.json'),
			JSON.stringify({
				entries: [
					{
						// 'pre-mutation-check' contains 'mutation' as substring but is NOT 'mutation-gate'
						// This test proves exact-match guard: substring alone must NOT satisfy the gate
						type: 'pre-mutation-check',
						verdict: 'pass',
						summary: 'Not a canonical mutation-gate entry',
						timestamp: new Date().toISOString(),
					},
				],
			}),
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('MUTATION_GATE_MISSING');
	});

	test('10. gate enabled + turbo mode → gate skipped, phase completes', async () => {
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { mutation_test: true });
		writeDriftEvidence(tempDir, 1, 'approved');
		// No mutation evidence — turbo should bypass

		swarmState.agentSessions.get('sess1')!.turboMode = true;

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(true);
	});

	test('11. gate enabled via session override only (no DB profile gate) → blocked MUTATION_GATE_MISSING', async () => {
		// Spec-level gate is OFF (default)
		const profile = getOrCreateProfile(tempDir, PLAN_ID);
		expect(profile.gates.mutation_test).toBe(false);

		writeDriftEvidence(tempDir, 1, 'approved');
		// No mutation-gate.json written — session override must still enforce the gate

		// Apply session override ratcheting gate ON (bypasses DB profile gate flag)
		const session = swarmState.agentSessions.get('sess1')!;
		session.qaGateSessionOverrides = { mutation_test: true };

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('MUTATION_GATE_MISSING');
	});
});
