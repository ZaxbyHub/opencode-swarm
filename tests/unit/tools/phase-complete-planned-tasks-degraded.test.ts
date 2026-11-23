/**
 * #3770 feedback round: degraded plan-ledger authorities must REFUSE, not
 * defer, so a corrupt/torn/resetting authority can never let phase_complete
 * succeed past unfinished planned tasks (review F-1 / R2-2), duplicate phase
 * ids must not hide unfinished tasks behind a first-match read (review R2-1),
 * and a normal completion (task completed via savePlan, phase already
 * derived-complete) must still record the durable phase_completed ledger
 * event (review F-2). Full-tool legs throughout; static ISO literals
 * (check:test-clock).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
// Spread-real-exports pattern (AGENTS.md invariant 7): capture the real
// modules BEFORE mock.module so the factories override only the entry
// points this suite fakes.
import * as actualCurator from '../../../src/hooks/curator';
import * as actualCuratorDrift from '../../../src/hooks/curator-drift';
import type { DriftReport } from '../../../src/hooks/curator-types';
import * as actualKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import { initLedger } from '../../../src/plan/ledger';
import { savePlan } from '../../../src/plan/manager';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../../src/state';
import {
	PLANNED_TASKS_BLOCKED_REASON,
	runPlannedTasksGate,
} from '../../../src/tools/phase-complete/gates/planned-tasks-gate';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

interface TaskFixture {
	id: string;
	status: string;
	description?: string;
}

function planWithTasks(tasks: TaskFixture[]): Record<string, unknown> {
	return {
		schema_version: '1.0.0',
		title: 'Planned Tasks Gate Test',
		swarm: 'mega',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: tasks.map((task) => ({
					id: task.id,
					phase: 1,
					status: task.status,
					description: task.description ?? 'done',
					size: 'small',
					depends: [],
					files_touched: [],
				})),
			},
		],
	};
}

const mockRunCuratorPhase = mock(async () => ({
	phase: 1,
	agents_dispatched: ['coder'],
	compliance: [],
	knowledge_recommendations: [],
	summary: 'Test curator phase result',
	timestamp: '2026-01-01T00:00:00.000Z',
}));

const mockApplyCuratorKnowledgeUpdates = mock(async () => ({
	applied: 0,
	skipped: 0,
}));

const mockRunDeterministicDriftCheck = mock(async () => ({
	phase: 1,
	report: {
		schema_version: 1 as const,
		phase: 1,
		timestamp: '2026-01-01T00:00:00.000Z',
		alignment: 'ALIGNED' as const,
		drift_score: 0,
		first_deviation: null,
		compounding_effects: [],
		corrections: [],
		requirements_checked: 0,
		requirements_satisfied: 0,
		scope_additions: [],
		injection_summary: '',
	},
	report_path: '',
	injection_text: '',
}));

const mockReadPriorDriftReports = mock(async (): Promise<DriftReport[]> => []);

mock.module('../../../src/hooks/curator', () => ({
	...actualCurator,
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

mock.module('../../../src/hooks/curator-drift', () => ({
	...actualCuratorDrift,
	runDeterministicDriftCheck: mockRunDeterministicDriftCheck,
	readPriorDriftReports: mockReadPriorDriftReports,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	...actualKnowledgeCurator,
	curateAndStoreSwarm: mock(async () => {}),
}));

const { phase_complete } = await import('../../../src/tools/phase-complete');

const STATIC_NOW = '2026-01-01T00:00:00.000Z';

interface TaskFixture {
	id: string;
	status: string;
}

function planFromPhases(phases: unknown[]): Record<string, unknown> {
	return {
		schema_version: '1.0.0',
		title: 'Degraded Authority Test',
		swarm: 'mega',
		current_phase: 1,
		phases,
	};
}

function phaseFixture(
	id: number,
	tasks: TaskFixture[],
): Record<string, unknown> {
	return {
		id,
		name: `Phase ${id}`,
		status: 'in_progress',
		tasks: tasks.map((task) => ({
			id: task.id,
			phase: id,
			status: task.status,
			description: 'done',
			size: 'small',
			depends: [],
			files_touched: [],
		})),
	};
}

function writeEvidenceFixtures(directory: string): void {
	const retroDir = path.join(directory, '.swarm', 'evidence', 'retro-1');
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'retro-1',
			entries: [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: STATIC_NOW,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					phase_number: 1,
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
			created_at: STATIC_NOW,
			updated_at: STATIC_NOW,
		}),
	);
	const evidenceDir = path.join(directory, '.swarm', 'evidence', '1');
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'completion-verify.json'),
		JSON.stringify({
			status: 'passed',
			tasksChecked: 1,
			tasksPassed: 1,
			tasksBlocked: 0,
			reason: 'All task identifiers found in source files',
		}),
	);
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
			},
			curator: { enabled: false, phase_enabled: true },
		}),
	);
}

function phaseCompleteCoreEventCount(directory: string): number {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return 0;
	return fs
		.readFileSync(eventsPath, 'utf-8')
		.split('\n')
		.filter((line) => line.includes('"phase_complete"') && line.trim()).length;
}

describe('#3770 degraded plan-ledger authorities refuse', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = canonicalMkdtemp('planned-tasks-degraded-');
		originalCwd = process.cwd();
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), {
			recursive: true,
		});
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		writeEvidenceFixtures(tempDir);
		ensureAgentSession('sess1');
		recordPhaseAgentDispatch('sess1', 'coder');
	});

	afterEach(() => {
		process.chdir(originalCwd);
		removeTreeWithRetry(tempDir);
		resetSwarmState();
		mock.restore();
	});

	async function execute(): Promise<Record<string, unknown>> {
		const raw = await phase_complete.execute({ phase: 1, sessionID: 'sess1' });
		return JSON.parse(raw) as Record<string, unknown>;
	}

	test('torn ledger tail refuses (fail closed) and writes nothing', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(
				planFromPhases([phaseFixture(1, [{ id: '1.1', status: 'completed' }])]),
			),
		);
		const ledgerPath = path.join(tempDir, '.swarm', 'plan-ledger.jsonl');
		fs.writeFileSync(
			ledgerPath,
			`${JSON.stringify({
				seq: 1,
				plan_id: 'mega-Degraded_Authority_Test',
				event_type: 'plan_created',
			})}\n{"seq":99,"event_type":"task_stat`,
		);
		const ledgerBefore = fs.readFileSync(ledgerPath, 'utf-8');
		const parsed = await execute();
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PLANNED_TASKS_UNKNOWN');
		expect(String(parsed.message)).toContain('Phase 1');
		// The refusal happens before any mutation: the torn ledger bytes are
		// untouched (pre-fix this call appended into the torn line).
		expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(ledgerBefore);
		expect(phaseCompleteCoreEventCount(tempDir)).toBe(0);
	});

	test('resetting marker refuses (fail closed)', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(
				planFromPhases([phaseFixture(1, [{ id: '1.1', status: 'pending' }])]),
			),
		);
		const ledgerPath = path.join(tempDir, '.swarm', 'plan-ledger.jsonl');
		fs.writeFileSync(
			ledgerPath,
			`${JSON.stringify({
				seq: 1,
				plan_id: 'mega-Degraded_Authority_Test',
				event_type: 'plan_created',
			})}\n`,
		);
		fs.writeFileSync(path.join(tempDir, '.swarm', 'plan-ledger.resetting'), '');
		const parsed = await execute();
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PLANNED_TASKS_UNKNOWN');
		expect(phaseCompleteCoreEventCount(tempDir)).toBe(0);
	});

	test('duplicate phase ids in plan.json refuse (first-match cannot hide tasks)', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(
				planFromPhases([
					phaseFixture(1, [{ id: '1.1', status: 'completed' }]),
					phaseFixture(1, [{ id: '1.9', status: 'pending' }]),
				]),
			),
		);
		const parsed = await execute();
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PLANNED_TASKS_UNKNOWN');
		expect(String(parsed.message)).toContain('2 phases with id 1');
	});

	test('duplicate phase ids in the ledger refuse', async () => {
		const duplicatePlan = planFromPhases([
			phaseFixture(1, [{ id: '1.1', status: 'completed' }]),
			phaseFixture(1, [{ id: '1.9', status: 'pending' }]),
		]) as unknown as Parameters<typeof initLedger>[3];
		await initLedger(
			tempDir,
			'mega-Degraded_Authority_Test',
			undefined,
			duplicatePlan,
		);
		const parsed = await execute();
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('PLANNED_TASKS_UNKNOWN');
	});

	test('normal-flow completion records the phase_completed ledger event (review F-2)', async () => {
		// The realistic normal flow: the task is completed through savePlan
		// (update_task_status), the savePlan projection derives the phase as
		// complete, and only then does phase_complete run.
		const planPath = path.join(tempDir, '.swarm', 'plan.json');
		fs.writeFileSync(
			planPath,
			JSON.stringify(
				planFromPhases([phaseFixture(1, [{ id: '1.1', status: 'pending' }])]),
			),
		);
		const staged = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as {
			phases: { tasks: { status: string }[] }[];
		};
		staged.phases[0]!.tasks[0]!.status = 'completed';
		await savePlan(tempDir, staged as never);
		recordPhaseAgentDispatch('sess1', 'coder');
		const first = await execute();
		expect(first.success).toBe(true);
		const ledgerPath = path.join(tempDir, '.swarm', 'plan-ledger.jsonl');
		const ledger = fs.readFileSync(ledgerPath, 'utf-8');
		const eventLines = ledger
			.split('\n')
			.filter((line) => line.includes('"phase_completed"'));
		expect(eventLines.length).toBe(1);
		// The core completion event keys on the transition (root digest +
		// seq), not the no-event fallback namespace.
		const coreLines = fs
			.readFileSync(path.join(tempDir, '.swarm', 'events.jsonl'), 'utf-8')
			.split('\n')
			.filter((line) => line.includes('"phase_complete"'));
		expect(coreLines.length).toBe(1);
		expect(coreLines[0]).toContain('completionIdentity');
		expect(coreLines[0]).not.toContain(':none');
		expect(coreLines[0]).not.toContain('noledger:');
		// Repeat call: the durable event already exists — exactly-once holds.
		recordPhaseAgentDispatch('sess1', 'coder');
		const second = await execute();
		expect(second.success).toBe(true);
		expect(
			fs
				.readFileSync(ledgerPath, 'utf-8')
				.split('\n')
				.filter((line) => line.includes('"phase_completed"')).length,
		).toBe(1);
		expect(phaseCompleteCoreEventCount(tempDir)).toBe(1);
	});
});

// Direct gate-layer unit legs (moved from the refusal suite for FR-006).
describe('#3770 planned-tasks gate layer (direct unit legs)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = canonicalMkdtemp('planned-tasks-gate-unit-');
		originalCwd = process.cwd();
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		removeTreeWithRetry(tempDir);
		resetSwarmState();
		mock.restore();
	});

	test('gate refuses on its own with pending tasks (no early refusal involved)', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(
				planWithTasks([
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'pending' },
				]),
			),
		);
		const result = await runPlannedTasksGate({
			phase: 1,
			dir: tempDir,
			sessionID: 'sess-gate',
			pluginConfig: {} as never,
			agentsDispatched: [],
			safeWarn: () => undefined,
			preflightNowMs: 0,
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe(PLANNED_TASKS_BLOCKED_REASON);
		expect(result.message).toContain('1.2');
	});

	test('gate passes on its own with completed/closed tasks', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(
				planWithTasks([
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'closed' },
				]),
			),
		);
		const result = await runPlannedTasksGate({
			phase: 1,
			dir: tempDir,
			sessionID: 'sess-gate',
			pluginConfig: {} as never,
			agentsDispatched: [],
			safeWarn: () => undefined,
			preflightNowMs: 0,
		});
		expect(result.blocked).toBe(false);
	});
});
