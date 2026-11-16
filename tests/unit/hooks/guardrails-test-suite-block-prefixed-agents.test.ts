/**
 * Issue #3320 companion coverage (unfrozen, additive): the full test-suite
 * block's swarm-ownership gate must keep blocking PREFIXED swarm agents.
 *
 * Frozen C7 (tests/unit/hooks/guardrails-test-suite-block-native-agents.test.ts)
 * pins the unprefixed controls (architect + coder still blocked; build/plan/
 * general allowed) but carries no prefixed-name row, so a prefixed-subagent
 * false negative in `isSwarmOwnedSession` — e.g. `mega_coder` or
 * `mega_architect` mistakenly allowed — would be unpinned without this file.
 * GREEN at the fixed tree only; authored with the fix (not part of the frozen
 * checkpoint manifest).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const TEST_SUITE_BLOCK_MESSAGE =
	'BLOCKED: Full test suite execution is not allowed in-session. Run a specific test file instead: bun test path/to/file.test.ts';

describe('full test-suite block stays for prefixed swarm agents (#3320)', () => {
	const config: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
	};

	let testDir: string;
	let toolBefore: (
		input: { tool: string; sessionID: string; callID: string },
		output: { args: unknown },
	) => Promise<void>;

	beforeEach(() => {
		resetSwarmState();
		testDir = canonicalMkdtemp('swarm-3320-prefixed-suite-');
		const hooks = createGuardrailsHooks(testDir, undefined, config);
		toolBefore = hooks.toolBefore as typeof toolBefore;
	});

	afterEach(() => {
		resetSwarmState();
		removeTreeWithRetry(testDir);
	});

	for (const agentName of ['mega_architect', 'mega_coder', 'local_coder']) {
		it(`blocks 'bun test' for the prefixed swarm agent ${agentName}`, async () => {
			const sessionId = `prefixed-suite-${agentName}`;
			swarmState.activeAgent.set(sessionId, agentName);
			ensureAgentSession(sessionId, agentName, testDir);

			let thrown: unknown;
			try {
				await toolBefore(
					{ tool: 'bash', sessionID: sessionId, callID: 'c-prefixed-1' },
					{ args: { command: 'bun test' } },
				);
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as Error).message).toBe(TEST_SUITE_BLOCK_MESSAGE);
		});
	}
});
