import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginConfigWithMeta } from '../../../src/config/loader';
import { GuardrailsConfigSchema } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';

describe('guardrails disabled — end-to-end', () => {
	it('config file with guardrails.enabled:false → createGuardrailsHooks → policy denials skipped, handlers still resolve (issue #2664)', async () => {
		// Write a temp config file with guardrails: { enabled: false }
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'));
		const originalXDG = process.env.XDG_CONFIG_HOME;

		try {
			// Set up isolated config environment
			process.env.XDG_CONFIG_HOME = tempDir;

			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({ guardrails: { enabled: false } }),
			);

			try {
				// Load config via the new loadPluginConfigWithMeta function
				const { config } = loadPluginConfigWithMeta(projectDir);

				// Config should have guardrails.enabled === false
				expect(config.guardrails?.enabled).toBe(false);

				// Parse through GuardrailsConfigSchema to get GuardrailsConfig
				const guardrailsConfig = GuardrailsConfigSchema.parse(
					config.guardrails ?? {},
				);
				expect(guardrailsConfig.enabled).toBe(false);

				// Create guardrails hooks — issue #2664: handlers are REAL, not
				// no-ops; only the optional policy denials are inert. A shell
				// command that would be policy-blocked with guardrails on
				// (destruction-pattern prefix, no registered agent) must pass
				// through without throwing, and both hook halves must resolve.
				const hooks = createGuardrailsHooks(projectDir, guardrailsConfig);

				const result = await hooks.toolBefore(
					{ tool: 'bash', sessionID: 'test-session', callID: 'call-1' },
					{ args: { command: 'echo hello' } },
				);
				expect(result).toBeUndefined();

				const afterResult = await hooks.toolAfter(
					{ tool: 'bash', sessionID: 'test-session', callID: 'call-1' },
					{ title: 'bash', output: 'hello', metadata: {} },
				);
				expect(afterResult).toBeUndefined();

				// Optional enforcement is inert: a destructive-pattern shell
				// command (no file argument — also the test-suite-block shape)
				// must NOT throw with guardrails disabled.
				await hooks.toolBefore(
					{ tool: 'bash', sessionID: 'test-session', callID: 'call-2' },
					{ args: { command: 'rm -rf /tmp/does-not-matter' } },
				);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		} finally {
			if (originalXDG === undefined) {
				delete process.env.XDG_CONFIG_HOME;
			} else {
				process.env.XDG_CONFIG_HOME = originalXDG;
			}
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('config file with _loadedFromFile:true in JSON → guardrails NOT bypassed', async () => {
		// This verifies the security fix: _loadedFromFile in the JSON file has no effect
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'));
		const originalXDG = process.env.XDG_CONFIG_HOME;

		try {
			process.env.XDG_CONFIG_HOME = tempDir;

			const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-proj-'));
			const configDir = path.join(projectDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });
			// Attempt to set _loadedFromFile: true via config file (the attack vector)
			fs.writeFileSync(
				path.join(configDir, 'opencode-swarm.json'),
				JSON.stringify({ _loadedFromFile: true }),
			);

			try {
				const { config } = loadPluginConfigWithMeta(projectDir);

				// _loadedFromFile should NOT be present in the config object
				// (Zod strips unknown fields)
				expect(Object.hasOwn(config, '_loadedFromFile')).toBe(false);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		} finally {
			if (originalXDG === undefined) {
				delete process.env.XDG_CONFIG_HOME;
			} else {
				process.env.XDG_CONFIG_HOME = originalXDG;
			}
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
