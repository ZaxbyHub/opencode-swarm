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

import { beforeEach, describe, expect, it, onTestFinished } from 'bun:test';
import { OPENCODE_NATIVE_AGENTS } from '../../../src/config/constants.js';
import type { GuardrailsConfig } from '../../../src/config/schema.js';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails.js';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

/**
 * Issue #3608 (plan R2/R8): this suite used to pass the ambient temp root itself
 * as the guard root, so the denied build-agent write landed the shell-audit record at
 * `%TEMP%\.swarm\session\shell-audit.jsonl` — ambient pollution that slows and
 * destabilizes every later bun test process on the host (executed A/B: with the
 * artifact present, guardrails.test.ts runs 4-6x slower and its Attack-Vector-4
 * leg flakes). Each test now gets its own canonical temp root, removed when the
 * test finishes. Register onTestFinished from the factory invoked in the test
 * body — bun:test cannot register it from a describe block or a hook.
 */
function makeSandboxedHooks(overrides?: Parameters<typeof cfg>[0]) {
	const root = canonicalMkdtemp('guardrails-native-agents-');
	onTestFinished(() => removeTreeWithRetry(root));
	return createGuardrailsHooks(root, undefined, cfg(overrides));
}

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

	it('build agent writing eslint.config.mts is denied as verifier config (#3120 supersedes #559)', async () => {
		const sid = 'native-build-session';
		const hooks = makeSandboxedHooks();
		startAgentSession(sid, 'build');

		await expect(
			hooks.toolBefore(
				{ tool: 'write', sessionID: sid, callID: 'call-1' },
				{ args: { filePath: 'eslint.config.mts', content: '' } },
			),
		).rejects.toThrow('AUTHORITY_VERIFIER_CONFIG');
	});

	it('plan agent write is not blocked', async () => {
		const sid = 'native-plan-session';
		const hooks = makeSandboxedHooks();
		startAgentSession(sid, 'plan');

		await hooks.toolBefore(
			{ tool: 'write', sessionID: sid, callID: 'call-2' },
			{ args: { filePath: 'src/component.tsx', content: '' } },
		);
	});

	it('general agent write is not blocked', async () => {
		const sid = 'native-general-session';
		const hooks = makeSandboxedHooks();
		startAgentSession(sid, 'general');

		await hooks.toolBefore(
			{ tool: 'write', sessionID: sid, callID: 'call-3' },
			{ args: { filePath: 'lib/utils.ts', content: '' } },
		);
	});

	it('explore agent write is not blocked', async () => {
		const sid = 'native-explore-session';
		const hooks = makeSandboxedHooks();
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
		const hooks = makeSandboxedHooks({
			max_tool_calls: limit,
			profiles: { coder: { max_tool_calls: limit } },
		});
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
		const hooks = makeSandboxedHooks({ max_tool_calls: limit });
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
