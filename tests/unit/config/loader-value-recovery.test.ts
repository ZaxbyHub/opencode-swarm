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
		// council section should have been recovered (enabled defaulted to false by Zod)
		expect(result.config.council?.enabled).toBe(false);
		// guardrails should still be enabled (preserved from valid config)
		expect(result.config.guardrails?.enabled).toBe(true);

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('skips value recovery when guardrails explicitly disabled (double-disable guard, PRR-002)', () => {
		const projectDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'vr-test-')),
		);
		const configDir = path.join(projectDir, '.opencode');
		const configFile = path.join(configDir, 'opencode-swarm.json');
		fs.mkdirSync(configDir, { recursive: true });

		// guardrails.enabled: false + a malformed decoy field (max_iterations
		// above the schema max). The rawGuardrailsDisabled guard (step 7b)
		// MUST skip recovery so attacker-controlled non-guardrails values are
		// NOT preserved alongside a forced guardrails override, falling through
		// to step 8 (guardrails_defaults) — the pre-#1690 fail-secure posture.
		fs.writeFileSync(
			configFile,
			JSON.stringify({
				guardrails: { enabled: false },
				max_iterations: 999,
			}),
		);

		const result = loadPluginConfigWithMeta(projectDir);

		// Recovery must NOT be sanitized_values — the guard skipped it.
		expect(result.recovery).toBe('guardrails_defaults');
		// Fail-secure: guardrails are force-enabled despite the raw `false`.
		expect(result.config.guardrails?.enabled).toBe(true);
		// The attacker's max_iterations value is discarded (default 5), NOT preserved.
		expect(result.config.max_iterations).toBe(5);

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('preserves schema-valid guardrails sub-fields on recovery (posture pin, PRR-010)', () => {
		const projectDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'vr-test-')),
		);
		const configDir = path.join(projectDir, '.opencode');
		const configFile = path.join(configDir, 'opencode-swarm.json');
		fs.mkdirSync(configDir, { recursive: true });

		// guardrails.enabled is TRUE (so the double-disable guard does NOT fire)
		// and max_tool_calls: 500 is a schema-valid value (0..1000). A malformed
		// decoy field (max_iterations above the schema max) forces step 7b recovery.
		// By design, recovery forces enabled: true and preserves the rest of the
		// schema-valid guardrails object — so max_tool_calls: 500 survives.
		fs.writeFileSync(
			configFile,
			JSON.stringify({
				guardrails: { enabled: true, max_tool_calls: 500 },
				max_iterations: 999,
			}),
		);

		const result = loadPluginConfigWithMeta(projectDir);

		expect(result.recovery).toBe('sanitized_values');
		expect(result.config.guardrails?.enabled).toBe(true);
		// The schema-valid sub-field is preserved through recovery.
		expect(result.config.guardrails?.max_tool_calls).toBe(500);
		// The malformed decoy is dropped and defaulted.
		expect(result.config.max_iterations).toBe(5);

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('all top-level keys malformed still lands in sanitized_values (not guardrails_defaults)', () => {
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

		// Dropping all three malformed leaves leaves {} which parses cleanly,
		// so recovery is sanitized_values (not guardrails_defaults).
		expect(result.recovery).toBe('sanitized_values');
		expect(result.config.guardrails?.enabled).toBe(true);
		// All three malformed keys are reported as removed.
		expect(result.removedKeys).toContain('council');
		expect(result.removedKeys).toContain('guardrails');
		expect(result.removedKeys).toContain('max_iterations');

		fs.rmSync(projectDir, { recursive: true, force: true });
	});
});
