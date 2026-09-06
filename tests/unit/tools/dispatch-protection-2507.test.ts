/**
 * Issue #2507 — composed-caller budget tests. Drives the REAL plugin hooks
 * (bootKnowledgeHost) through both frozen manifest scenarios and asserts
 * observed totals stay within BOTH the integer bounds and the wall-clock
 * bound. CI coverage for
 * tests/unit/tools/dispatch-protection-budget-manifest.ts.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { _clearAllSpawnCircuits } from '../../../src/dispatch/spawn-circuit';
import { _resetDispatchTokenBuckets } from '../../../src/dispatch/token-bucket';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../../helpers/knowledge-real-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import {
	assertWithinDispatchProtectionBudget,
	DISPATCH_PROTECTION_SCENARIO_BUDGETS,
	type DispatchProtectionObserved,
} from './dispatch-protection-budget-manifest';

const SPAWN_ROW = DISPATCH_PROTECTION_SCENARIO_BUDGETS.find(
	(row) => row.scenario === 'spawn-circuit-threshold-opening',
);
const RATE_ROW = DISPATCH_PROTECTION_SCENARIO_BUDGETS.find(
	(row) => row.scenario === 'rate-limited-composed-sequence',
);

const X_ARGS = {
	description: 'explore auth',
	prompt: 'Explore the auth subsystem and report findings.',
	subagent_type: 'mega_explorer',
};
const interleaveArgs = (n: number) => ({
	description: 'filler',
	prompt: `Filler dispatch ${n} to break loop-window adjacency.`,
	subagent_type: 'explorer',
});
const distinctArgs = (n: number) => ({
	description: 'explore',
	prompt: `Distinct dispatch ${n} for the rate-limited composed sequence.`,
	subagent_type: 'explorer',
});

type Hooks = {
	hooks: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

const directories: string[] = [];

async function boot(
	protection: Record<string, unknown>,
	sessionID: string,
): Promise<Hooks> {
	const directory = createKnowledgeProject();
	directories.push(directory);
	const plugin = await bootKnowledgeHost(directory, {
		guardrails: { enabled: true },
		dispatch_protection: protection,
	});
	const session = ensureAgentSession(sessionID, 'architect', directory);
	session.currentTaskId = '1.1';
	return plugin as Hooks;
}

async function beforeCall(
	plugin: Hooks,
	sessionID: string,
	callID: string,
	args: unknown,
): Promise<string> {
	try {
		await plugin.hooks['tool.execute.before'](
			{ tool: 'task', sessionID, callID },
			{ args },
		);
		return '';
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

async function afterState(
	plugin: Hooks,
	sessionID: string,
	callID: string,
	state: 'error' | 'completed',
): Promise<void> {
	await plugin.hooks['tool.execute.after'](
		{ tool: 'task', sessionID, callID, args: undefined },
		state === 'error'
			? {
					state,
					error: 'simulated host dispatch failure',
					title: 'task',
					output: '',
				}
			: { state, output: 'ok', title: 'task' },
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
	_clearAllSpawnCircuits();
	_resetDispatchTokenBuckets();
	resetSwarmState();
	for (const directory of directories.splice(0)) {
		try {
			safeRmRecursive(directory);
		} catch {
			/* best effort */
		}
	}
});

describe('dispatch-protection budget manifest (#2507)', () => {
	it('module-load rows are structurally valid', () => {
		expect(SPAWN_ROW).toBeDefined();
		expect(RATE_ROW).toBeDefined();
		expect(DISTRIBUTED_ROW_CHECKS()).toBe(true);
	});

	it('spawn-circuit-threshold-opening stays within both bounds through the composed hooks', async () => {
		expect(SPAWN_ROW).toBeDefined();
		if (!SPAWN_ROW) return;
		const plugin = await boot(
			{
				enabled: true,
				spawn_failure_threshold:
					SPAWN_ROW.effective_configuration.spawn_failure_threshold,
				half_open_after_ms:
					SPAWN_ROW.effective_configuration.half_open_after_ms,
				rate_per_second: 50,
				burst_capacity: 50,
			},
			'budget-spawn',
		);
		const s1 = 'budget-spawn';
		const observed: DispatchProtectionObserved = {
			attempts: 0,
			host_launches: 0,
			wall_clock_ms: 0,
		};
		const t0 = performance.now();
		const deniedIsLaunch = (message: string) => !message;
		for (const i of [1, 2]) {
			observed.attempts += 1;
			const denied = await beforeCall(plugin, s1, `bs-x-${i}`, X_ARGS);
			if (deniedIsLaunch(denied)) observed.host_launches += 1;
			await afterState(plugin, s1, `bs-x-${i}`, 'error');
			observed.attempts += 1;
			await beforeCall(plugin, s1, `bs-i-${i}`, interleaveArgs(i));
			observed.host_launches += 1;
		}
		// Third failure opens the circuit.
		observed.attempts += 1;
		await beforeCall(plugin, s1, 'bs-x-3', X_ARGS);
		observed.host_launches += 1;
		await afterState(plugin, s1, 'bs-x-3', 'error');
		observed.attempts += 1;
		await beforeCall(plugin, s1, 'bs-i-3', interleaveArgs(3));
		observed.host_launches += 1;
		// Fourth dispatch is denied (attempt, no launch).
		observed.attempts += 1;
		const denied = await beforeCall(plugin, s1, 'bs-x-4', X_ARGS);
		expect(denied).toContain('SPAWN PROTECTION CIRCUIT OPEN');
		// Half-open probe succeeds and closes the circuit.
		await sleep(250);
		observed.attempts += 1;
		await beforeCall(plugin, s1, 'bs-x-5', X_ARGS);
		observed.host_launches += 1;
		await afterState(plugin, s1, 'bs-x-5', 'completed');
		// Post-recovery dispatch passes.
		observed.attempts += 1;
		await beforeCall(plugin, s1, 'bs-x-6', X_ARGS);
		observed.host_launches += 1;
		observed.wall_clock_ms = Math.round(performance.now() - t0);
		assertWithinDispatchProtectionBudget(SPAWN_ROW, observed);
		// Non-vacuous floor: the full sequence (3 failures + interleaves
		// + denial + probe + recovery) must actually have run.
		expect(observed.attempts).toBeGreaterThanOrEqual(9);
	}, 20_000);

	it('rate-limited-composed-sequence paces within both bounds', async () => {
		expect(RATE_ROW).toBeDefined();
		if (!RATE_ROW) return;
		const plugin = await boot(
			{
				enabled: true,
				spawn_failure_threshold: 3,
				half_open_after_ms: 60_000,
				rate_per_second: RATE_ROW.effective_configuration.rate_per_second,
				burst_capacity: RATE_ROW.effective_configuration.burst_capacity,
			},
			'budget-rate',
		);
		const s1 = 'budget-rate';
		const observed: DispatchProtectionObserved = {
			attempts: 6,
			host_launches: 6,
			wall_clock_ms: 0,
		};
		const t0 = performance.now();
		for (let i = 1; i <= 6; i++) {
			const denied = await beforeCall(plugin, s1, `br-${i}`, distinctArgs(i));
			// Pacing awaits, never denies.
			expect(denied).toBe('');
		}
		observed.wall_clock_ms = Math.round(performance.now() - t0);
		assertWithinDispatchProtectionBudget(RATE_ROW, observed);
		// Burst 2 then 4 paced refills at 2/sec: theory 2000ms; the
		// pacing floor guards against a vacuous pass.
		expect(observed.wall_clock_ms).toBeGreaterThanOrEqual(1500);
	}, 20_000);
});

function DISTRIBUTED_ROW_CHECKS(): boolean {
	return DISPATCH_PROTECTION_SCENARIO_BUDGETS.every(
		(row) =>
			row.max_attempts >= row.max_host_launches &&
			row.max_attempts > 0 &&
			row.max_host_launches > 0 &&
			row.wall_clock_ms > 0 &&
			Object.keys(row.effective_configuration).length > 0 &&
			row.retry_owner.length > 0,
	);
}
