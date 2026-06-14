/**
 * End-to-end pipeline integration test for the mutation gate workflow.
 *
 * Tests the complete pipeline from gate evaluation through evidence persistence
 * to phase_complete enforcement:
 *
 *   evaluateMutationGate (from MutationReport)
 *     → executeWriteMutationEvidence (real path validation, no mocks)
 *     → phase_complete Gate 4 enforcement
 *
 * This test validates that:
 *  - The verdict produced by evaluateMutationGate is in the correct format for
 *    write_mutation_evidence to consume
 *  - The evidence file written by executeWriteMutationEvidence matches the
 *    exact schema that phase_complete reads
 *  - All four gate outcomes (pass/warn/fail/skip) flow correctly end-to-end
 *  - Error paths (missing/corrupted evidence) block phase_complete correctly
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	getOrCreateProfile,
	setGates,
} from '../../../src/db/qa-gate-profile.js';
import {
	computeReport,
	type MutationResult,
} from '../../../src/mutation/engine.js';
import { evaluateMutationGate } from '../../../src/mutation/gate.js';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state.js';
import { executeWriteMutationEvidence } from '../../../src/tools/write-mutation-evidence.js';

const { phase_complete } = await import('../../../src/tools/phase-complete.js');

// planId must match what loadPlan derives: "${swarm}-${title}".replace(...)
const PLAN_SWARM = 'mega';
const PLAN_TITLE = 'E2E Pipeline Test';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');

// ─── Setup helpers (mirroring phase-complete.mutation-gate.test.ts pattern) ──

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
					{ id: '1.1', phase: 1, status: 'pending', description: 'Test task' },
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

// ─── Test data builder ────────────────────────────────────────────────────────

/**
 * Build a MutationReport with a controlled kill count out of `total`.
 */
function buildReport(
	killed: number,
	total: number,
): ReturnType<typeof computeReport> {
	const results: MutationResult[] = [];
	for (let i = 0; i < killed; i++) {
		results.push({
			patchId: `mut-killed-${i}`,
			filePath: 'src/foo.ts',
			functionName: 'foo',
			mutationType: 'off-by-one',
			outcome: 'killed',
			durationMs: 100,
		});
	}
	for (let i = killed; i < total; i++) {
		results.push({
			patchId: `mut-survived-${i}`,
			filePath: 'src/foo.ts',
			functionName: 'foo',
			mutationType: 'off-by-one',
			outcome: 'survived',
			durationMs: 100,
		});
	}
	return computeReport(results, 1000);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('mutation gate pipeline — E2E integration', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-e2e-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		setupSwarmDir(tempDir);
		writeRetroBundle(tempDir, 1);
		writeDriftEvidence(tempDir, 1, 'approved');

		ensureAgentSession('sess-e2e');
		recordPhaseAgentDispatch('sess-e2e', 'coder');
		swarmState.agentSessions.get('sess-e2e')!.turboMode = false;

		// Enable mutation gate in the QA profile
		getOrCreateProfile(tempDir, PLAN_ID);
		setGates(tempDir, PLAN_ID, { mutation_test: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
		closeAllProjectDbs();
		resetSwarmState();
	});

	/**
	 * Happy path: high kill rate → pass verdict → evidence written → phase completes.
	 */
	test('pass verdict: high kill rate flows through to phase_complete success', async () => {
		// Step 1: Evaluate gate (simulating output from mutation_test)
		const report = buildReport(10, 10); // 100% kill rate
		const gate = evaluateMutationGate(report, 0.8, 0.6);
		expect(gate.verdict).toBe('pass');

		// Step 2: Write evidence using real executeWriteMutationEvidence
		const evResult = JSON.parse(
			await executeWriteMutationEvidence(
				{
					phase: 1,
					verdict: 'PASS',
					killRate: gate.killRate,
					adjustedKillRate: gate.adjustedKillRate,
					summary: gate.message,
				},
				tempDir,
			),
		);
		expect(evResult.success).toBe(true);
		expect(evResult.verdict).toBe('pass');

		// Step 3: Confirm the file exists and has the right shape
		const evidencePath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'1',
			'mutation-gate.json',
		);
		expect(fs.existsSync(evidencePath)).toBe(true);
		const raw = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
		expect(raw.entries[0].type).toBe('mutation-gate');
		expect(raw.entries[0].verdict).toBe('pass');

		// Step 4: phase_complete should succeed
		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess-e2e' }),
		);
		expect(result.success).toBe(true);
	});

	/**
	 * Warn path: medium kill rate → warn verdict → phase completes (non-blocking).
	 */
	test('warn verdict: medium kill rate is non-blocking for phase_complete', async () => {
		// 7/10 = 70% — above warn threshold (60%) but below pass threshold (80%)
		const report = buildReport(7, 10);
		const gate = evaluateMutationGate(report, 0.8, 0.6);
		expect(gate.verdict).toBe('warn');

		await executeWriteMutationEvidence(
			{
				phase: 1,
				verdict: 'WARN',
				killRate: gate.killRate,
				adjustedKillRate: gate.adjustedKillRate,
				summary: gate.message,
			},
			tempDir,
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess-e2e' }),
		);
		expect(result.success).toBe(true);
	});

	/**
	 * Fail path: low kill rate → fail verdict → phase_complete blocks.
	 */
	test('fail verdict: low kill rate causes phase_complete to block with MUTATION_GATE_FAIL', async () => {
		// 4/10 = 40% — below warn threshold (60%) = fail
		const report = buildReport(4, 10);
		const gate = evaluateMutationGate(report, 0.8, 0.6);
		expect(gate.verdict).toBe('fail');

		await executeWriteMutationEvidence(
			{
				phase: 1,
				verdict: 'FAIL',
				killRate: gate.killRate,
				adjustedKillRate: gate.adjustedKillRate,
				summary: gate.message,
				survivedMutants: JSON.stringify(
					gate.survivedMutants.map((m) => m.patchId),
				),
			},
			tempDir,
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess-e2e' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('MUTATION_GATE_FAIL');
		expect(result.message).toContain("returned verdict 'fail'");
	});

	/**
	 * Skip path: no mutants generated → SKIP verdict → phase_complete succeeds.
	 */
	test('skip verdict: no-op mutation run allows phase_complete to proceed', async () => {
		await executeWriteMutationEvidence(
			{
				phase: 1,
				verdict: 'SKIP',
				summary: 'No functions identified for mutation testing in this phase',
			},
			tempDir,
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess-e2e' }),
		);
		expect(result.success).toBe(true);
	});

	/**
	 * Missing evidence: gate enabled but no evidence written → blocked MUTATION_GATE_MISSING.
	 */
	test('missing evidence: gate enabled but no mutation-gate.json → blocked MUTATION_GATE_MISSING', async () => {
		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess-e2e' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('MUTATION_GATE_MISSING');
		expect(result.message).toContain('mutation-gate.json');
	});

	/**
	 * Corrupted evidence: malformed JSON → treated as missing evidence.
	 */
	test('corrupted evidence: malformed JSON in mutation-gate.json → blocked MUTATION_GATE_MISSING', async () => {
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'mutation-gate.json'),
			'{ this is not valid JSON <<<',
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess-e2e' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('MUTATION_GATE_MISSING');
	});

	/**
	 * Evidence format contract: verify the exact schema fields that phase_complete reads.
	 * This documents and enforces the data contract between the two components.
	 */
	test('evidence format contract: entries[0].type and verdict fields are correctly written and read', async () => {
		await executeWriteMutationEvidence(
			{
				phase: 1,
				verdict: 'PASS',
				killRate: 0.9,
				adjustedKillRate: 0.92,
				summary: 'Excellent mutation coverage',
			},
			tempDir,
		);

		// These are the exact fields phase_complete / mutation-gate.ts reads
		const evidencePath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'1',
			'mutation-gate.json',
		);
		const content = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));

		expect(content.entries).toHaveLength(1);
		expect(content.entries[0].type).toBe('mutation-gate'); // exact string match required
		expect(content.entries[0].verdict).toBe('pass'); // lowercase normalized verdict
		expect(content.entries[0].killRate).toBe(0.9);
		expect(content.entries[0].adjustedKillRate).toBe(0.92);
		expect(typeof content.entries[0].timestamp).toBe('string');
		expect(typeof content.entries[0].summary).toBe('string');
	});
});
