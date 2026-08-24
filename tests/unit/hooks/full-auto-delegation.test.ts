/**
 * Unit tests for src/hooks/full-auto-delegation.ts.
 *
 * Outbound checks: unknown subagent denied, coder w/o declared scope denied.
 * Return checks: skipped tests / external instructions warned & severe pauses run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import {
	loadFullAutoRunState,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import { createFullAutoDelegationHook } from '../../../src/hooks/full-auto-delegation';
import { swarmState } from '../../../src/state';

let tmpDir: string;

function config(): PluginConfig {
	return {
		full_auto: {
			enabled: true,
			mode: 'supervised',
			permission_policy: { enabled: true, allow_defaults: true },
		},
	} as unknown as PluginConfig;
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-deleg-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	swarmState.agentSessions.delete('sess-1');
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('outbound delegation check', () => {
	test('denies unknown subagent_type', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
				{ args: { subagent_type: 'evil_agent' } },
			),
		).rejects.toThrow(/unknown subagent/);
	});

	test('defers coder scope enforcement to the shared identity-aware gate', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
				{ args: { subagent_type: 'coder' } },
			),
		).resolves.toBeUndefined();
	});

	test('allows coder delegation when scope declared via session', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		// Seed a session with declared scope.
		swarmState.agentSessions.set('sess-1', {
			declaredCoderScope: ['src/feature'],
		} as unknown as ReturnType<typeof swarmState.agentSessions.get>);
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
				{ args: { subagent_type: 'coder' } },
			),
		).resolves.toBeUndefined();
	});

	test('no-op when no Full-Auto run is active', async () => {
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
				{ args: { subagent_type: 'evil_agent' } },
			),
		).resolves.toBeUndefined();
	});
});

describe('outbound delegation — arbitrary user-defined swarm IDs', () => {
	const arbitraryAccepted: Array<[string, string]> = [
		['banana_coder', 'declared scope present'],
		['acme-prod_reviewer', 'reviewer accepted'],
		['customer123_critic_oversight', 'critic_oversight accepted'],
		['my swarm_test_engineer', 'space-separator works'],
		['payments-team_critic_drift_verifier', 'compound role accepted'],
		['!!!_coder', 'punctuation-only swarm ID accepted'],
		['-_coder', 'separator-character swarm ID accepted'],
	];

	for (const [name, label] of arbitraryAccepted) {
		test(`accepts arbitrary swarm name '${name}' (${label})`, async () => {
			startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
			// Coder canonical roles need declared scope; seed it.
			swarmState.agentSessions.set('sess-1', {
				declaredCoderScope: ['src/feature'],
			} as unknown as ReturnType<typeof swarmState.agentSessions.get>);
			const hook = createFullAutoDelegationHook({
				config: config(),
				directory: tmpDir,
			});
			await expect(
				hook.toolBefore(
					{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
					{ args: { subagent_type: name } },
				),
			).resolves.toBeUndefined();
		});
	}

	test('prefixed coder scope enforcement also defers to the shared gate', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
				{ args: { subagent_type: 'banana_coder' } },
			),
		).resolves.toBeUndefined();
	});

	test('arbitrary swarm coder with declared scope passes', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		swarmState.agentSessions.set('sess-1', {
			declaredCoderScope: ['src/feature'],
		} as unknown as ReturnType<typeof swarmState.agentSessions.get>);
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
				{ args: { subagent_type: 'banana_coder' } },
			),
		).resolves.toBeUndefined();
	});

	test('arbitrary swarm name with no canonical role suffix is rejected', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
				{ args: { subagent_type: 'banana_robot' } },
			),
		).rejects.toThrow(/unknown subagent/);
	});
});

describe('return check', () => {
	test('writes warning event when subagent skipped tests', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
			{ output: 'Done; tests were skipped due to time pressure.' },
		);
		const events = fs
			.readFileSync(path.join(tmpDir, '.swarm', 'events.jsonl'), 'utf-8')
			.trim()
			.split('\n');
		const warning = events.find((l) =>
			l.includes('full_auto_subagent_warning'),
		);
		expect(warning).toBeTruthy();
	});

	test('prose-only out-of-scope claim is advisory and does NOT pause (#2103 H)', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
			{
				output:
					'I generated files outside the declared scope including src/index.ts.',
			},
		);
		// Issue #2103 workstream H: free-form prose can never durably pause.
		const state = loadFullAutoRunState(tmpDir, 'sess-1');
		expect(state?.status).toBe('running');
	});

	test('negated compliant prose does not pause or warn severely (#2103 H)', async () => {
		startFullAutoRun(tmpDir, 'sess-neg', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-neg', callID: 'c1' },
			{ output: 'No files were modified outside the declared scope.' },
		);
		const state = loadFullAutoRunState(tmpDir, 'sess-neg');
		expect(state?.status).toBe('running');
	});

	test('structured + corroborated out-of-scope claim pauses (#2103 H)', async () => {
		startFullAutoRun(tmpDir, 'sess-struct', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		// Seed a deterministic scope event naming the claimed path so the
		// structured claim is corroborated by guardrail state.
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.appendFileSync(
			path.join(tmpDir, '.swarm', 'events.jsonl'),
			JSON.stringify({
				type: 'scope_denial',
				path: 'src/outside.ts',
				reason: 'write outside declared scope',
			}) + '\n',
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-struct', callID: 'c1' },
			{
				output:
					'Done.\nSWARM_RETURN_STATUS: {"out_of_scope_files":["src/outside.ts"]}',
			},
		);
		const state = loadFullAutoRunState(tmpDir, 'sess-struct');
		expect(state?.status).toBe('paused');
		expect(state?.pauseReason).toContain('structured + corroborated');
	});

	test('structured but UNcorroborated claim stays advisory (#2103 H)', async () => {
		startFullAutoRun(tmpDir, 'sess-uncorr', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-uncorr', callID: 'c1' },
			{
				output:
					'Done.\nSWARM_RETURN_STATUS: {"out_of_scope_files":["src/ghost.ts"]}',
			},
		);
		const state = loadFullAutoRunState(tmpDir, 'sess-uncorr');
		expect(state?.status).toBe('running');
	});

	test('malformed envelope never fabricates a violation (#2103 H)', async () => {
		startFullAutoRun(tmpDir, 'sess-mal', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-mal', callID: 'c1' },
			{ output: 'Done.\nSWARM_RETURN_STATUS: {not json' },
		);
		const state = loadFullAutoRunState(tmpDir, 'sess-mal');
		expect(state?.status).toBe('running');
	});

	test('throws when warning event write fails', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		fs.mkdirSync(path.join(tmpDir, '.swarm', 'events.jsonl'), {
			recursive: true,
		});
		await expect(
			hook.toolAfter(
				{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
				{ output: 'Done; tests were skipped due to time pressure.' },
			),
		).rejects.toThrow();
	});

	test('does not warn on benign return text', async () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const hook = createFullAutoDelegationHook({
			config: config(),
			directory: tmpDir,
		});
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'sess-1', callID: 'c1' },
			{ output: 'Implemented the feature, all tests pass.' },
		);
		const eventsPath = path.join(tmpDir, '.swarm', 'events.jsonl');
		expect(fs.existsSync(eventsPath)).toBe(false);
	});
});
