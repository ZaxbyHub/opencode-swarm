/**
 * #3770 exactly-once completion events: duplicates, crash-retry heal,
 * task-level reopen churn, unrelated later writes, concurrency, and ledger
 * re-roots each resolve the documented identity contract. Split from the
 * refusal suite (FR-006). Static ISO literals throughout (check:test-clock).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DriftReport } from '../../../src/hooks/curator-types';
import {
	appendLedgerEvent,
	computePlanLedgerHash,
	replacePlanLedgerWithRoot,
} from '../../../src/plan/ledger';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
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

describe('#3770 exactly-once completion events', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = canonicalMkdtemp('planned-tasks-once-');
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
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(planWithTasks([{ id: '1.1', status: 'completed' }])),
		);
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

	test('duplicate success call appends exactly one completion event', async () => {
		const first = await execute();
		expect(first.success).toBe(true);
		recordPhaseAgentDispatch('sess1', 'coder');
		const second = await execute();
		expect(second.success).toBe(true);
		expect(phaseCompleteEventLines(tempDir).length).toBe(1);
	});

	test('transient ledger-read failure fails closed: no fallback-namespace event (review F-002)', async () => {
		expect((await execute()).success).toBe(true);
		expect(phaseCompleteEventLines(tempDir).length).toBe(1);
		// Sabotage ONLY the read authority: a directory in the ledger path
		// makes readFileSync throw (the transient EBUSY/EPERM class). The
		// committed transition stays in the (renamed-away) ledger bytes.
		const ledgerPath = path.join(tempDir, '.swarm', 'plan-ledger.jsonl');
		const ledgerBytes = fs.readFileSync(ledgerPath);
		fs.rmSync(ledgerPath);
		fs.mkdirSync(ledgerPath);
		recordPhaseAgentDispatch('sess1', 'coder');
		const duringOutage = await execute();
		expect(duringOutage.success).toBe(true);
		// Fail-closed: the outage call must NOT append a noledger-keyed core
		// event (pre-fix it re-keyed into the fallback namespace and the
		// healthy retry then recorded a second, duplicate event).
		expect(phaseCompleteEventLines(tempDir).length).toBe(1);
		// Restore the authority and retry: the healthy retry resolves the
		// ledger identity and the dedupe keeps the total at exactly one.
		fs.rmSync(ledgerPath, { recursive: true });
		fs.writeFileSync(ledgerPath, ledgerBytes);
		recordPhaseAgentDispatch('sess1', 'coder');
		const healed = await execute();
		expect(healed.success).toBe(true);
		expect(phaseCompleteEventLines(tempDir).length).toBe(1);
	});

	test('crash between save and append heals on retry to exactly one event', async () => {
		const first = await execute();
		expect(first.success).toBe(true);
		// Simulate the pre-append crash state: neither the events log NOR the
		// durable authority index (a separate file, events-authority-index.json)
		// was written, while the ledger transition stays committed. Deleting
		// only events.jsonl would leave the index as the surviving dedupe
		// authority and the retry would correctly NOT re-append.
		fs.rmSync(path.join(tempDir, '.swarm', 'events.jsonl'), { force: true });
		fs.rmSync(path.join(tempDir, '.swarm', 'events-authority-index.json'), {
			force: true,
		});
		recordPhaseAgentDispatch('sess1', 'coder');
		const retry = await execute();
		expect(retry.success).toBe(true);
		expect(phaseCompleteEventLines(tempDir).length).toBe(1);
	});

	test('task-level reopen events do not mint a duplicate event (phase completion is one-way per root)', async () => {
		expect((await execute()).success).toBe(true);
		// Ledger contract (probe-verified): snapshots and task_status_changed
		// events never reset a phase's replayed status — a completion is a
		// one-way transition within a root, and re-opening a phase goes
		// through root replacement (covered by the re-root test below). So a
		// later call after task churn still dedupes to one event.
		await appendLedgerEvent(
			tempDir,
			{
				plan_id: 'mega-Planned_Tasks_Gate_Test',
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'completed',
				to_status: 'pending',
				source: 'test-task-churn',
			},
			{
				planHashAfter: computePlanLedgerHash(
					planWithTasks([{ id: '1.1', status: 'pending' }]) as never,
				),
			},
		);
		await appendLedgerEvent(
			tempDir,
			{
				plan_id: 'mega-Planned_Tasks_Gate_Test',
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'completed',
				source: 'test-task-churn',
			},
			{
				planHashAfter: computePlanLedgerHash(
					planWithTasks([{ id: '1.1', status: 'completed' }]) as never,
				),
			},
		);
		recordPhaseAgentDispatch('sess1', 'coder');
		const second = await execute();
		expect(second.success).toBe(true);
		expect(phaseCompleteEventLines(tempDir).length).toBe(1);
	});

	test('unrelated later ledger writes do not un-dedupe a duplicate call', async () => {
		expect((await execute()).success).toBe(true);
		await appendLedgerEvent(
			tempDir,
			{
				plan_id: 'mega-Planned_Tasks_Gate_Test',
				event_type: 'plan_rebuilt',
				source: 'test-unrelated',
				payload: { reason: 'unrelated' },
			},
			{
				planHashAfter: computePlanLedgerHash(
					planWithTasks([{ id: '1.1', status: 'completed' }]) as never,
				),
			},
		);
		recordPhaseAgentDispatch('sess1', 'coder');
		const duplicate = await execute();
		expect(duplicate.success).toBe(true);
		expect(phaseCompleteEventLines(tempDir).length).toBe(1);
	});

	test('concurrent double-call records exactly one event', async () => {
		const [a, b] = await Promise.all([execute(), execute()]);
		const successes = [a, b].filter((result) => result.success).length;
		expect(successes).toBeGreaterThanOrEqual(1);
		expect(phaseCompleteEventLines(tempDir).length).toBe(1);
	});

	test('ledger re-root with same phase number and reused seq emits its own event', async () => {
		expect((await execute()).success).toBe(true);
		expect(phaseCompleteEventLines(tempDir).length).toBe(1);
		// Re-root with the phase open again: the replacement history restarts
		// at seq 1, so the new completion's (root, seq) identity is distinct
		// from the old plan's despite the same numbers.
		await replacePlanLedgerWithRoot(
			tempDir,
			planWithTasks([{ id: '1.1', status: 'completed' }]) as never,
			'test-re-root',
		);
		recordPhaseAgentDispatch('sess1', 'coder');
		const second = await execute();
		expect(second.success).toBe(true);
		expect(phaseCompleteEventLines(tempDir).length).toBe(2);
	});
});

function labelUnused(
	before: Map<string, string>,
	after: Map<string, string>,
): boolean {
	if (before.size !== after.size) return false;
	for (const [key, value] of before) {
		if (after.get(key) !== value) return false;
	}
	return true;
}
