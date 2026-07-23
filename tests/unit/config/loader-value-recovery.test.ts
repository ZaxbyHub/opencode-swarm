import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginConfigWithMeta } from '../../../src/config/loader';

/**
 * Issue #1690 integration tests: verify that malformed config VALUES trigger
 * the recursive sanitizeMalformedValues recovery path.
 *
 * These tests MUST isolate from the real user config (~/.config/opencode/)
 * so the user-config-alone fallback (step 7) doesn't short-circuit step 7b.
 */
describe('config/loader value recovery (issue #1690)', () => {
	let origXdg: string | undefined;
	let tempXdgHome: string;

	beforeEach(() => {
		origXdg = process.env.XDG_CONFIG_HOME;
		tempXdgHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'xdg-test-')),
		);
		process.env.XDG_CONFIG_HOME = tempXdgHome;
	});

	afterEach(() => {
		if (origXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = origXdg;
		}
		fs.rmSync(tempXdgHome, { recursive: true, force: true });
	});

	it('recovers config with malformed value via sanitized_values path', () => {
		const projectDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'vr-test-')),
		);
		const configDir = path.join(projectDir, '.opencode');
		const configFile = path.join(configDir, 'opencode-swarm.json');
		fs.mkdirSync(configDir, { recursive: true });

		// max_iterations: 888 is above schema max — a malformed VALUE (not unrecognized key)
		fs.writeFileSync(configFile, JSON.stringify({ max_iterations: 888 }));

		const result = loadPluginConfigWithMeta(projectDir);

		// Recovery should be 'sanitized_values' — the bad field was dropped
		expect(result.recovery).toBe('sanitized_values');
		// max_iterations should be the Zod default (not 888, not undefined)
		expect(result.config.max_iterations).toBe(5);
		// removedKeys should contain 'max_iterations'
		expect(result.removedKeys).toContain('max_iterations');
		// guardrails should be enabled (fail-secure on recovery)
		expect(result.config.guardrails?.enabled).toBe(true);

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('preserves valid sections when one has a malformed value', () => {
		const projectDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'vr-test-')),
		);
		const configDir = path.join(projectDir, '.opencode');
		const configFile = path.join(configDir, 'opencode-swarm.json');
		fs.mkdirSync(configDir, { recursive: true });

		// council.enabled is boolean — "yes" is a malformed value
		// guardrails.enabled is valid
		fs.writeFileSync(
			configFile,
			JSON.stringify({
				council: { enabled: 'yes' },
				guardrails: { enabled: true },
			}),
		);

		const result = loadPluginConfigWithMeta(projectDir);

		expect(result.recovery).toBe('sanitized_values');
		// council section should have been recovered (enabled defaulted)
		expect(result.config.council?.enabled).toBeDefined();
		// guardrails should still be enabled (preserved from valid config)
		expect(result.config.guardrails?.enabled).toBe(true);

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('falls to guardrails_defaults when sanitizeMalformedValues cannot recover', () => {
		const projectDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'vr-test-')),
		);
		const configDir = path.join(projectDir, '.opencode');
		const configFile = path.join(configDir, 'opencode-swarm.json');
		fs.mkdirSync(configDir, { recursive: true });

		// Multiple sections malformed in ways that can't be recovered
		fs.writeFileSync(
			configFile,
			JSON.stringify({
				council: 'not-an-object',
				guardrails: 'also-not-an-object',
				max_iterations: 'string-not-number',
			}),
		);

		const result = loadPluginConfigWithMeta(projectDir);

		// If sanitizeMalformedValues can't recover everything, falls to guardrails_defaults
		expect(['sanitized_values', 'guardrails_defaults']).toContain(
			result.recovery,
		);
		expect(result.config.guardrails?.enabled).toBe(true);

		fs.rmSync(projectDir, { recursive: true, force: true });
	});
});
