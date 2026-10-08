/**
 * Stage A attribution with parallel coders in flight.
 *
 * Live run (4 parallel coders): the architect session's single currentTaskId
 * held the coder that returned last (2.4), so the pre_check_batch run over
 * task 2.1's files was credited to 2.4 and 2.1 never reached Stage B. While
 * two or more tasks await Stage A, a gate run is credited by its files to the
 * one in-flight task whose planned files contain them all — or to none.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	_internals,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
import { resolveParallelGateTaskAttribution } from '../../../src/hooks/guardrails/parallel-gate-attribution';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const real = { ..._internals };
let cleanup: () => void;
let directory: string;

const CONFIG: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	idle_timeout_minutes: 60,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
};

const PASS = JSON.stringify({
	gates_passed: true,
	total_duration_ms: 1,
	batch_status: 'completed',
	lint: { ran: true, duration_ms: 1 },
	secretscan: {
		ran: true,
		duration_ms: 1,
		result: {
			count: 0,
			findings: [],
			files_scanned: 2,
			incomplete_files: 0,
			incomplete_paths: [],
		},
	},
	sast_scan: { ran: true, duration_ms: 1, result: { verdict: 'pass' } },
	quality_budget: { ran: false, duration_ms: 0 },
});

const FILES: Record<string, string[]> = {
	'2.1': ['src/slugify.ts', 'tests/slugify.test.ts'],
	'2.2': ['src/stats.ts', 'tests/stats.test.ts'],
	'2.3': ['src/lib'],
	'2.4': ['src/lib/case.ts', 'tests/case.test.ts'],
};

function writePlan(): void {
	const plan = {
		schema_version: '1.0.0',
		title: 'Parallel attribution',
		swarm: 'test',
		current_phase: 2,
		phases: [
			{
				id: 2,
				name: 'Two',
				status: 'in_progress',
				tasks: Object.entries(FILES).map(([id, files]) => ({
					id,
					phase: 2,
					status: 'in_progress',
					size: 'small',
					description: `Task ${id}`,
					depends: [],
					files_touched: files,
				})),
			},
		],
	};
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

function inFlight(...taskIds: string[]): void {
	const session = ensureAgentSession('architect');
	for (const id of taskIds)
		session.taskWorkflowStates.set(id, 'coder_delegated');
}

async function settle(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:setup-${taskId}`,
	});
}

async function stateOf(taskId: string): Promise<string> {
	return getTaskWorkflowSnapshot(await readTaskEvidence(directory, taskId))
		.state;
}

async function runPreCheck(
	files: string[],
	callID: string,
	output = PASS,
): Promise<void> {
	const hooks = createGuardrailsHooks(directory, CONFIG);
	await hooks.toolBefore(
		{ tool: 'pre_check_batch', sessionID: 'architect', callID },
		{ args: { files } },
	);
	await hooks.toolAfter(
		{ tool: 'pre_check_batch', sessionID: 'architect', callID },
		{ title: '', output, metadata: null },
	);
}

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('parallel-gate-attr-'));
	resetSwarmState();
	writePlan();
});

afterEach(() => {
	Object.assign(_internals, real);
	cleanup();
	resetSwarmState();
});

describe('resolveParallelGateTaskAttribution', () => {
	test('zero in flight, or one that is currentTaskId (or none set), keeps the existing attribution', async () => {
		expect(
			await resolveParallelGateTaskAttribution(directory, 'architect', [
				'src/stats.ts',
			]),
		).toEqual({ kind: 'none' });
		inFlight('2.1');
		// No currentTaskId (post-reset): the durable fallback owns it.
		expect(
			await resolveParallelGateTaskAttribution(directory, 'architect', [
				'src/stats.ts',
			]),
		).toEqual({ kind: 'none' });
		const session = swarmState.agentSessions.get('architect');
		if (session) session.currentTaskId = '2.1';
		expect(
			await resolveParallelGateTaskAttribution(directory, 'architect', [
				'src/stats.ts',
			]),
		).toEqual({ kind: 'none' });
	});

	test('one in flight that is not currentTaskId is credited by its files', async () => {
		inFlight('2.1');
		const session = swarmState.agentSessions.get('architect');
		if (session) session.currentTaskId = '2.4';
		expect(
			await resolveParallelGateTaskAttribution(directory, 'architect', [
				'src/slugify.ts',
			]),
		).toEqual({ kind: 'task', taskId: '2.1' });
	});

	test('in-flight entries for tasks no longer in the plan do not count', async () => {
		inFlight('2.1', '9.9');
		expect(
			await resolveParallelGateTaskAttribution(directory, 'architect', []),
		).toEqual({ kind: 'none' });
	});

	test('credits the one in-flight task whose planned files contain every checked file', async () => {
		inFlight('2.1', '2.2', '2.4');
		expect(
			await resolveParallelGateTaskAttribution(directory, 'architect', [
				'src/slugify.ts',
				path.join(directory, 'tests', 'slugify.test.ts'),
			]),
		).toEqual({ kind: 'task', taskId: '2.1' });
		expect(
			await resolveParallelGateTaskAttribution(directory, 'architect', [
				'src/lib/case.ts',
			]),
		).toEqual({ kind: 'task', taskId: '2.4' });
	});

	test('mixed, foreign or missing files and overlapping scopes credit nothing', async () => {
		inFlight('2.1', '2.2', '2.3', '2.4');
		const mixed = await resolveParallelGateTaskAttribution(
			directory,
			'architect',
			['src/slugify.ts', 'src/stats.ts'],
		);
		expect(mixed.kind).toBe('unattributable');
		if (mixed.kind === 'unattributable')
			expect(mixed.message).toContain('no single in-flight task');
		const overlapping = await resolveParallelGateTaskAttribution(
			directory,
			'architect',
			['src/lib/case.ts'],
		);
		expect(overlapping.kind).toBe('unattributable');
		if (overlapping.kind === 'unattributable')
			expect(overlapping.message).toContain(
				'several in-flight tasks (2.3, 2.4)',
			);
		for (const files of [null, [], ['  ']]) {
			const none = await resolveParallelGateTaskAttribution(
				directory,
				'architect',
				files,
			);
			expect(none.kind).toBe('unattributable');
			if (none.kind === 'unattributable')
				expect(none.message).toContain('names no files');
		}
	});
});

describe('guardrails credit the checked task, not the last-returned coder', () => {
	beforeEach(async () => {
		await settle('2.1');
		await settle('2.4');
		inFlight('2.1', '2.4');
		const session = swarmState.agentSessions.get('architect');
		if (session) session.currentTaskId = '2.4';
	});

	test('a run over 2.1 files is credited to 2.1', async () => {
		await runPreCheck(['src/slugify.ts', 'tests/slugify.test.ts'], 'p1');
		expect(await stateOf('2.1')).toBe('pre_check_passed');
		expect(await stateOf('2.4')).toBe('coder_delegated');
	});

	test('an unattributable run credits no task and tells the architect', async () => {
		await runPreCheck(['src/slugify.ts', 'src/lib/case.ts'], 'p2');
		expect(await stateOf('2.1')).toBe('coder_delegated');
		expect(await stateOf('2.4')).toBe('coder_delegated');
		const advisories =
			swarmState.agentSessions.get('architect')?.pendingAdvisoryMessages ?? [];
		expect(advisories.some((m) => m.includes('STAGE A ATTRIBUTION'))).toBe(
			true,
		);
	});

	test('gate tools other than pre_check_batch keep currentTaskId', async () => {
		// diff takes `paths` and lint no file argument at all: re-attributing
		// them by files would drop them from the gate log (false
		// partial-gate warnings) and tell the architect to pass `files`.
		const hooks = createGuardrailsHooks(directory, CONFIG);
		for (const [tool, args] of [
			['diff', { paths: ['src/slugify.ts'] }],
			['lint', { mode: 'check' }],
		] as const) {
			await hooks.toolBefore(
				{ tool, sessionID: 'architect', callID: `c-${tool}` },
				{ args },
			);
			await hooks.toolAfter(
				{ tool, sessionID: 'architect', callID: `c-${tool}` },
				{ title: '', output: '{}', metadata: null },
			);
		}
		const session = swarmState.agentSessions.get('architect');
		expect([...(session?.gateLog.get('2.4') ?? [])].sort()).toEqual([
			'diff',
			'lint',
		]);
		expect(
			(session?.pendingAdvisoryMessages ?? []).some((m) =>
				m.includes('STAGE A ATTRIBUTION'),
			),
		).toBe(false);
	});

	test('with one task in flight currentTaskId attribution is unchanged', async () => {
		swarmState.agentSessions.get('architect')?.taskWorkflowStates.delete('2.1');
		await runPreCheck(['src/slugify.ts'], 'p3');
		expect(await stateOf('2.4')).toBe('pre_check_passed');
		expect(await stateOf('2.1')).toBe('coder_delegated');
	});
});

describe('the remaining task after the last-returned coder passed Stage A', () => {
	// Live run: 2.4 returned last (currentTaskId = 2.4) and passed Stage A, so
	// only 2.1 awaited Stage A — but with one task in flight attribution fell
	// back to currentTaskId and 2.1's run was credited to 2.4 again.
	const FAIL = JSON.stringify({
		...JSON.parse(PASS),
		gates_passed: false,
		lint: { ran: true, duration_ms: 1, error: 'lint failed' },
	});

	beforeEach(async () => {
		await settle('2.1');
		await settle('2.4');
		inFlight('2.1', '2.4');
		const session = swarmState.agentSessions.get('architect');
		if (session) session.currentTaskId = '2.4';
		await runPreCheck(['src/lib/case.ts', 'tests/case.test.ts'], 'r1');
		expect(await stateOf('2.4')).toBe('pre_check_passed');
	});

	test('pass then pass: the second run is credited to 2.1', async () => {
		await runPreCheck(['src/slugify.ts'], 'r2');
		expect(await stateOf('2.1')).toBe('pre_check_passed');
		expect(await stateOf('2.4')).toBe('pre_check_passed');
	});

	test('pass then fail: the failing run reworks 2.1, not 2.4', async () => {
		await runPreCheck(['src/slugify.ts'], 'r3', FAIL);
		expect(await stateOf('2.1')).toBe('rework_required');
		expect(await stateOf('2.4')).toBe('pre_check_passed');
	});

	test('the lone awaiting task still needs its own files', async () => {
		const attribution = await resolveParallelGateTaskAttribution(
			directory,
			'architect',
			['src/lib/case.ts'],
		);
		expect(attribution.kind).toBe('unattributable');
		if (attribution.kind === 'unattributable')
			expect(attribution.message).toContain(
				"task 2.1 is awaiting Stage A but the session's current task is 2.4",
			);
	});
});
