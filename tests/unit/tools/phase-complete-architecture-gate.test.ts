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
const SESSION_ID = 'test-session-arch';

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
	tempDir = mkdtempSync(join(tmpdir(), 'pc-arch-gate-'));
});

afterEach(() => {
	resetSwarmState();
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

describe('architecture supervision gate', () => {
	test('advisory mode does not block even without supervisor evidence', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'advisory' });
		const parsed = await complete();
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});

	test('disabled feature does not block', async () => {
		writePlan();
		writeRetro();
		writePluginConfig(undefined);
		const parsed = await complete();
		expect(parsed.success).toBe(true);
	});

	test('gate mode blocks when supervisor evidence is missing', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_REQUIRED');
	});

	test('gate mode blocks on REJECT', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		writeSupervisorSidecar({ verdict: 'REJECT' });
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_REJECTED');
	});

	test('gate mode allows APPROVE', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		writeSupervisorSidecar({ verdict: 'APPROVE' });
		const parsed = await complete();
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
	});

	test('gate mode allows CONCERNS by default', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		writeSupervisorSidecar({ verdict: 'CONCERNS' });
		const parsed = await complete();
		expect(parsed.success).toBe(true);
	});

	test('gate mode blocks CONCERNS when allow_concerns_to_complete is false', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({
			enabled: true,
			mode: 'gate',
			allow_concerns_to_complete: false,
		});
		writeSupervisorSidecar({ verdict: 'CONCERNS' });
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_CONCERNS');
	});

	test('gate mode blocks on an invalid timestamp', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		writeSupervisorSidecar({ verdict: 'APPROVE', timestamp: 'not-a-date' });
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_INVALID_TIMESTAMP');
	});

	test('gate mode blocks on a future timestamp', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		writeSupervisorSidecar({ verdict: 'APPROVE', timestamp: future });
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_FUTURE_TIMESTAMP');
	});

	test('REJECT block message surfaces finding descriptions', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		writeSupervisorSidecar({
			verdict: 'REJECT',
			findings: [{ description: 'redis vs in-memory store contradiction' }],
		});
		const parsed = await complete();
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_REJECTED');
		expect(parsed.message).toContain('redis vs in-memory store contradiction');
	});

	test('gate mode blocks on stale evidence', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		writeSupervisorSidecar({ verdict: 'APPROVE', timestamp: old });
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_STALE_EVIDENCE');
	});

	test('gate mode blocks on phase mismatch', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		writeSupervisorSidecar({ dirPhase: 1, phaseNumber: 2, verdict: 'APPROVE' });
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_PHASE_MISMATCH');
	});

	test('gate mode blocks on unrecognized verdict', async () => {
		writePlan();
		writeRetro();
		writePluginConfig({ enabled: true, mode: 'gate' });
		writeSupervisorSidecar({ verdict: 'MAYBE' });
		const parsed = await complete();
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('ARCH_SUPERVISOR_INVALID');
	});
});
