/**
 * #2532 (PLAN-4) regression suite: `plan.current_phase` gets ONE durable
 * authoritative writer (`normalizeCurrentPhaseInPlace` at every manager
 * persist funnel), the cursor is preserved across revisions, and every
 * consumer surface (plan.md header, summary extractor, getCurrentPhase,
 * ledger replay, checkpoint round-trip) agrees.
 *
 * Mirrors the frozen acceptance checks C2/C3/C4/C5/C11.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getCurrentPhase,
	type Plan,
	resolveActivePhaseId,
} from '../../../src/config/plan-schema.js';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { extractCurrentPhaseFromPlan } from '../../../src/hooks/extractors.js';
import { writeCheckpoint } from '../../../src/plan/checkpoint.js';
import {
	readLedgerEvents,
	replayFromLedger,
} from '../../../src/plan/ledger.js';
import {
	closePlanTerminalState,
	derivePlanMarkdown,
	savePlan,
	updateTaskStatus,
} from '../../../src/plan/manager.js';
import { executeSavePlan } from '../../../src/tools/save-plan.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;

const PHASES = [
	{
		id: 1,
		name: 'Phase One',
		tasks: [{ id: '1.1', description: 'Seed task', size: 'small' as const }],
	},
	{
		id: 2,
		name: 'Phase Two',
		tasks: [
			{ id: '2.1', description: 'Task A', size: 'small' as const },
			{ id: '2.2', description: 'Task B', size: 'small' as const },
		],
	},
	{
		id: 3,
		name: 'Phase Three',
		tasks: [{ id: '3.1', description: 'Task C', size: 'small' as const }],
	},
];

function readPlan(): Plan {
	return JSON.parse(
		fs.readFileSync(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
	) as Plan;
}

async function saveInitialPlan(): Promise<void> {
	const result = await executeSavePlan(
		{
			title: 'P4B Regression Plan',
			swarm_id: 'p4b-regression',
			phases: PHASES,
			execution_profile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 4,
			},
			working_directory: tempDir,
		},
		tempDir,
	);
	expect(result.success).toBe(true);
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('p4b-cursor-2532-');
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'spec.md'),
		'# Spec\n\n## FR-001\n\nThe system SHALL regress.\n',
		'utf-8',
	);
	process.env.SWARM_SKIP_SPEC_GATE = '1';
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
});

afterEach(() => {
	delete process.env.SWARM_SKIP_SPEC_GATE;
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	try {
		closeProjectDb(tempDir);
	} catch {
		// best-effort
	}
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('single advancing writer (#2532 PLAN-4)', () => {
	test('updateTaskStatus completing the last task of phase 1 advances the cursor to 2 (C2)', async () => {
		await saveInitialPlan();
		await updateTaskStatus(tempDir, '1.1', 'completed');
		const plan = readPlan();
		expect(plan.phases[0].status).toBe('complete');
		expect(plan.current_phase).toBe(2);
	});

	test('mid-phase save_plan revision preserves the advanced cursor (C3)', async () => {
		await saveInitialPlan();
		await updateTaskStatus(tempDir, '1.1', 'completed');
		expect(readPlan().current_phase).toBe(2);
		const revision = await executeSavePlan(
			{
				title: 'P4B Regression Plan',
				swarm_id: 'p4b-regression',
				phases: PHASES.map((p) => ({
					...p,
					tasks: p.tasks.map((t) => ({
						...t,
						description: `${t.description} (revised)`,
					})),
				})),
				working_directory: tempDir,
			},
			tempDir,
		);
		expect(revision.success).toBe(true);
		const plan = readPlan();
		expect(plan.phases[0].status).toBe('complete');
		expect(plan.current_phase).toBe(2);
	});

	test('the phase-complete commit sequence advances the cursor 2 → 3 (C4)', async () => {
		await saveInitialPlan();
		// Complete phase 1, then every phase-2 task, through the registered
		// status path so the status derivation keeps both phases complete.
		await updateTaskStatus(tempDir, '1.1', 'completed');
		await updateTaskStatus(tempDir, '2.1', 'completed');
		await updateTaskStatus(tempDir, '2.2', 'completed');
		let plan = readPlan();
		expect(plan.phases[0].status).toBe('complete');
		expect(plan.phases[1].status).toBe('complete');
		// The phase-complete tool's commit sub-path: mark + save with the
		// tool's options (statuses preserved, lock already held).
		plan.phases[1].status = 'complete';
		await savePlan(tempDir, plan, {
			preserveCompletedStatuses: true,
			planLockAlreadyHeld: true,
		});
		plan = readPlan();
		expect(plan.current_phase).toBe(3);
		expect(plan.phases[2].status).not.toBe('complete');
	});

	test('closePlanTerminalState persists the normalized cursor (direct persist funnel)', async () => {
		await saveInitialPlan();
		await updateTaskStatus(tempDir, '1.1', 'completed');
		const plan = readPlan();
		expect(plan.current_phase).toBe(2);
		// The function's contract: the CALLER applies the terminal state
		// (/swarm close's finalize stage does this) before the direct persist.
		for (const phase of plan.phases) {
			phase.status = 'closed';
			for (const task of phase.tasks) task.status = 'closed';
		}
		await closePlanTerminalState(tempDir, plan, {
			closedPhaseIds: [1, 2, 3],
			closedTaskIds: ['1.1', '2.1', '2.2', '3.1'],
		});
		const closed = readPlan();
		// All phases terminal → cursor keeps the LAST phase id.
		expect(
			closed.phases.every(
				(p) => p.status === 'closed' || p.status === 'complete',
			),
		).toBe(true);
		expect(closed.current_phase).toBe(3);
		// Replay agrees with the persisted cursor (no projection divergence).
		const replayed = await replayFromLedger(tempDir);
		expect(replayed?.current_phase).toBe(closed.current_phase);
	});

	test('a fully-terminal plan keeps its last phase id', async () => {
		await saveInitialPlan();
		await updateTaskStatus(tempDir, '1.1', 'completed');
		await updateTaskStatus(tempDir, '2.1', 'completed');
		await updateTaskStatus(tempDir, '2.2', 'completed');
		await updateTaskStatus(tempDir, '3.1', 'completed');
		const plan = readPlan();
		expect(plan.phases.every((p) => p.status === 'complete')).toBe(true);
		expect(plan.current_phase).toBe(3);
		expect(resolveActivePhaseId(plan)).toBe(3);
	});

	test('cursor pointing at a removed phase resolves to the first non-terminal phase', () => {
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 't',
			swarm: 's',
			current_phase: 9, // no phase 9
			phases: [
				{
					id: 1,
					name: 'One',
					status: 'complete',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							size: 'small',
							description: 'x',
							depends: [],
							files_touched: [],
						},
					],
				},
				{
					id: 2,
					name: 'Two',
					status: 'in_progress',
					tasks: [
						{
							id: '2.1',
							phase: 2,
							status: 'in_progress',
							size: 'small',
							description: 'y',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		expect(resolveActivePhaseId(plan)).toBe(2);
	});
});

describe('consumer convergence for legacy stuck-cursor plans (C5)', () => {
	function legacyStuckPlan(): Plan {
		return {
			schema_version: '1.0.0',
			title: 'Legacy',
			swarm: 'legacy',
			current_phase: 1, // stuck: phase 1 is complete, phase 2 is active
			phases: [
				{
					id: 1,
					name: 'One',
					status: 'complete',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							size: 'small',
							description: 'done',
							depends: [],
							files_touched: [],
						},
					],
				},
				{
					id: 2,
					name: 'Two',
					status: 'in_progress',
					tasks: [
						{
							id: '2.1',
							phase: 2,
							status: 'in_progress',
							size: 'small',
							description: 'active',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
	}

	test('plan.md header reports the honest active phase', () => {
		const markdown = derivePlanMarkdown(legacyStuckPlan());
		expect(markdown).toMatch(/^Phase: 2 \[/m);
		expect(markdown).not.toMatch(/^Phase: 1 \[/m);
	});

	test('summary extractor and getCurrentPhase report phase 2', () => {
		const plan = legacyStuckPlan();
		expect(extractCurrentPhaseFromPlan(plan)).toContain('Phase 2');
		expect(getCurrentPhase(plan)).toBe(2);
	});

	test('the CURRENT task marker lands on the active phase task', () => {
		const markdown = derivePlanMarkdown(legacyStuckPlan());
		const twoOneLine = markdown
			.split('\n')
			.find((line) => line.includes('2.1'));
		expect(twoOneLine).toBeDefined();
		expect(twoOneLine!).toContain('← CURRENT');
	});
});

describe('durability surfaces agree (C11)', () => {
	test('ledger replay reproduces the advanced cursor after task completion', async () => {
		await saveInitialPlan();
		await updateTaskStatus(tempDir, '1.1', 'completed');
		const persisted = readPlan();
		expect(persisted.current_phase).toBe(2);
		const replayed = await replayFromLedger(tempDir);
		expect(replayed?.current_phase).toBe(persisted.current_phase);
		expect(replayed?.phases[0].status).toBe('complete');
	});

	test('checkpoint export/import round-trips the advanced cursor', async () => {
		await saveInitialPlan();
		await updateTaskStatus(tempDir, '1.1', 'completed');
		await writeCheckpoint(tempDir);
		const exportPath = path.join(
			tempDir,
			'.swarm',
			'plan-export',
			'SWARM_PLAN.json',
		);
		expect(fs.existsSync(exportPath)).toBe(true);
		const exported = fs.readFileSync(exportPath, 'utf-8');

		// Import into a fresh .swarm in a NEW temp root.
		const importRoot = canonicalMkdtemp('p4b-cursor-import-');
		try {
			fs.mkdirSync(path.join(importRoot, '.swarm', 'plan-export'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(importRoot, '.swarm', 'plan-export', 'SWARM_PLAN.json'),
				exported,
				'utf-8',
			);
			fs.writeFileSync(
				path.join(importRoot, '.swarm', 'spec.md'),
				'# Spec\n',
				'utf-8',
			);
			const { importCheckpoint } = await import(
				'../../../src/plan/checkpoint.js'
			);
			const result = await importCheckpoint(importRoot, 'cursor-roundtrip');
			expect(result.success).toBe(true);
			const imported = JSON.parse(
				fs.readFileSync(path.join(importRoot, '.swarm', 'plan.json'), 'utf-8'),
			) as Plan;
			expect(imported.current_phase).toBe(2);
		} finally {
			try {
				closeProjectDb(importRoot);
			} catch {
				// best-effort
			}
			fs.rmSync(importRoot, { recursive: true, force: true });
		}
	});
});
