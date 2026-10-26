/**
 * Issue #3422 — external-evidence completion path: terminal WAL round-trip,
 * completion, digest-mismatch / undeclared (AC2 pin) / forged refusals, the
 * phase-cursor crash window, check_gate_status, plan.md projection, C5 hashes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan, Task } from '../../../src/config/plan-schema';
import {
	computeExternalDeclarationDigest,
	type ExternalEvidenceBundle,
	externalProofCurrent,
	getTaskWorkflowSnapshot,
	readTaskEvidenceRaw,
	recordTodoScanEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	computePlanLedgerHash,
	computePlanStructureHash,
} from '../../../src/plan/ledger';
import {
	derivePlanMarkdown,
	regeneratePlanMarkdown,
} from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import { check_gate_status } from '../../../src/tools/check-gate-status';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import {
	recoverPreparedTaskTerminal,
	_internals as taskTerminalInternals,
} from '../../../src/workflow/task-terminal';
import {
	readWorkflowWalFile,
	writeWorkflowWalFile,
} from '../../../src/workflow/workflow-wal-file';
import type { TaskTerminalWal } from '../../../src/workflow/workflow-wal-schema';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TITLE = 'Issue 3422 external evidence fixture';
const SWARM = 'issue-3422';
const STATIC_ISO = '2026-10-01T00:00:00.000Z';
const TASK_ID = '2.1';
const LEDGER_HASH =
	'66f1d93cdc74907834f775f0a5a3b03d64d6e81a598291c32844eb1319b4ead3';
const STRUCTURE_HASH =
	'156a0691c349b79e9cb22dc68cab3a514a6b62840b01f9f14f5ed7190dd46f7b';
const CONTENT_HASH = '2vl7bkct39yvm';
const ANCHORS = [{ command: 'git rev-list --count main..HEAD', expect: '1' }];

function runGit(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdio: 'ignore',
		timeout: 5000,
	});
	if (result.status !== 0) throw new Error(`git failed: ${args.join(' ')}`);
}

function declaredTask(id: string, phase: number, task?: Partial<Task>): Task {
	return {
		id,
		phase,
		status: 'in_progress',
		size: 'small',
		description: 'Verify the pushed release commit externally',
		depends: [],
		files_touched: [],
		evidence_class: 'external_git',
		evidence_anchors: [...ANCHORS],
		...task,
	};
}
function undeclaredTask(id: string, phase: number, task?: Partial<Task>): Task {
	const {
		evidence_class: _class,
		evidence_anchors: _anchors,
		...rest
	} = declaredTask(id, phase, task);
	return rest;
}
const plainTask = (): Task =>
	undeclaredTask(TASK_ID, 2, { description: 'Ordinary coder-mutation task' });

function singlePhasePlan(task: Task): Plan {
	return {
		schema_version: '1.0.0',
		title: TITLE,
		swarm: SWARM,
		phases: [{ id: 2, name: 'Release', status: 'in_progress', tasks: [task] }],
	};
}

function writeProject(directory: string, plan: Plan): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
	runGit(directory, ['init', '--quiet']);
	runGit(directory, ['config', 'user.email', 'issue-3422@example.invalid']);
	runGit(directory, ['config', 'user.name', 'Issue 3422 test']);
	runGit(directory, ['add', '.']);
	runGit(directory, ['commit', '--quiet', '-m', 'issue 3422 fixture']);
}

function digestFor(plan: Plan, task: Task, generation = 0): string {
	return computeExternalDeclarationDigest({
		taskId: task.id,
		evidence_class: 'external_git',
		evidence_anchors: task.evidence_anchors ?? [],
		plan_title: plan.title,
		plan_swarm: plan.swarm,
		generation,
	});
}

async function attestTask(
	directory: string,
	plan: Plan,
	task: Task,
	transitionId = 'issue-3422-attest',
): Promise<void> {
	const bundle: ExternalEvidenceBundle = {
		class: 'external_git',
		transitionId,
		declarationDigest: digestFor(plan, task),
		anchors: (task.evidence_anchors ?? []).map((anchor) => ({
			...anchor,
			matched: true,
			exit_code: 0,
			stdout: `${anchor.expect ?? anchor.expect_prefix ?? ''}\n`,
		})),
		attestedAt: STATIC_ISO,
	};
	await transitionTaskWorkflowEvidence(directory, task.id, {
		type: 'external_evidence_attested',
		bundle,
		expectedGeneration: 0,
		transitionId,
	});
}

function terminalWal(taskId: string, transitionId: string): TaskTerminalWal {
	return {
		version: 1,
		state: 'PREPARED',
		taskId,
		transitionId,
		actor: 'issue-3422-test',
		oldPlanStatus: 'in_progress',
		newPlanStatus: 'completed',
		oldWorkflowState: 'idle',
		newWorkflowState: 'complete',
		generation: 0,
		qaExempt: false,
		externalEvidence: true,
		recordedAt: STATIC_ISO,
	};
}
const terminalWalPath = (directory: string, taskId: string): string =>
	path.join(directory, '.swarm', 'task-terminals', `${taskId}.json`);

const planTaskStatus = (
	directory: string,
	taskId: string,
): string | undefined =>
	(
		JSON.parse(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf8'),
		) as Plan
	).phases
		.flatMap((phase) => phase.tasks)
		.find((task) => task.id === taskId)?.status;

async function gateStatus(directory: string): Promise<Record<string, unknown>> {
	return JSON.parse(
		await check_gate_status.execute(
			{ task_id: TASK_ID, working_directory: directory },
			{ directory },
		),
	) as Record<string, unknown>;
}

const seedScanEvidence = (dir: string): Promise<void> =>
	recordTodoScanEvidence(dir, TASK_ID, { priority: 'high', count: 0 });
/** PLAN_HASH header value that regeneratePlanMarkdown embeds into plan.md. */
async function contentHashFor(plan: Plan): Promise<string> {
	const dir = canonicalMkdtemp('ext-3422-hash-');
	try {
		fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await regeneratePlanMarkdown(dir, plan);
		return (
			fs
				.readFileSync(path.join(dir, '.swarm', 'plan.md'), 'utf8')
				.match(/PLAN_HASH:\s*(\S+)/)?.[1] ?? ''
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** The frozen probe-C5 legacy plan fixture (no evidence fields), verbatim. */
const PROBE_PLAN_JSON = `{
	"schema_version": "1.0.0", "title": "Issue 3422 hash stability probe",
	"swarm": "probe", "current_phase": 1, "migration_status": "native",
	"phases": [
		{ "id": 1, "name": "build", "status": "in_progress", "tasks": [
			{ "id": "1.1", "phase": 1, "status": "in_progress", "size": "small", "description": "Implement the widget parser", "depends": [], "acceptance": "Parser handles empty input", "files_touched": ["src/widget.ts"] },
			{ "id": "1.2", "phase": 1, "status": "pending", "size": "medium", "description": "Document the widget parser API", "depends": ["1.1"], "files_touched": ["docs/widget.md", "src/widget.ts"] } ] },
		{ "id": 2, "name": "docs", "status": "pending", "tasks": [
			{ "id": "2.1", "phase": 2, "status": "pending", "size": "small", "description": "Write the release notes", "depends": ["1.2"], "files_touched": [] } ] }
	]
}`;
const legacyPlanFromProbe = (): Plan => JSON.parse(PROBE_PLAN_JSON) as Plan;

describe('issue #3422 — external evidence terminal path', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('ext-3422-'));
	});
	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	const completeTask = () =>
		executeUpdateTaskStatus(
			{ task_id: TASK_ID, status: 'completed', working_directory: directory },
			directory,
		);

	test('terminal WAL round-trips the externalEvidence flag into task_completed', async () => {
		const wal = terminalWal(TASK_ID, 'issue-3422-wal-terminal');
		const walPath = terminalWalPath(directory, TASK_ID);
		await writeWorkflowWalFile('task-terminal', walPath, wal);
		const parsed = await readWorkflowWalFile('task-terminal', walPath, TASK_ID);
		expect(parsed?.externalEvidence).toBe(true);

		const captured: unknown[] = [];
		const transition = async (event: unknown) => {
			captured.push(event);
			return {} as never;
		};
		await taskTerminalInternals.applyTerminalEvidence(
			{ transition } as never,
			wal,
		);
		expect(captured[0]).toEqual({
			type: 'task_completed',
			qaExempt: false,
			readOnlyNoMutation: undefined,
			externalEvidence: true,
			expectedGeneration: 0,
			transitionId: 'issue-3422-wal-terminal',
		});
	});

	test('completes an attested external task and stays idempotent on duplicates', async () => {
		const task = declaredTask(TASK_ID, 2);
		const plan = singlePhasePlan(task);
		writeProject(directory, plan);
		await attestTask(directory, plan, task);

		const first = await completeTask();
		expect(first).toMatchObject({ success: true, new_status: 'completed' });
		expect(planTaskStatus(directory, TASK_ID)).toBe('completed');
		const evidence = readTaskEvidenceRaw(directory, TASK_ID);
		expect(getTaskWorkflowSnapshot(evidence)).toMatchObject({
			state: 'complete',
			generation: 0,
		});
		expect(evidence?.workflow?.externalEvidence).toMatchObject({
			class: 'external_git',
			declarationDigest: digestFor(plan, task),
		});

		const second = await completeTask();
		expect(second.success).toBe(true);
		expect(
			getTaskWorkflowSnapshot(readTaskEvidenceRaw(directory, TASK_ID)).state,
		).toBe('complete');
	});

	test('refuses completion when the declaration was edited after the attest', async () => {
		const task = declaredTask(TASK_ID, 2);
		// A reviewer-free phase skips the pre-lock reviewer gate so the refusal
		// surfaces from the in-lock validateEvidence external arm.
		const plan = singlePhasePlan(task);
		plan.phases[0].required_agents = ['docs'];
		writeProject(directory, plan);
		await attestTask(directory, plan, task);

		const planPath = path.join(directory, '.swarm', 'plan.json');
		const edited = JSON.parse(fs.readFileSync(planPath, 'utf8')) as Plan;
		const editedTask = edited.phases[0].tasks[0];
		editedTask.evidence_anchors = [{ ...ANCHORS[0], expect: '2' }];
		fs.writeFileSync(planPath, JSON.stringify(edited));

		const result = await completeTask();
		expect(result.success).toBe(false);
		expect(result.errors?.[0]).toContain(
			'TASK_COMPLETION_CAS_MISMATCH: Task 2.1 declares external_git evidence but has no current matched attestation',
		);
		expect(planTaskStatus(directory, TASK_ID)).toBe('in_progress');
	});

	test('undeclared evidence-less completion refuses with the exact AC2 message', async () => {
		writeProject(directory, singlePhasePlan(plainTask()));
		const result = await completeTask();
		expect(result.success).toBe(false);
		expect(result.errors?.[0]).toBe(
			'TASK_COMPLETION_CAS_MISMATCH: Task 2.1 has no exact-task QA evidence. Delegate the required Stage B agents, then retry completion.',
		);
	});

	test('forged workflow.externalEvidence metadata never admits completion', async () => {
		const forgedPlan = singlePhasePlan(declaredTask(TASK_ID, 2));
		const forgedBundle: ExternalEvidenceBundle = {
			class: 'external_git',
			transitionId: 'forged-attest',
			declarationDigest: digestFor(forgedPlan, forgedPlan.phases[0].tasks[0]),
			anchors: [{ ...ANCHORS[0], matched: true, exit_code: 0, stdout: '1\n' }],
			attestedAt: STATIC_ISO,
		};
		const cases: Array<{ label: string; task: Task }> = [
			{ label: 'undeclared task', task: plainTask() },
			{
				label: 'coder_mutation task',
				task: declaredTask(TASK_ID, 2, {
					description: 'Forged-metadata target',
					evidence_class: 'coder_mutation',
					evidence_anchors: undefined,
				}),
			},
		];
		for (const [index, candidate] of cases.entries()) {
			resetSwarmState();
			cleanup();
			({ dir: directory, cleanup } = createSafeTestDir(`e3422f-${index}-`));
			writeProject(directory, singlePhasePlan(candidate.task));
			// Seed a legitimate idle-workflow evidence file via the real producer
			// API, then splice in the forged bundle by hand (the attack shape).
			await seedScanEvidence(directory);
			const evidencePath = path.join(
				directory,
				'.swarm/evidence',
				`${TASK_ID}.json`,
			);
			const forged = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
				workflow: Record<string, unknown>;
			};
			forged.workflow.externalEvidence = forgedBundle;
			fs.writeFileSync(evidencePath, JSON.stringify(forged));

			const result = await completeTask();
			expect(result.success, candidate.label).toBe(false);
			expect(result.errors?.[0], candidate.label).toContain(
				'Missing gates: [pre_check]',
			);
			expect(planTaskStatus(directory, TASK_ID), candidate.label).toBe(
				'in_progress',
			);
		}
	});

	test('cursor-advance crash window: PREPARED recovery revalidates the cursor-free digest', async () => {
		const declared = declaredTask('1.1', 1);
		const followUp = undeclaredTask(TASK_ID, 2, { status: 'pending' });
		const plan: Plan = {
			schema_version: '1.0.0',
			title: TITLE,
			swarm: SWARM,
			current_phase: 1,
			phases: [
				{ id: 1, name: 'Ship', status: 'in_progress', tasks: [declared] },
				{ id: 2, name: 'Follow-up', status: 'pending', tasks: [followUp] },
			],
		};
		writeProject(directory, plan);
		await attestTask(directory, plan, declared);

		// Crash window: the terminal plan write advanced the phase cursor and the
		// task status, but the evidence transaction never applied.
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const advanced = JSON.parse(fs.readFileSync(planPath, 'utf8')) as Plan;
		advanced.current_phase = 2;
		advanced.phases[0].status = 'complete';
		advanced.phases[0].tasks[0].status = 'completed';
		advanced.phases[1].status = 'in_progress';
		fs.writeFileSync(planPath, JSON.stringify(advanced));

		const advancedTask = advanced.phases[0].tasks[0];
		const identity = { title: advanced.title, swarm: advanced.swarm };
		const evidence = readTaskEvidenceRaw(directory, '1.1');
		// The digest binds the declaration, never the phase cursor.
		expect(externalProofCurrent(identity, advancedTask, evidence)).toBe(true);

		const walPath = terminalWalPath(directory, '1.1');
		await writeWorkflowWalFile(
			'task-terminal',
			walPath,
			terminalWal('1.1', 'issue-3422-cursor-terminal'),
		);
		const recovery = await recoverPreparedTaskTerminal(
			directory,
			'1.1',
			'issue-3422-recovery',
		);
		expect(recovery?.targetStatus).toBe('completed');
		const recoveredEvidence = readTaskEvidenceRaw(directory, '1.1');
		expect(getTaskWorkflowSnapshot(recoveredEvidence)).toMatchObject({
			state: 'complete',
			generation: 0,
		});
		expect(recoveredEvidence?.workflow?.externalEvidence).toMatchObject({
			declarationDigest: digestFor(plan, declared),
		});
		const walJson = JSON.parse(fs.readFileSync(walPath, 'utf8')) as {
			state?: string;
		};
		expect(walJson.state).toBe('COMMITTED');
		expect(
			externalProofCurrent(identity, advancedTask, recoveredEvidence),
		).toBe(true);
	});

	test('check_gate_status: attested / unattested / undeclared coherence', async () => {
		const declared = declaredTask(TASK_ID, 2);
		const declaredPlan = singlePhasePlan(declared);
		writeProject(directory, declaredPlan);
		await attestTask(directory, declaredPlan, declared);
		const attested = await gateStatus(directory);
		expect(attested.status).toBe('all_passed');
		expect(attested.required_gates).toEqual(['external_attest']);
		expect(attested.missing_gates).toEqual([]);

		resetSwarmState();
		cleanup();
		({ dir: directory, cleanup } = createSafeTestDir('ext-3422-ua-'));
		writeProject(directory, singlePhasePlan(declaredTask(TASK_ID, 2)));
		await seedScanEvidence(directory);
		const unattested = await gateStatus(directory);
		expect(unattested.status).toBe('incomplete');
		expect(unattested.required_gates).toEqual(['external_attest']);
		expect(unattested.missing_gates).toEqual(['external_attest']);
		expect(String(unattested.message)).toContain(`/swarm attest ${TASK_ID}`);

		resetSwarmState();
		cleanup();
		({ dir: directory, cleanup } = createSafeTestDir('ext-3422-pl-'));
		writeProject(directory, singlePhasePlan(plainTask()));
		const undeclared = await gateStatus(directory);
		expect(undeclared.status).toBe('no_evidence');
		expect(undeclared.required_gates).toEqual([]);
		expect(undeclared.missing_gates).toEqual([]);
		expect(String(undeclared.message)).toContain('No evidence file found');
	});

	test('plan.md projection and C5 hash sensitivity', async () => {
		// Declaration rendering: the declared line is the legacy line plus
		// exactly the compact declaration suffix (byte-identical prefix).
		const declared = declaredTask(TASK_ID, 2, { status: 'pending' });
		const legacy = undeclaredTask(TASK_ID, 2, { status: 'pending' });
		const taskLine = (task: Task): string =>
			derivePlanMarkdown(singlePhasePlan(task))
				.split('\n')
				.find((line) => line.startsWith('- [')) ?? '';
		const legacyLine = taskLine(legacy);
		// A pending task carries no CURRENT marker, so this pins the full line.
		expect(legacyLine).toBe(`- [ ] ${TASK_ID}: ${legacy.description} [SMALL]`);
		expect(taskLine(declared)).toBe(
			`${legacyLine} — external evidence: external_git (anchors: ${ANCHORS[0].command})`,
		);

		// C5: the legacy probe plan keeps the frozen constants; adding a
		// declaration set changes all three hashes.
		const legacyPlan = legacyPlanFromProbe();
		expect(computePlanLedgerHash(legacyPlan)).toBe(LEDGER_HASH);
		expect(computePlanStructureHash(legacyPlan)).toBe(STRUCTURE_HASH);
		expect(await contentHashFor(legacyPlan)).toBe(CONTENT_HASH);

		const declaredPlan = legacyPlanFromProbe();
		declaredPlan.phases[0].tasks[0].evidence_class = 'external_git';
		declaredPlan.phases[0].tasks[0].evidence_anchors = [...ANCHORS];
		expect(computePlanLedgerHash(declaredPlan)).not.toBe(LEDGER_HASH);
		expect(computePlanStructureHash(declaredPlan)).not.toBe(STRUCTURE_HASH);
		const declaredContentHash = await contentHashFor(declaredPlan);
		expect(declaredContentHash).not.toBe('');
		expect(declaredContentHash).not.toBe(CONTENT_HASH);
	});
});
