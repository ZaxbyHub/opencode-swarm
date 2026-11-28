/**
 * Per-role task-gate inference in the phase_complete required-agents gate.
 *
 * The 2026-11-23 swarm_communication_debug phase_complete wedge: every Stage B
 * dispatch ran as a background delegation (no in-memory phase-aggregation
 * surface), and the docs participation receipt was missing — so
 * `agentsDispatched` was `[]` and the gate reported coder, reviewer,
 * test_engineer AND docs as missing, even though every phase task carried
 * full durable gate evidence. The all-or-nothing inference (every missing
 * role had to be task-gate inferable) never fired because docs alone is not.
 *
 * These tests pin the per-role contract:
 *  - task-gate-inferable roles (coder/reviewer/test_engineer) are cleared from
 *    the missing set independently of non-inferable roles (docs);
 *  - docs keeps its own durable-receipt check and stays reported as missing;
 *  - incomplete task evidence still fails the whole inference closed.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { seedStageBGates } from '../../helpers/task-workflow-evidence';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { phase_complete } = await import('../../../src/tools/phase-complete');
setDefaultTimeout(30_000);

let tempDir: string;
let originalCwd: string;

function writeRetroBundle(directory: string, phaseNumber: number): void {
	const retroDir = path.join(
		directory,
		'.swarm',
		'evidence',
		`retro-${phaseNumber}`,
	);
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify(
			{
				schema_version: '1.0.0',
				task_id: `retro-${phaseNumber}`,
				entries: [
					{
						task_id: `retro-${phaseNumber}`,
						type: 'retrospective',
						timestamp: new Date().toISOString(),
						agent: 'architect',
						verdict: 'pass',
						summary: 'Phase retrospective',
						metadata: {},
						phase_number: phaseNumber,
						total_tool_calls: 10,
						coder_revisions: 1,
						reviewer_rejections: 0,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
						task_count: 5,
						task_complexity: 'moderate',
						top_rejection_reasons: [],
						lessons_learned: ['Lesson 1'],
					},
				],
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
			null,
			2,
		),
	);
}

function writeGateEvidence(directory: string, phase: number): void {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', `${phase}`);
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'completion-verify.json'),
		JSON.stringify(
			{
				status: 'passed',
				tasksChecked: 1,
				tasksPassed: 1,
				tasksBlocked: 0,
				reason: 'All task identifiers found in source files',
			},
			null,
			2,
		),
	);
	fs.writeFileSync(
		path.join(evidenceDir, 'drift-verifier.json'),
		JSON.stringify(
			{
				schema_version: '1.0.0',
				task_id: 'drift-verifier',
				entries: [
					{
						task_id: 'drift-verifier',
						type: 'drift_verification',
						timestamp: new Date().toISOString(),
						agent: 'critic',
						verdict: 'approved',
						summary: 'Drift check passed',
					},
				],
			},
			null,
			2,
		),
	);
}

function writeConfig(options?: {
	requiredAgents?: string[];
	requireDocs?: boolean;
}): void {
	fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: options?.requiredAgents ?? [
					'coder',
					'reviewer',
					'test_engineer',
				],
				require_docs: options?.requireDocs ?? true,
				policy: 'enforce',
			},
		}),
	);
}

function writePlan(taskStatuses: Record<string, string>): void {
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify(
			{
				schema_version: '1.0.0',
				title: 'Per-role inference plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: Object.entries(taskStatuses).map(([id, status]) => ({
							id,
							phase: 1,
							status,
							description: `Task ${id}`,
						})),
					},
				],
			},
			null,
			2,
		),
	);
}

let restoreClock: Restore;

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: Date.now() });
	resetSwarmState();
	tempDir = canonicalMkdtemp('phase-inference-');
	originalCwd = process.cwd();
	process.chdir(tempDir);
	fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
	writeRetroBundle(tempDir, 1);
	writeGateEvidence(tempDir, 1);
	fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, 'src', 'setup.ts'),
		'export function setupProject() {}\n',
	);
});

afterEach(() => {
	restoreClock();
	process.chdir(originalCwd);
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
	resetSwarmState();
});

describe('per-role required-agents task-gate inference', () => {
	test('a missing non-inferable role (docs) no longer blocks inference for coder/reviewer/test_engineer', async () => {
		writeConfig({ requireDocs: true });
		writePlan({ '1.1': 'completed', '1.2': 'completed' });
		for (const taskId of ['1.1', '1.2']) {
			await seedStageBGates(tempDir, taskId);
		}
		// Session with NO agents dispatched (background-only dispatch shape).
		ensureAgentSession('sess1');

		const result = await phase_complete.execute({
			phase: 1,
			sessionID: 'sess1',
		});
		const parsed = JSON.parse(result);

		// The three task-gate-inferable roles are cleared; docs keeps its own
		// durable check and remains the only missing role.
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('incomplete');
		expect(parsed.reason).toBe('REQUIRED_AGENTS_MISSING');
		expect(parsed.agentsMissing).toEqual(['docs']);
		expect(parsed.message).toContain('missing required agents: docs');
		// The inference warning names exactly the cleared roles.
		const inferenceWarning = parsed.warnings?.find((w: string) =>
			w.includes('Agent dispatch fallback'),
		);
		expect(inferenceWarning).toBeDefined();
		expect(inferenceWarning).toContain('coder');
		expect(inferenceWarning).toContain('reviewer');
		expect(inferenceWarning).toContain('test_engineer');
	});

	test('inferable roles are cleared and a durable docs receipt completes the phase', async () => {
		writeConfig({ requireDocs: true });
		writePlan({ '1.1': 'completed' });
		await seedStageBGates(tempDir, '1.1');
		ensureAgentSession('sess1');
		// Docs participates through its durable participation store (the only
		// surface the docs check accepts — the background completion observer
		// writes it for background docs dispatches).
		const {
			observePhaseParticipationToolResult,
			reserveApprovedPhaseParticipation,
			resetPhaseParticipationForTests,
		} = await import('../../../src/evidence/phase-participation');
		await reserveApprovedPhaseParticipation({
			directory: tempDir,
			tool: 'Task',
			parentSessionId: 'sess1',
			callId: 'docs-call',
			args: { subagent_type: 'docs' },
			policy: { require_docs: true },
		});
		await observePhaseParticipationToolResult({
			directory: tempDir,
			tool: 'Task',
			parentSessionId: 'sess1',
			callId: 'docs-call',
			output: {
				output: 'Documentation was checked and updated.',
				metadata: { status: 'completed', sessionId: 'docs-child' },
			},
		});
		resetPhaseParticipationForTests();

		const result = await phase_complete.execute({
			phase: 1,
			sessionID: 'sess1',
		});
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe('success');
		expect(parsed.agentsMissing).toEqual([]);
		expect(parsed.warnings.some((w: string) => w.includes('docs'))).toBe(true);
	});

	test('incomplete task evidence still fails the inference closed for every inferable role', async () => {
		writeConfig({ requireDocs: true });
		// One task completed with full gates, one completed WITHOUT gate
		// evidence: the all-tasks evidence bar is not met, so nothing is
		// inferred. (A still-pending task is deliberately not used here —
		// it would additionally trip the unfinished-planned-tasks refusal
		// upstream of the required-agents gate, which would relabel the
		// outcome without exercising this gate's fail-closed path.)
		writePlan({ '1.1': 'completed', '1.2': 'completed' });
		await seedStageBGates(tempDir, '1.1');
		ensureAgentSession('sess1');

		const result = await phase_complete.execute({
			phase: 1,
			sessionID: 'sess1',
		});
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('incomplete');
		// All four roles stay missing (docs included) — no partial inference
		// from an incomplete task set.
		expect(parsed.agentsMissing).toEqual([
			'coder',
			'docs',
			'reviewer',
			'test_engineer',
		]);
		expect(
			parsed.warnings.some((w: string) =>
				w.includes('Agent dispatch fallback'),
			),
		).toBe(false);
	});
});
