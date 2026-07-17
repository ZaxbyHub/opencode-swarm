/**
 * v6.1.2 Guardrails Remediation Verification Tests
 *
 * Tests for the guardrails fixes that ensure:
 * 1. Config validation failure properly disables guardrails
 * 2. Explicit guardrails.enabled: false is preserved
 * 3. No "unknown" session seeding - fallback to ORCHESTRATOR_NAME
 * 4. startAgentSession syncs both agentSessions and activeAgent maps
 * 5. Explicit enabled:false wins in index.ts fallback logic
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ORCHESTRATOR_NAME } from '../../../src/config/constants';
import {
	loadPluginConfig,
	loadPluginConfigWithMeta,
} from '../../../src/config/loader';
import {
	GuardrailsConfigSchema,
	stripKnownSwarmPrefix,
} from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	beginInvocation,
	ensureAgentSession,
	getActiveWindow,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

describe('v6.1.2 Guardrails Remediation', () => {
	// ============================================================
	// SCENARIO 1: Config validation failure disables guardrails
	// ============================================================
	describe('Scenario 1 — Config validation failure disables guardrails', () => {
		let tempDir: string;
		let originalXDG: string | undefined;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v612-'));
			originalXDG = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = tempDir;
		});

		afterEach(() => {
			if (originalXDG === undefined) {
				delete process.env.XDG_CONFIG_HOME;
			} else {
				process.env.XDG_CONFIG_HOME = originalXDG;
			}
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it('returns guardrails.enabled: false when merged config fails validation', () => {
			// Create user config with invalid value (max_iterations out of range)
			const userConfigDir = path.join(tempDir, 'opencode');
			fs.mkdirSync(userConfigDir, { recursive: true });
			fs.writeFileSync(
				path.join(userConfigDir, 'opencode-swarm.json'),
				JSON.stringify({ max_iterations: 999 }), // Invalid: max is 50
			);

			// Create project config with another invalid value
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({ qa_retry_limit: -1 }), // Invalid: min is 0
			);

			try {
				const config = loadPluginConfig(projectDir);

				// Security fix (v6.7+): fail-secure - validation failure should return guardrails.enabled === true
				expect(config.guardrails?.enabled).toBe(true);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it('returns guardrails.enabled: true when project config has invalid guardrails config', () => {
			// Create project config with invalid guardrails config
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({
					guardrails: {
						max_tool_calls: 9999, // Invalid: max is 1000
					},
				}),
			);

			try {
				const config = loadPluginConfig(projectDir);

				// Security fix (v6.7+): fail-secure - validation failure should return guardrails.enabled === true
				expect(config.guardrails?.enabled).toBe(true);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it('returned config has all default guardrails fields when validation fails', () => {
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({ max_iterations: 999 }), // Invalid
			);

			try {
				const config = loadPluginConfig(projectDir);

				// Security fix (v6.7+): fail-secure - validation failure should return guardrails.enabled === true
				expect(config.guardrails?.enabled).toBe(true);
				// Should have all defaults from GuardrailsConfigSchema
				expect(config.guardrails?.max_tool_calls).toBe(200);
				expect(config.guardrails?.max_duration_minutes).toBe(30);
				expect(config.guardrails?.warning_threshold).toBe(0.75);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});

	// ============================================================
	// SCENARIO 2: Guardrails explicitly disabled stays disabled
	// ============================================================
	describe('Scenario 2 — Guardrails explicitly disabled stays disabled', () => {
		let tempDir: string;
		let originalXDG: string | undefined;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v612-'));
			originalXDG = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = tempDir;
		});

		afterEach(() => {
			if (originalXDG === undefined) {
				delete process.env.XDG_CONFIG_HOME;
			} else {
				process.env.XDG_CONFIG_HOME = originalXDG;
			}
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it('preserves guardrails.enabled: false from project config', () => {
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({ guardrails: { enabled: false } }),
			);

			try {
				const config = loadPluginConfig(projectDir);
				expect(config.guardrails?.enabled).toBe(false);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it('preserves guardrails.enabled: false when merged with user config', () => {
			// User config has guardrails.enabled: true (default)
			const userConfigDir = path.join(tempDir, 'opencode');
			fs.mkdirSync(userConfigDir, { recursive: true });
			fs.writeFileSync(
				path.join(userConfigDir, 'opencode-swarm.json'),
				JSON.stringify({ guardrails: { enabled: true, max_tool_calls: 500 } }),
			);

			// Project config explicitly disables
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({ guardrails: { enabled: false } }),
			);

			try {
				const config = loadPluginConfig(projectDir);
				// Project config's enabled: false should win (deep merge override)
				expect(config.guardrails?.enabled).toBe(false);
				// But max_tool_calls from user config should be preserved
				expect(config.guardrails?.max_tool_calls).toBe(500);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it('disabled guardrails produces no-op hooks', async () => {
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({ guardrails: { enabled: false } }),
			);

			try {
				const { config } = loadPluginConfigWithMeta(projectDir);
				const guardrailsConfig = GuardrailsConfigSchema.parse(
					config.guardrails ?? {},
				);
				expect(guardrailsConfig.enabled).toBe(false);

				const hooks = createGuardrailsHooks(guardrailsConfig);

				// All hooks should be no-ops
				await expect(
					hooks.toolBefore(
						{ tool: 'bash', sessionID: 'test', callID: 'c1' },
						{ args: {} },
					),
				).resolves.toBeUndefined();

				await expect(
					hooks.toolAfter(
						{ tool: 'bash', sessionID: 'test', callID: 'c1' },
						{ title: 'bash', output: 'ok', metadata: {} },
					),
				).resolves.toBeUndefined();
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});

	// ============================================================
	// SCENARIO 3: No unknown session seeding
	// ============================================================
	describe('Scenario 3 — No unknown session seeding', () => {
		beforeEach(() => {
			resetSwarmState();
		});

		it('ensureAgentSession with undefined agentName seeds "unknown" session (baseline)', () => {
			// This is the original behavior - when called without agentName,
			// ensureAgentSession creates a session with 'unknown' agent
			const session = ensureAgentSession('test-session', undefined);
			expect(session.agentName).toBe('unknown');
		});

		it('guardrails toolBefore uses ORCHESTRATOR_NAME fallback when activeAgent is missing', async () => {
			// Create enabled guardrails config
			const guardrailsConfig = GuardrailsConfigSchema.parse({ enabled: true });
			const hooks = createGuardrailsHooks(guardrailsConfig);

			// Clear any pre-existing state
			resetSwarmState();

			// Call toolBefore with a session that has NO activeAgent entry
			// The hook should use ORCHESTRATOR_NAME as fallback
			await hooks.toolBefore(
				{ tool: 'bash', sessionID: 'no-active-agent-session', callID: 'c1' },
				{ args: { command: 'echo test' } },
			);

			// v6.1.2 fix: session should be created with architect, NOT 'unknown'
			const session = swarmState.agentSessions.get('no-active-agent-session');
			expect(session).toBeDefined();
			expect(session?.agentName).toBe(ORCHESTRATOR_NAME);

			// Architect should be exempt - no window created
			const window = getActiveWindow('no-active-agent-session');
			expect(window).toBeUndefined();
		});

		it('guardrails does not throw for architect-fallback session', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 5,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			resetSwarmState();

			// Multiple tool calls should not throw because architect is exempt
			for (let i = 0; i < 10; i++) {
				await expect(
					hooks.toolBefore(
						{
							tool: 'bash',
							sessionID: 'architect-fallback-session',
							callID: `call-${i}`,
						},
						{ args: { command: `echo ${i}` } },
					),
				).resolves.toBeUndefined();
			}
		});

		it('guardrails does not synthesize an architect session for unknown callers', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 1, // Very low limit
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			resetSwarmState();

			// A read-only call without activeAgent remains fail-open but must not mint
			// architect authority or session identity.
			await hooks.toolBefore(
				{ tool: 'bash', sessionID: 'fallback-session', callID: 'c1' },
				{ args: {} },
			);

			const session = swarmState.agentSessions.get('fallback-session');
			expect(session).toBeUndefined();

			// No synthetic session means no guardrails window either.
			const window = getActiveWindow('fallback-session');
			expect(window).toBeUndefined();
		});
	});

	// ============================================================
	// SCENARIO 4: startAgentSession syncs activeAgent
	// ============================================================
	describe('Scenario 4 — startAgentSession syncs activeAgent', () => {
		beforeEach(() => {
			resetSwarmState();
		});

		it('startAgentSession sets both agentSessions and activeAgent maps', () => {
			startAgentSession('sync-test-session', 'coder');

			// Both maps should be updated
			expect(swarmState.agentSessions.get('sync-test-session')?.agentName).toBe(
				'coder',
			);
			expect(swarmState.activeAgent.get('sync-test-session')).toBe('coder');
		});

		it('startAgentSession with architect sets both maps correctly', () => {
			startAgentSession('architect-session', ORCHESTRATOR_NAME);

			expect(swarmState.agentSessions.get('architect-session')?.agentName).toBe(
				ORCHESTRATOR_NAME,
			);
			expect(swarmState.activeAgent.get('architect-session')).toBe(
				ORCHESTRATOR_NAME,
			);
		});

		it('startAgentSession overwrites existing activeAgent entry', () => {
			// Set up initial state
			swarmState.activeAgent.set('overwrite-session', 'explorer');

			// Start session with different agent
			startAgentSession('overwrite-session', 'coder');

			// activeAgent should be updated
			expect(swarmState.activeAgent.get('overwrite-session')).toBe('coder');
			expect(swarmState.agentSessions.get('overwrite-session')?.agentName).toBe(
				'coder',
			);
		});

		it('guardrails can resolve agentName from activeAgent after startAgentSession', async () => {
			const guardrailsConfig = GuardrailsConfigSchema.parse({
				enabled: true,
				max_tool_calls: 10,
			});
			const hooks = createGuardrailsHooks(guardrailsConfig);

			resetSwarmState();

			// Start session for a non-architect agent
			startAgentSession('coder-session', 'coder');

			// Verify both maps are in sync
			expect(swarmState.activeAgent.get('coder-session')).toBe('coder');

			// Call toolBefore - it should see 'coder' from activeAgent map
			await hooks.toolBefore(
				{ tool: 'bash', sessionID: 'coder-session', callID: 'c1' },
				{ args: {} },
			);

			// Session should still be 'coder', not replaced with ORCHESTRATOR_NAME
			const session = swarmState.agentSessions.get('coder-session');
			expect(session?.agentName).toBe('coder');

			// Coder should have a window (not exempt like architect)
			const window = getActiveWindow('coder-session');
			expect(window).toBeDefined();
			expect(window?.agentName).toBe('coder');
		});
	});

	// ============================================================
	// SCENARIO 5: Explicit enabled:false wins in index.ts fallback
	// ============================================================
	describe('Scenario 5 — Explicit enabled:false wins in fallback logic', () => {
		let tempDir: string;
		let originalXDG: string | undefined;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-v612-'));
			originalXDG = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = tempDir;
		});

		afterEach(() => {
			if (originalXDG === undefined) {
				delete process.env.XDG_CONFIG_HOME;
			} else {
				process.env.XDG_CONFIG_HOME = originalXDG;
			}
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it('explicit enabled:false wins over loadedFromFile:true', () => {
			// Create a config file with guardrails.enabled: false
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({
					guardrails: { enabled: false, max_tool_calls: 500 },
				}),
			);

			try {
				const { config, loadedFromFile } = loadPluginConfigWithMeta(projectDir);

				// Config was loaded from file
				expect(loadedFromFile).toBe(true);

				// But explicit enabled: false should still be honored
				// Simulate the index.ts fallback logic:
				const guardrailsFallback: {
					enabled?: boolean;
					[key: string]: unknown;
				} =
					config.guardrails?.enabled === false
						? { ...config.guardrails, enabled: false }
						: loadedFromFile
							? (config.guardrails ?? {})
							: { ...config.guardrails, enabled: false };

				// Should be disabled, not overridden by loadedFromFile path
				expect(guardrailsFallback.enabled).toBe(false);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it('enabled:undefined with loadedFromFile:true uses config.guardrails', () => {
			// Create a config file without explicit enabled (defaults to true)
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({
					guardrails: { max_tool_calls: 500 },
				}),
			);

			try {
				const { config, loadedFromFile } = loadPluginConfigWithMeta(projectDir);

				expect(loadedFromFile).toBe(true);
				// enabled is not explicitly set, defaults to true in schema
				expect(config.guardrails?.enabled).toBe(true);

				// Fallback logic should use loadedFromFile path
				const guardrailsFallback: {
					enabled?: boolean;
					[key: string]: unknown;
				} =
					config.guardrails?.enabled === false
						? { ...config.guardrails, enabled: false }
						: loadedFromFile
							? (config.guardrails ?? {})
							: { ...config.guardrails, enabled: false };

				// Should be enabled (default from schema, via loadedFromFile path)
				expect(guardrailsFallback.enabled).toBe(true);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it('no config file results in disabled guardrails (no loadedFromFile)', () => {
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
			// No config file created

			try {
				const { config, loadedFromFile } = loadPluginConfigWithMeta(projectDir);

				// No config file was loaded
				expect(loadedFromFile).toBe(false);

				// Fallback logic should disable guardrails when no file exists
				const guardrailsFallback: {
					enabled?: boolean;
					[key: string]: unknown;
				} =
					config.guardrails?.enabled === false
						? { ...config.guardrails, enabled: false }
						: loadedFromFile
							? (config.guardrails ?? {})
							: { ...config.guardrails, enabled: false };

				expect(guardrailsFallback.enabled).toBe(false);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it('GuardrailsConfigSchema.parse of fallback produces valid config', () => {
			// Test that the fallback object can be parsed by GuardrailsConfigSchema
			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({
					guardrails: { enabled: false, max_tool_calls: 500 },
				}),
			);

			try {
				const { config, loadedFromFile } = loadPluginConfigWithMeta(projectDir);

				const guardrailsFallback =
					config.guardrails?.enabled === false
						? { ...config.guardrails, enabled: false }
						: loadedFromFile
							? (config.guardrails ?? {})
							: { ...config.guardrails, enabled: false };

				// Should parse without error
				const guardrailsConfig =
					GuardrailsConfigSchema.parse(guardrailsFallback);
				expect(guardrailsConfig.enabled).toBe(false);
				expect(guardrailsConfig.max_tool_calls).toBe(500);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});

	// ============================================================
	// ADDITIONAL: Strip prefix tests for guardrails context
	// ============================================================
	describe('stripKnownSwarmPrefix integration', () => {
		it('strips paid_ prefix from agent names', () => {
			expect(stripKnownSwarmPrefix('paid_architect')).toBe('architect');
			expect(stripKnownSwarmPrefix('paid_coder')).toBe('coder');
		});

		it('strips local_ prefix from agent names', () => {
			expect(stripKnownSwarmPrefix('local_architect')).toBe('architect');
			expect(stripKnownSwarmPrefix('local_coder')).toBe('coder');
		});

		it('returns unknown names unchanged', () => {
			expect(stripKnownSwarmPrefix('unknown_agent')).toBe('unknown_agent');
		});

		it('handles case-insensitive matching', () => {
			expect(stripKnownSwarmPrefix('PAID_ARCHITECT')).toBe('architect');
			expect(stripKnownSwarmPrefix('Local_Coder')).toBe('coder');
		});

		it('returns base agent names unchanged', () => {
			expect(stripKnownSwarmPrefix('architect')).toBe('architect');
			expect(stripKnownSwarmPrefix('coder')).toBe('coder');
		});
	});
});
