/**
 * Regression test for the `output.parts` in-place mutation contract.
 *
 * Background: the OpenCode runtime invokes `command.execute.before` like
 *
 *     yield* plugin.trigger("command.execute.before", input, { parts })
 *
 * where the second argument is an inline wrapper around the outer `parts`
 * array. After the trigger returns, OpenCode discards the wrapper and uses
 * its outer `parts` variable to call `prompt(...)`.
 *
 * If the handler REASSIGNS `output.parts = [newArray]`, only the wrapper's
 * property changes — the outer `parts` reference still points at the old,
 * empty array and the LLM never sees the handler's text. This was the bug
 * fixed by switching the handler to in-place mutation (`splice`).
 *
 * Reference: upstream `packages/opencode/src/session/prompt.ts` discards
 * the trigger return value and reads from the local `parts` variable;
 * upstream `packages/opencode/src/plugin/index.ts` `Plugin.trigger` does
 * not propagate the wrapper object back.
 *
 * Note: This test does NOT assert LLM suppression. Current OpenCode runs
 * `prompt()` unconditionally after the hook (upstream issue
 * anomalyco/opencode#9306). All we can do plugin-side is ensure the
 * handler text reaches the LLM as its input.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../state';
import { createSwarmCommandHandler } from './index';

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-parts-mutation-test-'));
}

function makeSession(id: string): void {
	swarmState.agentSessions.set(id, {
		agentName: 'architect',
		lastToolCallTime: Date.now(),
		lastAgentEventTime: Date.now(),
		delegationActive: false,
		activeInvocationId: 0,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: new Map(),
		reviewerCallCount: new Map(),
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: new Set(),
		selfFixAttempted: false,
		selfCodingWarnedAtCount: 0,
		catastrophicPhaseWarnings: new Set(),
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		taskWorkflowStates: new Map(),
	});
}

describe('createSwarmCommandHandler — output.parts in-place mutation', () => {
	let tempDir: string;
	const sessionId = 'parts-mutation-test-session';

	beforeEach(() => {
		tempDir = makeTempDir();
		makeSession(sessionId);
		// Pre-create first-run sentinel so welcome banner does not appear
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, '.first-run-complete'),
			`first-run-complete: ${new Date().toISOString()}\n`,
		);
	});

	afterEach(() => {
		swarmState.agentSessions.delete(sessionId);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('mutates the existing parts array in place rather than reassigning', async () => {
		const handler = createSwarmCommandHandler(tempDir, {});
		const originalPartsRef: unknown[] = [];
		const output = { parts: originalPartsRef };

		await handler(
			{ command: 'swarm', arguments: 'help', sessionID: sessionId },
			output,
		);

		expect(output.parts).toBe(originalPartsRef);
		expect(output.parts).toHaveLength(1);
		const text = (output.parts[0] as { text: string }).text;
		expect(typeof text).toBe('string');
		expect(text.length).toBeGreaterThan(0);
	});

	it('mutates in place for swarm-* shortcut commands too', async () => {
		const handler = createSwarmCommandHandler(tempDir, {});
		const originalPartsRef: unknown[] = [];
		const output = { parts: originalPartsRef };

		await handler(
			{ command: 'swarm-agents', arguments: '', sessionID: sessionId },
			output,
		);

		expect(output.parts).toBe(originalPartsRef);
		expect(output.parts).toHaveLength(1);
	});

	it('mutates in place for the not-found path', async () => {
		const handler = createSwarmCommandHandler(tempDir, {});
		const originalPartsRef: unknown[] = [];
		const output = { parts: originalPartsRef };

		await handler(
			{
				command: 'swarm',
				arguments: 'definitely-not-a-real-subcommand',
				sessionID: sessionId,
			},
			output,
		);

		expect(output.parts).toBe(originalPartsRef);
		expect(output.parts).toHaveLength(1);
		const text = (output.parts[0] as { text: string }).text;
		expect(text).toContain('not found');
	});

	it('does NOT mutate parts when the command is not a swarm command', async () => {
		const handler = createSwarmCommandHandler(tempDir, {});
		const originalPartsRef: unknown[] = [];
		const output = { parts: originalPartsRef };

		await handler(
			{ command: 'unrelated', arguments: '', sessionID: sessionId },
			output,
		);

		expect(output.parts).toBe(originalPartsRef);
		expect(output.parts).toHaveLength(0);
	});

	it('replaces pre-existing parts entries on a swarm command', async () => {
		const handler = createSwarmCommandHandler(tempDir, {});
		const originalPartsRef: unknown[] = [
			{ type: 'text', text: 'pre-existing user input' },
		];
		const output = { parts: originalPartsRef };

		await handler(
			{ command: 'swarm', arguments: 'help', sessionID: sessionId },
			output,
		);

		expect(output.parts).toBe(originalPartsRef);
		expect(output.parts).toHaveLength(1);
		const text = (output.parts[0] as { text: string }).text;
		expect(text).not.toContain('pre-existing user input');
	});
});
