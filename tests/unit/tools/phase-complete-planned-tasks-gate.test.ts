/**
 * #3770: phase_complete refuses completion while planned tasks are unfinished
 * (early, non-mutating, ledger-correct) and the phase_complete core event is
 * exactly-once under duplicates, crash-retry, reopen+re-complete, unrelated
 * later writes, concurrency, and ledger re-roots.
 *
 * Static ISO literals throughout (check:test-clock): fixtures never need a
 * real clock.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DriftReport } from '../../../src/hooks/curator-types';
import {
	appendLedgerEvent,
	computePlanLedgerHash,
	initLedger,
	replacePlanLedgerWithRoot,
} from '../../../src/plan/ledger';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

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
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

mock.module('../../../src/hooks/curator-drift', () => ({
	runDeterministicDriftCheck: mockRunDeterministicDriftCheck,
	readPriorDriftReports: mockReadPriorDriftReports,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mock(async () => {}),
}));

const { phase_complete } = await import('../../../src/tools/phase-complete');
const { readUnfinishedPlannedTasks } = await import(
	'../../../src/tools/phase-complete/gates/planned-tasks-gate.js'
);

const STATIC_NOW = '2026-01-01T00:00:00.000Z';

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

function writeRetroBundle(directory: string): void {
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
}

function writeCompletionVerify(directory: string): void {
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
}

function snapshotSwarmTree(directory: string): Map<string, string> {
	const snapshot = new Map<string, string>();
	const walk = (current: string): void => {
		if (!fs.existsSync(current)) return;
		for (const entry of fs.readdirSync(current)) {
			const child = path.join(current, entry);
			const stat = fs.statSync(child);
			if (stat.isDirectory()) walk(child);
			else snapshot.set(child, fs.readFileSync(child, 'utf-8'));
		}
	};
	walk(path.join(directory, '.swarm'));
	return snapshot;
}

function phaseCompleteEventLines(directory: string): string[] {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, 'utf-8')
		.split('\n')
		.filter(
			(line) => line.includes('"phase_complete"') && line.trim().length > 0,
		);
}

describe('#3770 planned-tasks refusal', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = canonicalMkdtemp('planned-tasks-gate-');
		originalCwd = process.cwd();
		process.chdir(tempDir);
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), {
			recursive: true,
		});
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		writeRetroBundle(tempDir);
		writeCompletionVerify(tempDir);
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
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

	test('pending task: both calls refused with the task ID, zero writes, plan.md never created', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(
				planWithTasks([
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'pending' },
				]),
			),
		);
		const before = snapshotSwarmTree(tempDir);
		const first = await execute();
		recordPhaseAgentDispatch('sess1', 'coder');
		const second = await execute();
		for (const [label, parsed] of [
			['first', first],
			['second', second],
		] as const) {
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('PLANNED_TASKS_PENDING');
			expect(String(parsed.message)).toContain('1.2');
		}
		expect(treesEqual(before, snapshotSwarmTree(tempDir))).toBe(true);
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'plan.md'))).toBe(false);
		expect(phaseCompleteEventLines(tempDir).length).toBe(0);
	});

	test('in_progress and blocked task statuses also refuse', async () => {
		for (const status of ['in_progress', 'blocked']) {
			fs.rmSync(path.join(tempDir, '.swarm', 'plan.json'), { force: true });
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(
					planWithTasks([
						{ id: '1.1', status: 'completed' },
						{ id: '1.2', status },
					]),
				),
			);
			const parsed = await execute();
			expect(parsed.reason).toBe('PLANNED_TASKS_PENDING');
			expect(String(parsed.message)).toContain('1.2');
			recordPhaseAgentDispatch('sess1', 'coder');
		}
	});

	test('completed and closed tasks pass; empty task list passes', async () => {
		for (const tasks of [
			[
				{ id: '1.1', status: 'completed' },
				{ id: '1.2', status: 'closed' },
			],
			[],
		]) {
			fs.rmSync(path.join(tempDir, '.swarm', 'plan.json'), { force: true });
			fs.rmSync(path.join(tempDir, '.swarm', 'plan-ledger.jsonl'), {
				force: true,
			});
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planWithTasks(tasks)),
			);
			const parsed = await execute();
			expect(parsed.success).toBe(true);
			recordPhaseAgentDispatch('sess1', 'coder');
		}
	});

	test('missing or malformed plan defers the early refusal', async () => {
		fs.writeFileSync(path.join(tempDir, '.swarm', 'plan.json'), '{"broken":');
		const parsed = await execute();
		expect(parsed.reason).not.toBe('PLANNED_TASKS_PENDING');
	});

	test('truncated ledger defers in both projection directions without mutation', async () => {
		// Direction 1: projection shows COMPLETED tasks.
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(planWithTasks([{ id: '1.1', status: 'completed' }])),
		);
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan-ledger.jsonl'),
			'{"seq":1,"broken"\n',
		);
		const beforeCompleted = snapshotSwarmTree(tempDir);
		expect(await readUnfinishedPlannedTasks(tempDir, 1)).toBeNull();
		expect(treesEqual(beforeCompleted, snapshotSwarmTree(tempDir))).toBe(true);
		// Direction 2: projection shows PENDING tasks (a corrupt authority may
		// hold the opposite truth — the helper must defer, not decide).
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(planWithTasks([{ id: '1.1', status: 'pending' }])),
		);
		const beforePending = snapshotSwarmTree(tempDir);
		expect(await readUnfinishedPlannedTasks(tempDir, 1)).toBeNull();
		expect(treesEqual(beforePending, snapshotSwarmTree(tempDir))).toBe(true);
	});

	test('ledger-ahead-completed passes (stale pending projection)', async () => {
		const pendingPlan = planWithTasks([
			{ id: '1.1', status: 'pending' },
		]) as unknown as Parameters<typeof initLedger>[3];
		await initLedger(
			tempDir,
			'mega-Planned_Tasks_Gate_Test',
			undefined,
			pendingPlan,
		);
		const completedPlan = planWithTasks([{ id: '1.1', status: 'completed' }]);
		await appendLedgerEvent(
			tempDir,
			{
				plan_id: 'mega-Planned_Tasks_Gate_Test',
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'completed',
				source: 'test',
			},
			{
				planHashAfter: computePlanLedgerHash(completedPlan as never),
			},
		);
		const parsed = await execute();
		expect(parsed.reason).not.toBe('PLANNED_TASKS_PENDING');
	});

	test('ledger-ahead-pending refuses (stale completed projection)', async () => {
		const completedPlan = planWithTasks([
			{ id: '1.1', status: 'completed' },
		]) as unknown as Parameters<typeof initLedger>[3];
		await initLedger(
			tempDir,
			'mega-Planned_Tasks_Gate_Test',
			undefined,
			completedPlan,
		);
		const pendingPlan = planWithTasks([{ id: '1.1', status: 'pending' }]);
		await appendLedgerEvent(
			tempDir,
			{
				plan_id: 'mega-Planned_Tasks_Gate_Test',
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'completed',
				to_status: 'pending',
				source: 'test',
			},
			{
				planHashAfter: computePlanLedgerHash(pendingPlan as never),
			},
		);
		const parsed = await execute();
		expect(parsed.reason).toBe('PLANNED_TASKS_PENDING');
		expect(String(parsed.message)).toContain('1.1');
	});

	test('turbo session does not bypass the refusal', async () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(
				planWithTasks([
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'pending' },
				]),
			),
		);
		const session = swarmState.agentSessions.get('sess1');
		expect(session).toBeDefined();
		session!.turboStrategy = 'standard';
		const parsed = await execute();
		expect(parsed.reason).toBe('PLANNED_TASKS_PENDING');
	});
});

function treesEqual(
	before: Map<string, string>,
	after: Map<string, string>,
): boolean {
	if (before.size !== after.size) return false;
	for (const [key, value] of before) {
		if (after.get(key) !== value) return false;
	}
	return true;
}
