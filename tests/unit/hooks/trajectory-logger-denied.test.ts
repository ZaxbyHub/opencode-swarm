/**
 * Denied-tool-call trajectory recording (issue #2063 D1) and the `deriveAction`
 * taxonomy fixes (D2).
 *
 * Before D1 the trajectory only contained calls that actually RAN, so a session
 * that spent dozens of turns re-issuing a dispatch the delegation gate kept
 * rejecting looked — to PRM and to any post-hoc reader — like a session that
 * made no tool calls at all. The loop shape #2063 is about was invisible in the
 * record of it.
 *
 * Lives in its own file rather than extending `trajectory-logger.test.ts`,
 * which is already over the FR-006 500-line cap; growing it would trip the
 * diff-scoped ratchet.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	clearDeniedCallMarkers,
	createTrajectoryLoggerHook,
	recordDeniedToolCall,
	recordToolCallStart,
	type TrajectoryEntry,
} from '../../../src/hooks/trajectory-logger';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { withFrozenClockAsync } from '../../helpers/test-clock';

const { deriveAction } = _test_exports;

let tempDir: string;

function prmStorePath(sessionId: string): string {
	return path.join(tempDir, '.swarm', 'trajectories', `${sessionId}.jsonl`);
}

function evidencePath(taskId: string): string {
	return path.join(tempDir, '.swarm', 'evidence', taskId, 'trajectory.jsonl');
}

function readEntries(file: string): TrajectoryEntry[] {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as TrajectoryEntry);
}

/** A session inside delegation scope, which is the only scope D1 records in. */
function delegatedSession(sessionId: string, taskId?: string) {
	startAgentSession(sessionId, 'coder');
	const session = swarmState.agentSessions.get(sessionId);
	if (!session) throw new Error('session not created');
	session.delegationActive = true;
	session.currentTaskId = taskId;
	return session;
}

beforeEach(() => {
	resetSwarmState();
	clearDeniedCallMarkers();
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(tmpdir(), 'traj-denied-')),
	);
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	if (tempDir && fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
	resetSwarmState();
	clearDeniedCallMarkers();
});

describe('recordDeniedToolCall', () => {
	test('writes a failure entry to the PRM store and skips the evidence copy when there is no currentTaskId', async () => {
		const sessionId = 'denied-no-task';
		delegatedSession(sessionId);

		await recordDeniedToolCall(
			sessionId,
			{
				tool: 'Task',
				callID: 'call-1',
				args: { subagent_type: 'reviewer', description: 'review task 1.1' },
			},
			'SCOPE_NOT_DECLARED: task 1.1 has no active scope binding',
			tempDir,
		);

		const entries = readEntries(prmStorePath(sessionId));
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			step: 1,
			agent: 'coder',
			action: 'delegate',
			target: 'reviewer',
			intent: 'denied: SCOPE_NOT_DECLARED',
			result: 'failure',
			verdict: 'failure',
			tool: 'Task',
			callID: 'call-1',
		});

		// No task id => nothing under .swarm/evidence at all.
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'evidence'))).toBe(false);
	});

	test('writes both the PRM store and the task-evidence copy when currentTaskId is set', async () => {
		const sessionId = 'denied-with-task';
		delegatedSession(sessionId, '1.1');

		await recordDeniedToolCall(
			sessionId,
			{ tool: 'write', callID: 'call-2', args: { filePath: '/src/app.ts' } },
			'SCOPE_WORKSPACE_MISMATCH: resolved root differs',
			tempDir,
		);

		const prm = readEntries(prmStorePath(sessionId));
		const evidence = readEntries(evidencePath('1.1'));
		expect(prm).toHaveLength(1);
		expect(evidence).toHaveLength(1);
		expect(evidence[0].intent).toBe('denied: SCOPE_WORKSPACE_MISMATCH');
		expect(evidence[0].action).toBe('edit');
		expect(evidence[0].target).toBe('/src/app.ts');
		// Both copies are the same entry, including the shared step.
		expect(evidence[0].step).toBe(prm[0].step);
	});

	test('records nothing outside delegation scope (the architect session stays excluded)', async () => {
		const sessionId = 'denied-architect';
		startAgentSession(sessionId, 'architect');
		const session = swarmState.agentSessions.get(sessionId);
		if (!session) throw new Error('session not created');
		session.delegationActive = false;
		session.currentTaskId = '1.1';

		await recordDeniedToolCall(
			sessionId,
			{ tool: 'Task', callID: 'call-3', args: {} },
			'ACCEPTANCE_FIELD_REQUIRED: task 1.1',
			tempDir,
		);

		expect(fs.existsSync(prmStorePath(sessionId))).toBe(false);
		expect(fs.existsSync(evidencePath('1.1'))).toBe(false);
	});

	test('an unknown session is a silent no-op', async () => {
		await expect(
			recordDeniedToolCall(
				'never-started',
				{ tool: 'read', callID: 'call-4' },
				'SCOPE_NOT_DECLARED: nope',
				tempDir,
			),
		).resolves.toBeUndefined();
		expect(fs.existsSync(prmStorePath('never-started'))).toBe(false);
	});

	test('redacts sensitive args and classifies an unparseable message as UNCLASSIFIED', async () => {
		const sessionId = 'denied-redact';
		delegatedSession(sessionId);

		await recordDeniedToolCall(
			sessionId,
			{
				tool: 'bash',
				callID: 'call-5',
				args: { command: 'curl api', api_key: 'sk-secret-value' },
			},
			'Blocked by skill propagation gate',
			tempDir,
		);

		const entries = readEntries(prmStorePath(sessionId));
		expect(entries[0].intent).toBe('denied: UNCLASSIFIED');
		expect(entries[0].action).toBe('execute');
		expect(entries[0].target).toBe('curl');
		expect(entries[0].args_summary).toContain('api_key:[REDACTED]');
		expect(entries[0].args_summary).not.toContain('sk-secret-value');
	});

	test('records elapsed time from the toolBefore start marker', async () => {
		const sessionId = 'denied-elapsed';
		const fixedNow = 1_700_000_000_000;

		await withFrozenClockAsync(
			async () => {
				delegatedSession(sessionId);
				recordToolCallStart(sessionId, 'call-6', fixedNow - 150);

				await recordDeniedToolCall(
					sessionId,
					{ tool: 'Task', callID: 'call-6', args: {} },
					'FULL_AUTO_DELEGATION_DENY: unknown role',
					tempDir,
				);
			},
			{ fixedNow },
		);

		const entries = readEntries(prmStorePath(sessionId));
		expect(entries[0].elapsed_ms).toBe(150);
	});
});

describe('fail-open contract (never blocks the B1 rethrow)', () => {
	test('a broken store path is swallowed and the call still resolves', async () => {
		const sessionId = 'denied-store-broken';
		delegatedSession(sessionId, '1.1');

		// Occupy `.swarm/trajectories` and `.swarm/evidence` with FILES so both
		// mkdir calls fail. This is the closest cross-platform stand-in for an
		// unwritable store.
		fs.writeFileSync(path.join(tempDir, '.swarm', 'trajectories'), 'x');
		fs.writeFileSync(path.join(tempDir, '.swarm', 'evidence'), 'x');

		await expect(
			recordDeniedToolCall(
				sessionId,
				{ tool: 'Task', callID: 'call-7', args: {} },
				'SCOPE_NOT_DECLARED: boom',
				tempDir,
			),
		).resolves.toBeUndefined();
	});

	test('a path-traversal directory is swallowed rather than thrown', async () => {
		const sessionId = 'denied-bad-dir';
		delegatedSession(sessionId, '../../escape');

		await expect(
			recordDeniedToolCall(
				sessionId,
				{ tool: 'Task', callID: 'call-8', args: {} },
				'SCOPE_NOT_DECLARED: boom',
				tempDir,
			),
		).resolves.toBeUndefined();
		expect(fs.existsSync(path.join(tempDir, '..', '..', 'escape'))).toBe(false);
	});
});

describe('callID dedupe', () => {
	test('a toolAfter for an already-denied call does not double-record or burn a step', async () => {
		const sessionId = 'denied-dedupe';
		delegatedSession(sessionId, '1.1');
		const hook = createTrajectoryLoggerHook(
			{ enabled: true, max_lines: 500 },
			tempDir,
		);

		await recordDeniedToolCall(
			sessionId,
			{ tool: 'Task', callID: 'call-dup', args: { subagent_type: 'coder' } },
			'SCOPE_NOT_DECLARED: denied',
			tempDir,
		);

		// The host is not expected to fire toolAfter here, but if it does the
		// entry must not be recorded twice.
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: sessionId,
				callID: 'call-dup',
				args: { subagent_type: 'coder' },
			},
			{ title: 'Task', output: '', metadata: { success: true } },
		);

		const prm = readEntries(prmStorePath(sessionId));
		expect(prm).toHaveLength(1);
		expect(prm[0].result).toBe('failure');
		expect(readEntries(evidencePath('1.1'))).toHaveLength(1);

		// The skipped toolAfter must not have consumed a trajectory step —
		// otherwise the shared counter desyncs PRM's step-range filter.
		await hook.toolAfter(
			{
				tool: 'read',
				sessionID: sessionId,
				callID: 'call-next',
				args: { filePath: '/a.ts' },
			},
			{ title: 'Read', output: 'ok', metadata: { success: true } },
		);
		const after = readEntries(prmStorePath(sessionId));
		expect(after).toHaveLength(2);
		expect(after.map((e) => e.step)).toEqual([1, 2]);
	});

	test('the marker is one-shot — a later call reusing the id is recorded normally', async () => {
		const sessionId = 'denied-dedupe-oneshot';
		// A task id is required for the normal `toolAfter` path to record at all.
		delegatedSession(sessionId, '3.1');
		const hook = createTrajectoryLoggerHook(
			{ enabled: true, max_lines: 500 },
			tempDir,
		);
		const input = {
			tool: 'read',
			sessionID: sessionId,
			callID: 'call-reused',
			args: { filePath: '/a.ts' },
		};
		const output = { title: 'Read', output: 'ok', metadata: { success: true } };

		await recordDeniedToolCall(
			sessionId,
			{ tool: 'read', callID: 'call-reused', args: { filePath: '/a.ts' } },
			'SCOPE_NOT_DECLARED: denied',
			tempDir,
		);
		await hook.toolAfter(input, output); // consumes the marker, skips
		await hook.toolAfter(input, output); // marker gone, records normally

		const entries = readEntries(prmStorePath(sessionId));
		expect(entries).toHaveLength(2);
		expect(entries[0].result).toBe('failure');
		expect(entries[1].result).toBe('success');
	});

	test('the marker registry is bounded', async () => {
		const sessionId = 'denied-dedupe-bound';
		delegatedSession(sessionId);
		const cap = _test_exports.MAX_DENIED_CALL_MARKERS;
		for (let i = 0; i <= cap; i++) {
			await recordDeniedToolCall(
				sessionId,
				{ tool: 'read', callID: `bulk-${i}` },
				'SCOPE_NOT_DECLARED: denied',
				tempDir,
			);
		}
		expect(_test_exports.deniedCallMarkerCount()).toBeLessThanOrEqual(cap);
	});
});

describe('step continuity with interleaved toolAfter entries', () => {
	test('denied and executed calls share one monotonic step counter', async () => {
		const sessionId = 'denied-steps';
		delegatedSession(sessionId, '2.1');
		const hook = createTrajectoryLoggerHook(
			{ enabled: true, max_lines: 500 },
			tempDir,
		);

		await hook.toolAfter(
			{
				tool: 'read',
				sessionID: sessionId,
				callID: 'c1',
				args: { filePath: '/a.ts' },
			},
			{ title: 'Read', output: 'ok', metadata: { success: true } },
		);
		await recordDeniedToolCall(
			sessionId,
			{ tool: 'Task', callID: 'c2', args: { subagent_type: 'reviewer' } },
			'SCOPE_NOT_DECLARED: denied',
			tempDir,
		);
		await hook.toolAfter(
			{
				tool: 'write',
				sessionID: sessionId,
				callID: 'c3',
				args: { filePath: '/b.ts' },
			},
			{ title: 'Write', output: 'ok', metadata: { success: true } },
		);
		await recordDeniedToolCall(
			sessionId,
			{ tool: 'Task', callID: 'c4', args: { subagent_type: 'reviewer' } },
			'SCOPE_NOT_DECLARED: denied',
			tempDir,
		);

		const entries = readEntries(prmStorePath(sessionId));
		expect(entries.map((e) => e.step)).toEqual([1, 2, 3, 4]);
		expect(entries.map((e) => e.result)).toEqual([
			'success',
			'failure',
			'success',
			'failure',
		]);
	});
});

describe('deriveAction taxonomy (D2)', () => {
	test('normalizes host tool namespaces before bucketing', () => {
		// Previously every namespaced name fell through to `tool_use`, flattening
		// the taxonomy PRM pattern detection reads.
		expect(deriveAction('opencode:bash')).toBe('execute');
		expect(deriveAction('opencode.bash')).toBe('execute');
		expect(deriveAction('opencode:Task')).toBe('delegate');
		expect(deriveAction('mega:write')).toBe('edit');
		expect(deriveAction('swarm:test_runner')).toBe('test');
	});

	test('grep is a read action', () => {
		// `grep` was missing from the read bucket despite being one of the most
		// frequent read-only calls, so it was recorded as `tool_use`.
		expect(deriveAction('Grep')).toBe('read');
		expect(deriveAction('grep')).toBe('read');
		expect(deriveAction('opencode:grep')).toBe('read');
	});

	test('the pre-existing buckets are unchanged', () => {
		expect(deriveAction('Task')).toBe('delegate');
		expect(deriveAction('write')).toBe('edit');
		expect(deriveAction('Edit')).toBe('edit');
		expect(deriveAction('apply_patch')).toBe('edit');
		expect(deriveAction('swarm_apply_patch')).toBe('edit');
		expect(deriveAction('read')).toBe('read');
		expect(deriveAction('glob')).toBe('read');
		expect(deriveAction('search')).toBe('read');
		expect(deriveAction('shell')).toBe('execute');
		expect(deriveAction('test_runner')).toBe('test');
		expect(deriveAction('some_unknown_tool')).toBe('tool_use');
		expect(deriveAction('')).toBe('tool_use');
	});
});
