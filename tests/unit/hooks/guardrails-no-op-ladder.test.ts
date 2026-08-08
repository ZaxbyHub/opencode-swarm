/**
 * No-op detector: two-stage advisory ladder (issue #2063 B2).
 *
 * Stage 1 (at `no_op_warning_threshold`) observes that the session has made N
 * tool calls with no file write and no subagent dispatch. A session that
 * ignores it used to hear nothing further, ever — the latch stayed set until a
 * write or dispatch, which by definition never arrives in the wedged case. The
 * observed failure was an architect that kept probing for hundreds of calls
 * after the single advisory scrolled out of its attention.
 *
 * Stage 2 fires at 2× the threshold with a directive ("STOP investigating;
 * report BLOCKED …") behind its OWN latch. A shared latch would make stage 2
 * structurally unreachable, since stage 1 always latches first.
 *
 * Both rungs are advisory by design: read-only modes legitimately make hundreds
 * of non-write calls, so denying here would break correct workflows.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	type TelemetryEvent,
	_internals as telemetryInternals,
} from '../../../src/telemetry';

const TEST_DIR = '/test/project';
const THRESHOLD = 15;
const STRONG_THRESHOLD = THRESHOLD * 2;

const config: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 2000,
	max_duration_minutes: 300,
	max_repetitions: 10_000,
	max_consecutive_errors: 5000,
	warning_threshold: 0.99,
	idle_timeout_minutes: 600,
	no_op_warning_threshold: THRESHOLD,
} as unknown as GuardrailsConfig;

const STAGE_1_MARKER = 'tool calls with no file modifications';
const STAGE_2_MARKER = 'STOP investigating; report BLOCKED to the user now';

function advisoriesFor(sessionId: string): string[] {
	return swarmState.agentSessions.get(sessionId)?.pendingAdvisoryMessages ?? [];
}

function stage1(sessionId: string): string[] {
	return advisoriesFor(sessionId).filter(
		(m) => m.startsWith('WARNING:') && m.includes(STAGE_1_MARKER),
	);
}

function stage2(sessionId: string): string[] {
	return advisoriesFor(sessionId).filter((m) => m.includes(STAGE_2_MARKER));
}

async function readCall(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionId: string,
	n: number,
): Promise<void> {
	await hooks.toolAfter(
		{
			tool: 'read',
			sessionID: sessionId,
			callID: `read-${n}`,
			args: { filePath: `/test/project/file-${n}.ts` },
		} as never,
		{ title: 'read', output: 'file contents', metadata: {} } as never,
	);
}

async function writeCall(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionId: string,
	n: number,
): Promise<void> {
	await hooks.toolAfter(
		{
			tool: 'write',
			sessionID: sessionId,
			callID: `write-${n}`,
			args: { filePath: `/test/project/out-${n}.ts`, content: 'x' },
		} as never,
		{ title: 'write', output: 'ok', metadata: {} } as never,
	);
}

function setupArchitect(sessionId: string): void {
	ensureAgentSession(sessionId, 'architect');
	swarmState.activeAgent.set(sessionId, 'architect');
}

describe('no-op ladder: two stages, distinct latches (#2063 B2)', () => {
	beforeEach(() => resetSwarmState());
	afterEach(() => resetSwarmState());

	test('stage 1 fires at the threshold and stage 2 does NOT', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, config);
		const sessionId = 'ladder-stage1-only';
		setupArchitect(sessionId);

		for (let i = 0; i < THRESHOLD; i++) await readCall(hooks, sessionId, i);

		expect(stage1(sessionId)).toHaveLength(1);
		expect(stage2(sessionId)).toHaveLength(0);
	});

	test('stage 2 fires at 2× the threshold even though stage 1 is latched', async () => {
		// The regression: one shared latch made this unreachable. Stage 1 latches
		// at 15 and only clears on progress, so at 30 the strong rung tested a
		// latch that was already held and produced nothing.
		const hooks = createGuardrailsHooks(TEST_DIR, config);
		const sessionId = 'ladder-stage2';
		setupArchitect(sessionId);

		for (let i = 0; i < STRONG_THRESHOLD; i++)
			await readCall(hooks, sessionId, i);

		expect(stage1(sessionId)).toHaveLength(1);
		expect(stage2(sessionId)).toHaveLength(1);
		expect(stage2(sessionId)[0]).toContain(`${STRONG_THRESHOLD} tool calls`);
	});

	test('stage 2 does not repeat once latched', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, config);
		const sessionId = 'ladder-stage2-latched';
		setupArchitect(sessionId);

		for (let i = 0; i < STRONG_THRESHOLD + 12; i++)
			await readCall(hooks, sessionId, i);

		expect(stage1(sessionId)).toHaveLength(1);
		expect(stage2(sessionId)).toHaveLength(1);
	});

	test('a write re-arms BOTH latches', async () => {
		// Leaving the stage-2 latch set after progress would silence the strong
		// rung for the rest of the session's life.
		const hooks = createGuardrailsHooks(TEST_DIR, config);
		const sessionId = 'ladder-rearm';
		setupArchitect(sessionId);

		for (let i = 0; i < STRONG_THRESHOLD; i++)
			await readCall(hooks, sessionId, i);
		expect(stage1(sessionId)).toHaveLength(1);
		expect(stage2(sessionId)).toHaveLength(1);

		await writeCall(hooks, sessionId, 0);
		// Drop the delivered advisories the way a real turn's drain would, so the
		// next assertions measure NEW emissions rather than the earlier ones.
		const session = swarmState.agentSessions.get(sessionId);
		if (session) session.pendingAdvisoryMessages = [];

		for (let i = 0; i < STRONG_THRESHOLD; i++)
			await readCall(hooks, sessionId, 1000 + i);

		expect(stage1(sessionId)).toHaveLength(1);
		expect(stage2(sessionId)).toHaveLength(1);
	});

	test('a subagent dispatch also re-arms both latches', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, config);
		const sessionId = 'ladder-rearm-dispatch';
		setupArchitect(sessionId);

		for (let i = 0; i < STRONG_THRESHOLD; i++)
			await readCall(hooks, sessionId, i);
		expect(stage2(sessionId)).toHaveLength(1);

		await hooks.toolAfter(
			{
				tool: 'Task',
				sessionID: sessionId,
				callID: 'task-1',
				args: { subagent_type: 'coder', prompt: 'implement' },
			} as never,
			{ title: 'Task', output: 'done', metadata: {} } as never,
		);
		const session = swarmState.agentSessions.get(sessionId);
		if (session) session.pendingAdvisoryMessages = [];

		for (let i = 0; i < STRONG_THRESHOLD; i++)
			await readCall(hooks, sessionId, 2000 + i);

		expect(stage1(sessionId)).toHaveLength(1);
		expect(stage2(sessionId)).toHaveLength(1);
	});

	test('the strong rung is derived as 2× a custom threshold (no separate key)', async () => {
		const customThreshold = 4;
		const customConfig = {
			...config,
			no_op_warning_threshold: customThreshold,
		} as GuardrailsConfig;
		const hooks = createGuardrailsHooks(TEST_DIR, customConfig);
		const sessionId = 'ladder-custom-threshold';
		setupArchitect(sessionId);

		for (let i = 0; i < customThreshold * 2 - 1; i++)
			await readCall(hooks, sessionId, i);
		expect(stage1(sessionId)).toHaveLength(1);
		expect(stage2(sessionId)).toHaveLength(0);

		await readCall(hooks, sessionId, 999);
		expect(stage2(sessionId)).toHaveLength(1);
	});

	test('stage 2 emits the no_op_strong_warning telemetry event exactly once', async () => {
		const emitted: Array<{
			event: TelemetryEvent;
			data: Record<string, unknown>;
		}> = [];
		const originalEmit = telemetryInternals.emit;
		telemetryInternals.emit = ((
			event: TelemetryEvent,
			data: Record<string, unknown>,
		) => {
			emitted.push({ event, data });
		}) as typeof originalEmit;

		try {
			const hooks = createGuardrailsHooks(TEST_DIR, config);
			const sessionId = 'ladder-telemetry';
			setupArchitect(sessionId);

			for (let i = 0; i < STRONG_THRESHOLD + 5; i++)
				await readCall(hooks, sessionId, i);

			const strong = emitted.filter((e) => e.event === 'no_op_strong_warning');
			expect(strong).toHaveLength(1);
			expect(strong[0].data.sessionId).toBe(sessionId);
			expect(strong[0].data.count).toBe(STRONG_THRESHOLD);
			expect(strong[0].data.threshold).toBe(STRONG_THRESHOLD);
		} finally {
			telemetryInternals.emit = originalEmit;
		}
	});

	test('neither rung denies the tool call — the ladder is advisory only', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, config);
		const sessionId = 'ladder-advisory-only';
		setupArchitect(sessionId);

		// toolAfter never throws, and toolBefore keeps admitting calls well past
		// the strong rung.
		for (let i = 0; i < STRONG_THRESHOLD + 10; i++) {
			await readCall(hooks, sessionId, i);
			await hooks.toolBefore(
				{ tool: 'read', sessionID: sessionId, callID: `before-${i}` } as never,
				{ args: { filePath: '/test/project/x.ts' } } as never,
			);
		}

		expect(stage2(sessionId)).toHaveLength(1);
	});
});
