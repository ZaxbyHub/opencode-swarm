/**
 * Issue #3320 AC15 (PRESERVING row — GREEN at base and head): universal
 * destructive-command safety applies to OpenCode native agents too.
 *
 * Exempting native agents (`build`, `plan`, `general`) from swarm-only
 * policy gates (issue #3320) must NOT weaken the universal destructive
 * shell-command classifier. `git push --force` is blocked for EVERYONE via
 * the shared command classifier (`src/security/command-classifier.ts`,
 * `BLOCKED: Force push detected — git push --force is not allowed (use
 * --force-with-lease instead)`) before any agent-scoped logic matters.
 *
 * This entire file must PASS at base: it pins the non-defect that the
 * native-agent exemption must preserve.
 *
 * Harness mirrors tests/unit/hooks/destructive-command-guard.test.ts
 * (createGuardrailsHooks driven directly), with the session identity
 * established the way the delegation tracker does in production:
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

describe('Guardrails universal safety — native agents (issue #3320 AC15)', () => {
	let testDir: string;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

	beforeEach(() => {
		resetSwarmState();
		isolatedEnv = createIsolatedTestEnv();
		testDir = canonicalMkdtemp('native-agent-safety-');
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

	/**
	 * Runs `git push --force origin main` through the real toolBefore hook as
	 * the given agent and returns the thrown error message (null = allowed).
	 */
	async function attemptForcePush(
		hooks: ReturnType<typeof createGuardrailsHooks>,
		sessionId: string,
		callId: string,
	): Promise<string | null> {
		try {
			await hooks.toolBefore(
				{ tool: 'bash', sessionID: sessionId, callID: callId },
				{ args: { command: 'git push --force origin main' } },
			);
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	describe('force push stays blocked for native agents (GREEN at base and head)', () => {
		it("blocks 'git push --force origin main' for a build session", async () => {
			const hooks = makeHooks();
			swarmState.activeAgent.set('sess-build-fp', 'build');
			ensureAgentSession('sess-build-fp', 'build');
			const thrown = await attemptForcePush(
				hooks,
				'sess-build-fp',
				'fp-build-1',
			);
			expect(thrown).not.toBeNull();
			expect(thrown as string).toContain('Force push detected');
		});

		it("blocks 'git push --force origin main' for a plan session", async () => {
			const hooks = makeHooks();
			swarmState.activeAgent.set('sess-plan-fp', 'plan');
			ensureAgentSession('sess-plan-fp', 'plan');
			const thrown = await attemptForcePush(hooks, 'sess-plan-fp', 'fp-plan-1');
			expect(thrown).not.toBeNull();
			expect(thrown as string).toContain('Force push detected');
		});

		it("blocks 'git push --force origin main' for a general session", async () => {
			const hooks = makeHooks();
			swarmState.activeAgent.set('sess-general-fp', 'general');
			ensureAgentSession('sess-general-fp', 'general');
			const thrown = await attemptForcePush(
				hooks,
				'sess-general-fp',
				'fp-general-1',
			);
			expect(thrown).not.toBeNull();
			expect(thrown as string).toContain('Force push detected');
		});
	});
});
