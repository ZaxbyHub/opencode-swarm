/**
 * Guardrails × Epic: Stage A attribution in a parallel wave.
 *
 * The session's currentTaskId holds the last coder that returned. With the
 * Epic seam the pre_check_batch run is credited to the wave task that owns
 * the checked files instead — and to no task when Epic says the run is
 * unattributable (no fallback to currentTaskId or the durable WAL guess).
 * With no open epic the seam returns `none` and upstream behaviour holds.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

async function runPreCheck(files: string[], callID: string): Promise<void> {
	const hooks = createGuardrailsHooks(directory, CONFIG);
	await hooks.toolBefore(
		{ tool: 'pre_check_batch', sessionID: 'architect', callID },
		{ args: { files } },
	);
	await hooks.toolAfter(
		{ tool: 'pre_check_batch', sessionID: 'architect', callID },
		{ title: '', output: PASS, metadata: null },
	);
}

beforeEach(async () => {
	({ dir: directory, cleanup } = createSafeTestDir('guardrails-epic-stage-a'));
	resetSwarmState();
	await settle('2.1');
	await settle('2.4');
	// The live-run state: the last coder to return was 2.4.
	ensureAgentSession('architect');
	const session = swarmState.agentSessions.get('architect');
	if (session) session.currentTaskId = '2.4';
});

afterEach(() => {
	Object.assign(_internals, real);
	cleanup();
	resetSwarmState();
});

describe('Epic Stage A attribution through the guardrails', () => {
	test('credits the task that owns the files, not the last-returned coder', async () => {
		_internals.resolveEpicGateTaskAttribution = (_dir, files) =>
			files?.includes('src/slugify.ts')
				? { kind: 'task', taskId: '2.1' }
				: { kind: 'none' };
		await runPreCheck(['src/slugify.ts', 'tests/slugify.test.ts'], 'p1');
		expect(await stateOf('2.1')).toBe('pre_check_passed');
		expect(await stateOf('2.4')).toBe('coder_delegated');
	});

	test('unattributable: credits no task (no currentTaskId fallback) and tells the architect', async () => {
		_internals.resolveEpicGateTaskAttribution = () => ({
			kind: 'unattributable',
			message: 'EPIC STAGE A ATTRIBUTION: test message',
		});
		await runPreCheck(['src/slugify.ts', 'src/stats.ts'], 'p2');
		expect(await stateOf('2.1')).toBe('coder_delegated');
		expect(await stateOf('2.4')).toBe('coder_delegated');
		const advisories =
			swarmState.agentSessions.get('architect')?.pendingAdvisoryMessages ?? [];
		expect(advisories.some((m) => m.includes('EPIC STAGE A ATTRIBUTION'))).toBe(
			true,
		);
	});

	test('no open epic: upstream currentTaskId attribution is unchanged', async () => {
		_internals.resolveEpicGateTaskAttribution = () => ({ kind: 'none' });
		await runPreCheck(['src/slugify.ts'], 'p3');
		expect(await stateOf('2.4')).toBe('pre_check_passed');
		expect(await stateOf('2.1')).toBe('coder_delegated');
	});

	test('the production seam is the real Epic resolver (no sentinel ⇒ none)', () => {
		expect(
			_internals.resolveEpicGateTaskAttribution(directory, ['src/a.ts']),
		).toEqual({ kind: 'none' });
	});
});
