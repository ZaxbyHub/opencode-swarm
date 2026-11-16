/**
 * Issue #3320 AC2 — the stale-delegation revert must not rewrite a
 * native-agent (v2-seeded) session's identity to the swarm orchestrator.
 *
 * The v2 host adapters re-seed v1 session state on EVERY tool event via
 * `seedV1SessionState` (src/host/v2/hooks.ts). Because a re-seed with an
 * unchanged agent name never refreshes `lastAgentEventTime`, a native
 * OpenCode agent (e.g. the built-in `plan` agent) whose last agent event is
 * more than 10 s old trips the stale-delegation revert inside the registered
 * `tool.execute.before` (src/index.ts): for ANY non-architect identity with
 * `!session.delegationActive && Date.now() - session.lastAgentEventTime >
 * 10000`, it flips `activeAgent` to 'architect' — which then blocks writes
 * to ordinary config files (app.config.toml lives in the architect-blocked config
 * zone, while native agents carry no swarm write restrictions).
 *
 * This test simulates the v2 event order WITHOUT sleeping: the timer is aged
 * by direct mutation of the in-memory session state.
 *
 * RED at base, GREEN after the fix: with lastAgentEventTime aged 20 s, the
 * app.config.toml write rejects as `WRITE BLOCKED: Agent "architect"` and
 * activeAgent flips to 'architect'. The fresh-timer control (<10 s) passes
 * at base and proves the harness itself works.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { rmSync } from 'node:fs';
import { ORCHESTRATOR_NAME } from '../../src/config/constants';
import { seedV1SessionState } from '../../src/host/v2/setup';
import { resetSwarmState, swarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	type BootedPluginHost,
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';
import { freezeClock } from '../helpers/test-clock.js';

let directory: string;
let booted: BootedPluginHost;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

beforeAll(async () => {
	isolatedEnv = createIsolatedTestEnv();
	directory = createPluginHostProject('native-agent-v2-stale-3320');
	booted = await bootSwarmPluginHost(directory, {
		version_check: false,
		knowledge: { enabled: false, hive_enabled: false },
		memory: { enabled: false },
		hooks: { delegation_gate: false },
	});
});

afterAll(() => {
	try {
		resetSwarmState();
		rmSync(directory, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	} catch {
		// Windows EBUSY from lingering handles — best effort only.
	} finally {
		isolatedEnv.cleanup();
	}
});

/**
 * Mirror the v2 host event order for a native agent session: an agent-less
 * chat boundary, then the v2 adapter's re-seed on every tool event (seeded
 * TWICE to prove re-seeding does not refresh the 10 s timer).
 */
async function seedNativePlanSession(sessionID: string): Promise<void> {
	await booted.hooks['chat.message'](
		{ sessionID, message: { id: `m-${sessionID}`, role: 'user' } },
		{},
	);
	seedV1SessionState(sessionID, { id: 'plan' } as never, directory);
	seedV1SessionState(sessionID, { id: 'plan' } as never, directory);
	expect(swarmState.activeAgent.get(sessionID)).toBe('plan');
}

describe('v2-seeded native agent identity survives the stale-delegation revert (#3320 AC2)', () => {
	// Frozen clock (check:test-clock): the stale/fresh semantics below are
	// relative to one fixed instant, so the 20 s aging and the <10 s freshness
	// bound stay deterministic. fixedNow captures a real instant before the
	// freeze so every Date.now() read (fixture and production) agrees.
	let restoreClock: ReturnType<typeof freezeClock> | undefined;
	beforeEach(() => {
		restoreClock = freezeClock({ fixedNow: Date.now() });
	});
	afterEach(() => {
		restoreClock?.();
		restoreClock = undefined;
	});

	test('plan identity is preserved when the delegation timer is stale', async () => {
		const sessionID = 'native-v2-stale-plan-3320';
		await seedNativePlanSession(sessionID);

		// Age the timer directly — no real sleep. The v2 adapters' re-seed on
		// every tool event never refreshes this timestamp (proved by the
		// double seed above), so a >10 s gap is the steady state for a native
		// agent between turns.
		const session = swarmState.agentSessions.get(sessionID);
		expect(session).toBeDefined();
		if (session) {
			session.lastAgentEventTime = Date.now() - 20000;
			session.delegationActive = false;
		}

		// RED at base: the stale-delegation revert inside the registered
		// tool.execute.before flips identity to ORCHESTRATOR_NAME and the
		// guardrails write check then rejects app.config.toml as architect.
		let writeError: unknown;
		try {
			await booted.hooks['tool.execute.before'](
				{ tool: 'write', sessionID, callID: 'write-biome-stale-3320' },
				{ args: { filePath: 'app.config.toml', content: '{}' } },
			);
		} catch (err) {
			writeError = err;
		}
		expect(writeError).toBeUndefined();
		expect(swarmState.activeAgent.get(sessionID)).toBe('plan');
		expect(swarmState.activeAgent.get(sessionID)).not.toBe(ORCHESTRATOR_NAME);
	});

	test('fresh-timer control: a fresh native identity writes fine (harness check)', async () => {
		const sessionID = 'native-v2-fresh-plan-3320';
		await seedNativePlanSession(sessionID);

		// lastAgentEventTime is fresh (<10 s): the stale revert must NOT fire
		// even at base — this control passes at base and proves the harness
		// drives the registered write path correctly.
		const session = swarmState.agentSessions.get(sessionID);
		expect(session).toBeDefined();
		if (session) {
			expect(session.lastAgentEventTime).toBeGreaterThan(Date.now() - 10_000);
			session.delegationActive = false;
		}

		await booted.hooks['tool.execute.before'](
			{ tool: 'write', sessionID, callID: 'write-biome-fresh-3320' },
			{ args: { filePath: 'app.config.toml', content: '{}' } },
		);
		expect(swarmState.activeAgent.get(sessionID)).toBe('plan');
	});
});
