import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import { resetSwarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

let tempDir: string;
const SESSION_ID = 'test-session-prov';

function writePlan() {
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	writeFileSync(
		join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			swarm: 'mega',
			title: 'Test Plan',
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

function writePluginConfig(extra: Record<string, unknown> = {}) {
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
			...extra,
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

function writeSpecMd() {
	writeFileSync(
		join(tempDir, '.swarm', 'spec.md'),
		'# Test Spec\n\n## FR-01\nFeature requirement 1.\n',
	);
}

function writeDriftEvidence(opts: {
	verdict: string;
	provenance?: {
		agent_name?: string;
		session_id?: string;
		captured_at?: string;
	};
}) {
	const evidencePath = join(tempDir, '.swarm', 'evidence', '1');
	mkdirSync(evidencePath, { recursive: true });
	writeFileSync(
		join(evidencePath, 'drift-verifier.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'drift-verifier-1',
			entries: [
				{
					task_id: 'drift-verifier-1',
					type: 'drift',
					timestamp: new Date().toISOString(),
					agent: 'critic',
					verdict: opts.verdict,
					summary: 'Drift check result',
					...(opts.provenance ? { provenance: opts.provenance } : {}),
				},
			],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		}),
	);
}

function writeCouncilEvidence(opts: {
	verdict: string;
	quorumSize?: number;
	provenance?: {
		agent_name?: string;
		session_id?: string;
		captured_at?: string;
	};
}) {
	const evidencePath = join(tempDir, '.swarm', 'evidence', '1');
	mkdirSync(evidencePath, { recursive: true });
	writeFileSync(
		join(evidencePath, 'phase-council.json'),
		JSON.stringify({
			entries: [
				{
					type: 'phase-council',
					phase_number: 1,
					scope: 'phase',
					timestamp: new Date().toISOString(),
					verdict: opts.verdict,
					quorumSize: opts.quorumSize ?? 5,
					phaseSummary: 'Test phase',
					requiredFixes: [],
					advisoryNotes: [],
					advisoryFindings: [],
					roundNumber: 1,
					allCriteriaMet: true,
					...(opts.provenance ? { provenance: opts.provenance } : {}),
				},
			],
		}),
	);
}

async function complete() {
	return JSON.parse(
		await executePhaseComplete(
			{ phase: 1, summary: 'test', sessionID: SESSION_ID },
			tempDir,
			tempDir,
		),
	);
}

beforeEach(() => {
	resetSwarmState();
	tempDir = mkdtempSync(join(tmpdir(), 'pc-drift-council-prov-'));
});

afterEach(() => {
	resetSwarmState();
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

describe('drift gate - provenance advisory', () => {
	test('drift evidence with provenance succeeds without warnings about provenance', async () => {
		writePlan();
		writeRetro();
		writePluginConfig();
		writeSpecMd();
		writeDriftEvidence({
			verdict: 'approved',
			provenance: {
				agent_name: 'critic_drift_verifier',
				session_id: 'sess-123',
				captured_at: new Date().toISOString(),
			},
		});
		const parsed = await complete();
		expect(parsed.success).toBe(true);
	});

	test('drift evidence without provenance still succeeds (advisory only)', async () => {
		writePlan();
		writeRetro();
		writePluginConfig();
		writeSpecMd();
		writeDriftEvidence({ verdict: 'approved' });
		const parsed = await complete();
		expect(parsed.success).toBe(true);
	});

	test('drift evidence with empty provenance object still succeeds (advisory only)', async () => {
		writePlan();
		writeRetro();
		writePluginConfig();
		writeSpecMd();
		writeDriftEvidence({ verdict: 'approved', provenance: {} });
		const parsed = await complete();
		expect(parsed.success).toBe(true);
	});
});

describe('phase-council gate - provenance advisory', () => {
	test('council evidence with provenance succeeds', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ council: { enabled: true } });
		writeCouncilEvidence({
			verdict: 'APPROVE',
			provenance: {
				agent_name: 'architect',
				session_id: 'sess-456',
				captured_at: new Date().toISOString(),
			},
		});
		const parsed = await complete();
		expect(parsed.success).toBe(true);
	});

	test('council evidence without provenance still succeeds (advisory only)', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ council: { enabled: true } });
		writeCouncilEvidence({ verdict: 'APPROVE' });
		const parsed = await complete();
		expect(parsed.success).toBe(true);
	});

	test('council evidence with empty provenance object still succeeds (advisory only)', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ council: { enabled: true } });
		writeCouncilEvidence({ verdict: 'APPROVE', provenance: {} });
		const parsed = await complete();
		expect(parsed.success).toBe(true);
	});
});
