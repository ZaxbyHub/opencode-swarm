/**
 * Issue #2041 — restart step monotonicity.
 *
 * The process-local step counters used to reset to 1 on restart, duplicating
 * step numbers against the persisted session trajectory. The logger now seeds
 * from the store's bounded high-water mark (`getCurrentStep`) before the
 * first mint of a session; reset/clear paths invalidate the seed gate so a
 * mid-flow `/swarm reset` re-seeds instead of rewinding.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	clearTrajectoryStep,
	createTrajectoryLoggerHook,
	_test_exports as loggerInternals,
	recordDeniedToolCall,
	recordToolCallStart,
} from '../../../src/hooks/trajectory-logger';
import {
	clearTrajectoryCache,
	readTrajectory,
} from '../../../src/prm/trajectory-store';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

// FR-011 (issue #1737): canonicalize the macOS /var symlink gap.
const canonicalTmp = fs.realpathSync(os.tmpdir());

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(canonicalTmp, 'traj-restart-'));
}

/** Simulates a process restart: every module-level session state is dropped. */
function simulateRestart(): void {
	clearTrajectoryCache();
	clearTrajectoryStep(); // clears every session's step counter + seed gate
	loggerInternals.clearStepSeedGate();
}

function makeDelegatingSession(sessionId: string, taskId = '1.1'): void {
	startAgentSession(sessionId, 'coder');
	const session = swarmState.agentSessions.get(sessionId)!;
	session.delegationActive = true;
	session.currentTaskId = taskId;
}

/** Fixed call-start instant: elapsed_ms is never asserted here.
 * (tests/unit is covered by the test-clock lint — no raw clock reads.) */
const CALL_START_MS = 1_700_000_000_000;

async function readSessionSteps(
	tempDir: string,
	sessionId: string,
): Promise<number[]> {
	const entries = await readTrajectory(sessionId, tempDir);
	return entries.map((e) => e.step);
}

describe('trajectory restart step seeding (issue #2041)', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		resetSwarmState();
	});

	test('after a restart, the next minted step continues past the persisted high-water mark', async () => {
		const sessionId = 'ses-restart';
		const hook = createTrajectoryLoggerHook(
			{ enabled: true, max_lines: 1000 },
			tempDir,
		);

		// First "process": three tool calls mint steps 1..3.
		makeDelegatingSession(sessionId);
		for (let i = 1; i <= 3; i++) {
			recordToolCallStart(sessionId, `call-${i}`, CALL_START_MS);
			await hook.toolAfter(
				{ tool: 'Read', sessionID: sessionId, callID: `call-${i}`, args: {} },
				{ title: 't', output: 'ok', metadata: { success: true } },
			);
		}
		expect(await readSessionSteps(tempDir, sessionId)).toEqual([1, 2, 3]);

		// Restart: all in-process state gone, the file (and its steps) remain.
		resetSwarmState();
		simulateRestart();
		makeDelegatingSession(sessionId);

		recordToolCallStart(sessionId, 'call-4', CALL_START_MS);
		await hook.toolAfter(
			{ tool: 'Read', sessionID: sessionId, callID: 'call-4', args: {} },
			{ title: 't', output: 'ok', metadata: { success: true } },
		);

		// Step 4 — NOT a duplicate step 1 — lands on the session trajectory.
		const steps = await readTrajectory(sessionId, tempDir).then((entries) =>
			entries.map((e) => e.step),
		);
		expect(steps).toEqual([1, 2, 3, 4]);
	});

	test('the denied-call path seeds too: a post-restart denial mints N+1', async () => {
		const sessionId = 'ses-denied-restart';
		const hook = createTrajectoryLoggerHook(
			{ enabled: true, max_lines: 1000 },
			tempDir,
		);

		makeDelegatingSession(sessionId);
		recordToolCallStart(sessionId, 'call-1', CALL_START_MS);
		await hook.toolAfter(
			{ tool: 'Read', sessionID: sessionId, callID: 'call-1', args: {} },
			{ title: 't', output: 'ok', metadata: { success: true } },
		);

		resetSwarmState();
		simulateRestart();
		makeDelegatingSession(sessionId);

		await recordDeniedToolCall(
			sessionId,
			{ tool: 'Bash', callID: 'call-2', args: { command: 'rm -rf /' } },
			'SCOPE_NOT_DECLARED: denied',
			tempDir,
			{ maxLines: 1000 },
		);

		const steps = await readTrajectory(sessionId, tempDir).then((entries) =>
			entries.map((e) => e.step),
		);
		expect(steps).toEqual([1, 2]);
	});

	test('a fresh session (no persisted trajectory) still starts at step 1', async () => {
		const sessionId = 'ses-fresh';
		const hook = createTrajectoryLoggerHook(
			{ enabled: true, max_lines: 1000 },
			tempDir,
		);
		makeDelegatingSession(sessionId);

		recordToolCallStart(sessionId, 'call-1', CALL_START_MS);
		await hook.toolAfter(
			{ tool: 'Read', sessionID: sessionId, callID: 'call-1', args: {} },
			{ title: 't', output: 'ok', metadata: { success: true } },
		);

		expect(await readSessionSteps(tempDir, sessionId)).toEqual([1]);
	});

	test('clearTrajectoryStep invalidates the seed gate: the next mint re-seeds from disk', async () => {
		const sessionId = 'ses-reset';
		const hook = createTrajectoryLoggerHook(
			{ enabled: true, max_lines: 1000 },
			tempDir,
		);

		makeDelegatingSession(sessionId);
		recordToolCallStart(sessionId, 'call-1', CALL_START_MS);
		await hook.toolAfter(
			{ tool: 'Read', sessionID: sessionId, callID: 'call-1', args: {} },
			{ title: 't', output: 'ok', metadata: { success: true } },
		);
		expect(await readSessionSteps(tempDir, sessionId)).toEqual([1]);

		// `/swarm reset` clears the counter AND the gate — the next mint must
		// re-seed from the persisted mark instead of rewinding to 1.
		clearTrajectoryStep(sessionId);
		recordToolCallStart(sessionId, 'call-2', CALL_START_MS);
		await hook.toolAfter(
			{ tool: 'Read', sessionID: sessionId, callID: 'call-2', args: {} },
			{ title: 't', output: 'ok', metadata: { success: true } },
		);

		const steps = await readTrajectory(sessionId, tempDir).then((entries) =>
			entries.map((e) => e.step),
		);
		expect(steps).toEqual([1, 2]); // no duplicate step 1
	});

	test('concurrent first toolAfters after a restart mint distinct, monotonic steps', async () => {
		const sessionId = 'ses-concurrent';
		// Persist two steps, then "restart".
		const hook = createTrajectoryLoggerHook(
			{ enabled: true, max_lines: 1000 },
			tempDir,
		);
		makeDelegatingSession(sessionId);
		for (let i = 1; i <= 2; i++) {
			recordToolCallStart(sessionId, `call-${i}`, CALL_START_MS);
			await hook.toolAfter(
				{ tool: 'Read', sessionID: sessionId, callID: `call-${i}`, args: {} },
				{ title: 't', output: 'ok', metadata: { success: true } },
			);
		}

		resetSwarmState();
		simulateRestart();
		makeDelegatingSession(sessionId);

		// Race the seed gate with concurrent first calls.
		await Promise.all(
			['call-3', 'call-4', 'call-5'].map((callID, i) =>
				hook.toolAfter(
					{ tool: 'Read', sessionID: sessionId, callID, args: {} },
					{ title: 't', output: 'ok', metadata: { success: true, n: i } },
				),
			),
		);

		const steps = await readTrajectory(sessionId, tempDir).then((entries) =>
			entries.map((e) => e.step).sort((a, b) => a - b),
		);
		expect(steps).toEqual([1, 2, 3, 4, 5]); // no duplicates, no rewinds
	});
});
