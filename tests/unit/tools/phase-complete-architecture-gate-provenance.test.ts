import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import { resetSwarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

let tempDir: string;

const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'test-plan';
const SESSION_ID = 'test-session-provenance';

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

function writePluginConfig(arch: Record<string, unknown> | undefined) {
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
			...(arch ? { architectural_supervision: arch } : {}),
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

/** Write the supervisor sidecar directly (raw shape) so edge cases are exact. */
function writeSupervisorSidecar(opts: {
	dirPhase?: number;
	phaseNumber?: number;
	verdict: string;
	timestamp?: string;
	findings?: Array<{ description: string }>;
	provenance?: {
		agent_name?: string;
		session_id?: string;
		captured_at?: string;
	};
}) {
	const dirPhase = opts.dirPhase ?? 1;
	const evidencePath = join(tempDir, '.swarm', 'evidence', String(dirPhase));
	mkdirSync(evidencePath, { recursive: true });
	writeFileSync(
		join(evidencePath, 'architecture-supervisor.json'),
		JSON.stringify({
			entries: [
				{
					type: 'architecture-supervisor',
					phase_number: opts.phaseNumber ?? 1,
					scope: 'phase',
					timestamp: opts.timestamp ?? new Date().toISOString(),
					verdict: opts.verdict,
					findings: opts.findings ?? [],
					knowledge_recommendations: [],
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
	tempDir = mkdtempSync(join(tmpdir(), 'pc-arch-prov-'));
});

afterEach(() => {
	resetSwarmState();
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

describe('architecture supervision gate - provenance verification', () => {
	test('gate mode allows evidence with valid provenance', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		writeSupervisorSidecar({
			verdict: 'APPROVE',
			provenance: {
				agent_name: 'critic_architecture_supervisor',
				session_id: 'test-session-123',
				captured_at: new Date().toISOString(),
			},
		});
		const parsed = await complete();
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});

	test('gate mode warns when provenance is missing (default behavior)', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		writeSupervisorSidecar({ verdict: 'APPROVE' });
		const parsed = await complete();
		expect(parsed.success).toBe(true);
		// Check that warnings contain provenance-related message
		const warningStr = JSON.stringify(parsed.warnings ?? []);
		expect(warningStr.toLowerCase()).toContain('provenance');
	});

	test('gate mode with provenance_verify enabled blocks when provenance is missing', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({
			enabled: true,
			mode: 'gate',
			provenance_verify: true,
		});
		writeSupervisorSidecar({ verdict: 'APPROVE' });
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_MISSING_PROVENANCE');
	});

	test('gate mode with provenance_verify enabled allows evidence with agent_name', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({
			enabled: true,
			mode: 'gate',
			provenance_verify: true,
		});
		writeSupervisorSidecar({
			verdict: 'APPROVE',
			provenance: {
				agent_name: 'critic_architecture_supervisor',
			},
		});
		const parsed = await complete();
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});

	test('gate mode with provenance_verify enabled allows evidence with session_id', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({
			enabled: true,
			mode: 'gate',
			provenance_verify: true,
		});
		writeSupervisorSidecar({
			verdict: 'APPROVE',
			provenance: {
				session_id: 'test-session-123',
			},
		});
		const parsed = await complete();
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});

	test('gate mode with provenance_verify enabled allows evidence with both agent_name and session_id', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({
			enabled: true,
			mode: 'gate',
			provenance_verify: true,
		});
		writeSupervisorSidecar({
			verdict: 'APPROVE',
			provenance: {
				agent_name: 'critic_architecture_supervisor',
				session_id: 'test-session-123',
				captured_at: new Date().toISOString(),
			},
		});
		const parsed = await complete();
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});

	test('gate mode with provenance_verify enabled blocks empty provenance object', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({
			enabled: true,
			mode: 'gate',
			provenance_verify: true,
		});
		writeSupervisorSidecar({
			verdict: 'APPROVE',
			provenance: {},
		});
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_MISSING_PROVENANCE');
	});

	test('advisory mode with provenance_verify still allows missing provenance', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({
			enabled: true,
			mode: 'advisory',
			provenance_verify: true,
		});
		writeSupervisorSidecar({ verdict: 'APPROVE' });
		const parsed = await complete();
		expect(parsed.success).toBe(true);
	});
});
