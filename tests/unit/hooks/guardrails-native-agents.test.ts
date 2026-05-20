/**
 * Tests for opencode native agent exemption from swarm guardrails (issue #559).
 *
 * Native agents (build, plan, general, explore, …) are not part of the swarm
 * workflow. They must be fully transparent to the swarm guardrail system:
 *   - No write-authority blocks (DEFAULT_AGENT_AUTHORITY_RULES pass-through)
 *   - No circuit-breaker / invocation-window tracking (resolveSessionAndWindow → null)
 *
 * Because resolveSessionAndWindow is a closure-local function, circuit-breaker
 * exemption is verified indirectly: exhaust the max_tool_calls limit for a swarm
 * agent to confirm limits apply, then verify native agents are not blocked even
 * after the same number of calls.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import * as os from 'node:os';
import { OPENCODE_NATIVE_AGENTS } from '../../../src/config/constants.js';
import type { GuardrailsConfig } from '../../../src/config/schema.js';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails.js';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state.js';

const TEST_DIR = os.tmpdir();

function cfg(overrides?: Partial<GuardrailsConfig>): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 5,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

describe('OPENCODE_NATIVE_AGENTS constant', () => {
	it('contains the expected built-in agent names', () => {
		expect(OPENCODE_NATIVE_AGENTS.has('build')).toBe(true);
		expect(OPENCODE_NATIVE_AGENTS.has('plan')).toBe(true);
		expect(OPENCODE_NATIVE_AGENTS.has('general')).toBe(true);
		expect(OPENCODE_NATIVE_AGENTS.has('explore')).toBe(true);
	});

	it('does not contain swarm agent names', () => {
		expect(OPENCODE_NATIVE_AGENTS.has('architect' as never)).toBe(false);
		expect(OPENCODE_NATIVE_AGENTS.has('coder' as never)).toBe(false);
		expect(OPENCODE_NATIVE_AGENTS.has('reviewer' as never)).toBe(false);
	});
});

describe('Native agent write-authority pass-through via toolBefore (issue #559)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('build agent write is not blocked (exact repro: issue #559)', async () => {
		const sid = 'native-build-session';
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, cfg());
		startAgentSession(sid, 'build');

		// Must not throw — was previously blocked with "Unknown agent: build"
		await hooks.toolBefore(
			{ tool: 'write', sessionID: sid, callID: 'call-1' },
			{ args: { filePath: 'eslint.config.mts', content: '' } },
		);
	});

	it('plan agent write is not blocked', async () => {
		const sid = 'native-plan-session';
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, cfg());
		startAgentSession(sid, 'plan');

		await hooks.toolBefore(
			{ tool: 'write', sessionID: sid, callID: 'call-2' },
			{ args: { filePath: 'src/component.tsx', content: '' } },
		);
	});

	it('general agent write is not blocked', async () => {
		const sid = 'native-general-session';
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, cfg());
		startAgentSession(sid, 'general');

		await hooks.toolBefore(
			{ tool: 'write', sessionID: sid, callID: 'call-3' },
			{ args: { filePath: 'lib/utils.ts', content: '' } },
		);
	});

	it('explore agent write is not blocked', async () => {
		const sid = 'native-explore-session';
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, cfg());
		startAgentSession(sid, 'explore');

		await hooks.toolBefore(
			{ tool: 'write', sessionID: sid, callID: 'call-4' },
			{ args: { filePath: 'output.txt', content: '' } },
		);
	});
});

describe('Native agent circuit-breaker exemption via toolBefore', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('swarm agent (coder) is blocked after exceeding max_tool_calls', async () => {
		const limit = 3;
		const sid = 'cb-swarm-session';
		const hooks = createGuardrailsHooks(
			TEST_DIR,
			undefined,
			cfg({
				max_tool_calls: limit,
				profiles: { coder: { max_tool_calls: limit } },
			}),
		);
		startAgentSession(sid, 'coder');

		// Fill to one below the limit (the limit-th call is the one that throws)
		for (let i = 0; i < limit - 1; i++) {
			await hooks.toolBefore(
				{ tool: 'read', sessionID: sid, callID: `read-${i}` },
				{ args: { filePath: `/test${i}.ts` } },
			);
		}

		// The limit-th call must be blocked by the circuit breaker
		await expect(
			hooks.toolBefore(
				{ tool: 'read', sessionID: sid, callID: 'read-limit' },
				{ args: { filePath: '/test-limit.ts' } },
			),
		).rejects.toThrow();
	});

	it('build agent is NOT blocked after exceeding swarm max_tool_calls limit', async () => {
		const limit = 3;
		const sid = 'cb-build-session';
		const hooks = createGuardrailsHooks(
			TEST_DIR,
			undefined,
			cfg({ max_tool_calls: limit }),
		);
		startAgentSession(sid, 'build');

		// Make more calls than the limit — native agents must never be blocked
		for (let i = 0; i <= limit + 2; i++) {
			await hooks.toolBefore(
				{ tool: 'read', sessionID: sid, callID: `read-${i}` },
				{ args: { filePath: `/test${i}.ts` } },
			);
		}
	});
});
