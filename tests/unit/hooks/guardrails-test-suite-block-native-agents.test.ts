/**
 * Issue #3320 AC7: in-session full test-suite blocking must be scoped to
 * swarm execution agents — NOT OpenCode native agents.
 *
 * `handleTestSuiteBlocking` (src/hooks/guardrails/tool-before.ts) throws
 * `BLOCKED: Full test suite execution is not allowed in-session...` for a
 * bash/shell `bun test` command with no file argument. At base the call site
 * is gated only on `enforcePolicy` with NO agent scoping, so sessions whose
 * resolved identity is a native OpenCode agent (`build`, `plan`, `general`)
 * get blocked too — those sessions are managed entirely by OpenCode's own
 * permission system (see OPENCODE_NATIVE_AGENTS) and must not be denied by
 * swarm guardrails.
 *
 * Discriminating rows (build / plan / general resolve the call) are RED at
 * base, GREEN after the fix. Control rows (architect / coder are still
 * blocked with the exact message) are GREEN at base and head.
 *
 * The hook is driven directly (createGuardrailsHooks), mirroring
 * tests/integration/architect-identity-stuck.test.ts and
 * tests/unit/hooks/destructive-command-guard.test.ts, with the session
 * identity established the way the delegation tracker does in production:
 * swarmState.activeAgent.set + ensureAgentSession.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const TEST_SUITE_BLOCK_MESSAGE =
	'BLOCKED: Full test suite execution is not allowed in-session. Run a specific test file instead: bun test path/to/file.test.ts';

describe('Guardrails test-suite blocking — native agent scoping (issue #3320 AC7)', () => {
	let testDir: string;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

	beforeEach(() => {
		resetSwarmState();
		isolatedEnv = createIsolatedTestEnv();
		testDir = canonicalMkdtemp('test-suite-block-native-');
		// The shell-audit side channel appends under <dir>/.swarm.
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		removeTreeWithRetry(testDir);
		isolatedEnv.cleanup();
	});

	function makeHooks() {
		const config: GuardrailsConfig = {
			enabled: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			idle_timeout_minutes: 60,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			warning_threshold: 0.75,
			block_destructive_commands: true,
		};
		return createGuardrailsHooks(testDir, undefined, config);
	}

	/** Establishes the session's resolved identity exactly like chat.message does. */
	function seedIdentity(sessionId: string, agent: string): void {
		swarmState.activeAgent.set(sessionId, agent);
		ensureAgentSession(sessionId, agent);
	}

	/**
	 * Invokes the real toolBefore hook and returns the thrown message (or null
	 * when the call resolved). try/catch instead of `resolves.toBeUndefined()`
	 * so a base failure prints the exact BLOCKED text in the assertion diff.
	 */
	async function callBunTestSuite(
		hooks: ReturnType<typeof createGuardrailsHooks>,
		sessionId: string,
		callId: string,
	): Promise<string | null> {
		try {
			await hooks.toolBefore(
				{ tool: 'bash', sessionID: sessionId, callID: callId },
				// Parsed by handleTestSuiteBlocking via args.command — `bun test`
				// with no file token matches the runner prefix and has no file arg.
				{ args: { command: 'bun test' } },
			);
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	describe('native OpenCode agents are NOT blocked (RED at base, GREEN after the fix)', () => {
		it("resolves 'bun test' for a build session", async () => {
			const hooks = makeHooks();
			seedIdentity('sess-build', 'build');
			// Base: handleTestSuiteBlocking has no agent scoping, so this throws
			// the full-suite BLOCKED message. Expected: native agents are exempt.
			const thrown = await callBunTestSuite(
				hooks,
				'sess-build',
				'call-build-1',
			);
			expect(thrown).toBeNull();
		});

		it("resolves 'bun test' for a plan session", async () => {
			const hooks = makeHooks();
			seedIdentity('sess-plan', 'plan');
			const thrown = await callBunTestSuite(hooks, 'sess-plan', 'call-plan-1');
			expect(thrown).toBeNull();
		});

		it("resolves 'bun test' for a general session", async () => {
			const hooks = makeHooks();
			seedIdentity('sess-general', 'general');
			const thrown = await callBunTestSuite(
				hooks,
				'sess-general',
				'call-general-1',
			);
			expect(thrown).toBeNull();
		});
	});

	describe('swarm execution agents are still blocked (GREEN at base and head)', () => {
		it("blocks 'bun test' for an architect session with the exact message", async () => {
			const hooks = makeHooks();
			seedIdentity('sess-architect', 'architect');
			const thrown = await callBunTestSuite(
				hooks,
				'sess-architect',
				'call-arch-1',
			);
			expect(thrown).toBe(TEST_SUITE_BLOCK_MESSAGE);
		});

		it("blocks 'bun test' for a coder session with the exact message", async () => {
			const hooks = makeHooks();
			seedIdentity('sess-coder', 'coder');
			const thrown = await callBunTestSuite(
				hooks,
				'sess-coder',
				'call-coder-1',
			);
			expect(thrown).toBe(TEST_SUITE_BLOCK_MESSAGE);
		});

		it("resolves 'bun test <file>' for a coder session — the file-arg escape hatch is not the block", async () => {
			// Control proving the block keys on the MISSING file argument, not on
			// the agent being allowed to run bun at all: a targeted file run
			// resolves even for the agents that ARE blocked on the bare suite.
			const hooks = makeHooks();
			seedIdentity('sess-coder-file', 'coder');
			await expect(
				hooks.toolBefore(
					{
						tool: 'bash',
						sessionID: 'sess-coder-file',
						callID: 'call-coder-file',
					},
					{ args: { command: 'bun test tests/unit/foo.test.ts' } },
				),
			).resolves.toBeUndefined();
		});
	});
});
