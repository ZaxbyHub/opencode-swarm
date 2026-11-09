/**
 * Issue #3320 AC8 — a sessionless `experimental.chat.system.transform` call
 * must NOT emit swarm-specific system text. RED at base, GREEN after the fix.
 *
 * Base defect (src/hooks/system-enhancer.ts): the native-agent skip AND the
 * cold-identity early return both sit INSIDE `if (_input.sessionID)`, so a
 * call with NO sessionID falls through the guard entirely and emits
 * swarm-specific text — the TURBO banner (`## 🚀 TURBO MODE ACTIVE`) /
 * FULL-AUTO banner (`## ⚡ FULL-AUTO MODE ACTIVE`) sourced from ANOTHER
 * session's mode flags (the global mode fallback), and the Path-A
 * `[PLANNING PROFILE — CURRENT RUNTIME AUTHORITY]` producer output.
 *
 * The inverted (defect-pinning) behavior is green at base in
 * tests/integration/system-transform-global-mode-fallback.test.ts:51-85 and
 * MUST NOT be edited. This file pins the FIXED behavior: the same registered
 * host boot, the same other-session turbo/full-auto flag mechanism, and the
 * same sessionless input shapes — with the assertions inverted. Each test
 * fails at base precisely because the swarm text still appears (verified
 * against the base commit) and passes once the sessionless call is skipped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import { cancelDeferredMaintenanceScans } from '../../src/hooks/system-enhancer';
import type { AgentSessionState } from '../../src/state';
import { resetSwarmState, swarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';

describe('registered system.transform without sessionID emits no swarm text (#3320 AC8)', () => {
	let directory: string;
	let host: Awaited<ReturnType<typeof bootSwarmPluginHost>>;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

	beforeAll(async () => {
		isolatedEnv = createIsolatedTestEnv();
		directory = createPluginHostProject('sessionless-no-swarm-text-3320');
		host = await bootSwarmPluginHost(directory, {
			knowledge: { enabled: false, hive_enabled: false },
			memory: { enabled: false },
			hooks: { delegation_gate: false, system_enhancer: true },
			context_budget: { scoring: { enabled: false } },
		});
	});

	afterAll(() => {
		try {
			cancelDeferredMaintenanceScans(directory);
			resetSwarmState();
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			// SQLite handles may remain open briefly on Windows; best effort only.
		} finally {
			isolatedEnv.cleanup();
		}
	});

	it('does not surface another session’s Turbo banner when the call has no sessionID', async () => {
		// Mirror of the pinned defect test: seed ANOTHER session's turboMode
		// the same way system-transform-global-mode-fallback.test.ts:52-56 does.
		const otherSessionId = 'sessionless-no-swarm-turbo-3320';
		swarmState.agentSessions.set(otherSessionId, {
			turboMode: true,
			fullAutoMode: false,
		} as AgentSessionState);
		const output = { system: ['base system seed'] };
		try {
			// Sessionless input shape mirrors the pinned test (no sessionID key).
			await host.hooks['experimental.chat.system.transform'](
				{ model: { providerID: 'x', modelID: 'y' } },
				output,
			);
			expect(output.system.join('\n')).toContain('base system seed');
			// RED at base: '## 🚀 TURBO MODE ACTIVE' appears (pinned at
			// system-transform-global-mode-fallback.test.ts:51-68).
			expect(output.system.join('\n')).not.toContain('## 🚀 TURBO MODE ACTIVE');
		} finally {
			swarmState.agentSessions.delete(otherSessionId);
		}
	});

	it('does not surface another session’s Full-Auto banner when the call has no sessionID', async () => {
		// Mirror of the pinned defect test: seed ANOTHER session's fullAutoMode
		// the same way system-transform-global-mode-fallback.test.ts:71-75 does.
		const otherSessionId = 'sessionless-no-swarm-full-auto-3320';
		swarmState.agentSessions.set(otherSessionId, {
			turboMode: false,
			fullAutoMode: true,
		} as AgentSessionState);
		const output = { system: ['base system seed'] };
		try {
			await host.hooks['experimental.chat.system.transform'](
				{ model: { providerID: 'x', modelID: 'y' } },
				output,
			);
			expect(output.system.join('\n')).toContain('base system seed');
			// RED at base: '## ⚡ FULL-AUTO MODE ACTIVE' appears (pinned at
			// system-transform-global-mode-fallback.test.ts:70-85).
			expect(output.system.join('\n')).not.toContain(
				'## ⚡ FULL-AUTO MODE ACTIVE',
			);
		} finally {
			swarmState.agentSessions.delete(otherSessionId);
		}
	});

	it('does not run the PLANNING PROFILE producer when the call has no sessionID', async () => {
		// Mirror of the pinned producer test's sessionless input: a full model
		// object with NO sessionID (system-transform-global-mode-fallback.test.ts:87-148).
		const producerMarker = '[PLANNING PROFILE — CURRENT RUNTIME AUTHORITY]';
		const output = { system: ['base system seed'] };
		await host.hooks['experimental.chat.system.transform'](
			{
				model: {
					id: 'qwen3.6-32b',
					providerID: 'vllm-local',
					api: {
						id: 'openai-compatible',
						url: 'http://127.0.0.1:8000/v1',
						npm: '@ai-sdk/openai-compatible',
					},
				},
			},
			output,
		);
		// Join-based containment: with the strict-local model the base render
		// boundary collapses the producer output into system[0], so the seed
		// check must use substring semantics on the joined surface.
		expect(output.system.join('\n')).toContain('base system seed');
		// RED at base: the Path-A producer output is appended to the
		// sessionless call's system surface (pinned at
		// system-transform-global-mode-fallback.test.ts:87-148).
		expect(output.system.join('\n')).not.toContain(producerMarker);
	});
});

/**
 * #3383 AC2 — the zero-swarm-text / zero-.swarm-writes sessionless contract
 * must also hold when the composed chain INCLUDES the phase monitor.
 *
 * The cases above boot with knowledge disabled, so createPhaseMonitorHook was
 * never part of the sessionless journey. Here the same registered-host boot
 * runs with knowledge ENABLED, which composes createPhaseMonitorHook into
 * `experimental.chat.system.transform` (src/index.ts composition:
 * `knowledgeConfig.enabled ? createPhaseMonitorHook(...) : undefined`); the
 * `automation.capabilities.phase_preflight` branch composes the identical
 * hook but requires background automation managers (mode !== 'manual'), which
 * is deliberately NOT booted here to keep the sessionless journey
 * deterministic and offline.
 *
 * A minimal valid plan sits on disk so the sessionless phase-monitor call has
 * everything it needs to misbehave: at base (defect 2) it runs loadPlan
 * (materializing .swarm/plan.md + review receipts), invokes the real curator
 * delegate factory with an undefined session, and writes
 * .swarm/curator-briefing.md through the REAL offline curator runner. Those
 * writes make this case RED at base — the composed-surface leak of defect 2 —
 * and it must go GREEN once the sessionless invocation is guarded.
 */
describe('registered system.transform without sessionID writes nothing when knowledge composes the phase monitor (#3383 AC2)', () => {
	let directory: string;
	let host: Awaited<ReturnType<typeof bootSwarmPluginHost>>;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv>;

	beforeAll(async () => {
		isolatedEnv = createIsolatedTestEnv();
		directory = createPluginHostProject('sessionless-knowledge-no-writes-3383');
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Sessionless composed-chain probe plan',
				swarm: 'local',
				phases: [{ id: 1, name: 'Phase 1', status: 'pending', tasks: [] }],
			}),
			'utf-8',
		);
		host = await bootSwarmPluginHost(directory, {
			knowledge: { enabled: true, hive_enabled: false },
			memory: { enabled: false },
			hooks: { delegation_gate: false, system_enhancer: true },
			context_budget: { scoring: { enabled: false } },
		});
	});

	afterAll(() => {
		try {
			cancelDeferredMaintenanceScans(directory);
			resetSwarmState();
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			// SQLite handles may remain open briefly on Windows; best effort only.
		} finally {
			isolatedEnv.cleanup();
		}
	});

	it('does not run the composed phase monitor when the call has no sessionID', async () => {
		const output = { system: ['base system seed'] };
		await host.hooks['experimental.chat.system.transform'](
			{ model: { providerID: 'x', modelID: 'y' } },
			output,
		);
		// Same zero-swarm-text contract as the knowledge-disabled cases above.
		expect(output.system.join('\n')).toContain('base system seed');
		expect(output.system.join('\n')).not.toContain('## 🚀 TURBO MODE ACTIVE');
		expect(output.system.join('\n')).not.toContain(
			'## ⚡ FULL-AUTO MODE ACTIVE',
		);
		expect(output.system.join('\n')).not.toContain(
			'[PLANNING PROFILE — CURRENT RUNTIME AUTHORITY]',
		);
		// Zero .swarm writes for the artifacts the AC names — loadPlan's
		// plan.md materialization, its review-receipts side effect, and the
		// curator-init briefing write. (A whole-tree diff is NOT sound here:
		// the plugin's deferred post-boot work (bundled-skills sync,
		// config-doctor, repo-graph, telemetry) lands during the first await
		// window after server() resolves, which is unrelated to the
		// sessionless call.)
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'curator-briefing.md')),
		).toBe(false);
		expect(fs.existsSync(path.join(directory, '.swarm', 'plan.md'))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'review-receipts')),
		).toBe(false);
	}, 30_000);
});
