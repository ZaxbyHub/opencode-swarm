import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	getOrCreateProfile,
	setGates,
	setGatesForIdentity,
} from '../../../src/db/qa-gate-profile';
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
const PLAN_IDENTITY = { swarm: PLAN_SWARM, title: PLAN_TITLE };

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

function writeHallucinationEvidence(
	dir: string,
	phase: number,
	verdict: 'approved' | 'rejected',
): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', String(phase));
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'hallucination-guard.json'),
		JSON.stringify({
			entries: [
				{
					type: 'hallucination-verification',
					verdict,
					summary: 'Hallucination check',
					timestamp: new Date().toISOString(),
				},
			],
		}),
	);
}

function enableHallucinationGate(dir: string): void {
	setGatesForIdentity(dir, PLAN_IDENTITY, { hallucination_guard: true });
}

describe('phase_complete — hallucination guard gate (Gate 3)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'phase-complete-hallucination-gate-'),
			),
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

	test('2. gate enabled + evidence missing → blocked HALLUCINATION_VERIFICATION_MISSING', async () => {
		enableHallucinationGate(tempDir);
		writeDriftEvidence(tempDir, 1, 'approved');
		// No hallucination-guard.json

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('HALLUCINATION_VERIFICATION_MISSING');
		expect(result.message).toContain('hallucination-guard.json');
	});

	test('3. gate enabled + APPROVED evidence → phase completes', async () => {
		enableHallucinationGate(tempDir);
		writeDriftEvidence(tempDir, 1, 'approved');
		writeHallucinationEvidence(tempDir, 1, 'approved');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(true);
	});

	test('4. gate enabled + rejected evidence → blocked HALLUCINATION_VERIFICATION_REJECTED', async () => {
		enableHallucinationGate(tempDir);
		writeDriftEvidence(tempDir, 1, 'approved');
		writeHallucinationEvidence(tempDir, 1, 'rejected');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('HALLUCINATION_VERIFICATION_REJECTED');
	});

	test('5. gate enabled + malformed JSON evidence → treated as missing, blocked', async () => {
		enableHallucinationGate(tempDir);
		writeDriftEvidence(tempDir, 1, 'approved');

		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'hallucination-guard.json'),
			'{ not valid json <<<',
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	test('6. gate enabled + turbo mode → gate skipped, phase completes', async () => {
		enableHallucinationGate(tempDir);
		writeDriftEvidence(tempDir, 1, 'approved');
		// No hallucination evidence — turbo should bypass

		swarmState.agentSessions.get('sess1')!.turboMode = true;

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(true);
	});

	test('7. legacy unbound rows fail closed before later gates run', async () => {
		const legacyPlanId = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(
			/[^a-zA-Z0-9-_]/g,
			'_',
		);
		getOrCreateProfile(tempDir, legacyPlanId);
		setGates(tempDir, legacyPlanId, { hallucination_guard: true });
		writeDriftEvidence(tempDir, 1, 'approved');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('DRIFT_VERIFICATION_IDENTITY_UNBOUND');
		expect(result.message).toMatch(/exact-bound/i);
	});

	test('8. gate enabled via session override only → blocked', async () => {
		// Spec-level gate is OFF (default)
		const profile = setGatesForIdentity(tempDir, PLAN_IDENTITY, {});
		expect(profile.gates.hallucination_guard).toBe(false);

		writeDriftEvidence(tempDir, 1, 'approved');
		// No hallucination evidence

		// Apply session override ratcheting gate ON
		const session = swarmState.agentSessions.get('sess1')!;
		session.qaGateSessionOverrides = { hallucination_guard: true };

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('HALLUCINATION_VERIFICATION_MISSING');
	});

	test('9. gate enabled + spec.md missing → still blocked (no spec.md exemption)', async () => {
		// Unlike drift-verifier, hallucination gate fires regardless of spec.md
		enableHallucinationGate(tempDir);
		writeDriftEvidence(tempDir, 1, 'approved');
		// No spec.md, no hallucination evidence

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('HALLUCINATION_VERIFICATION_MISSING');
	});
});
