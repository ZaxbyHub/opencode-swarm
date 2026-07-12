import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginConfig } from '../../../src/config/loader';

/**
 * Issue #1778 H6: a single unrecognized key in a strict config section
 * (council/checkpoint/pr_monitor/turbo.epic) must NOT wipe the entire user
 * config. The loader performs targeted section recovery — dropping only the
 * offending key(s) and preserving everything else. This is the #1690 acceptance
 * generalized beyond the gates/external_skills sections fixed in #1732.
 */
describe('config/loader — strict-section typo recovery (#1778 H6)', () => {
	let tempDir: string;
	let originalXDG: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h6-recovery-'));
		originalXDG = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = tempDir;
	});

	afterEach(() => {
		if (originalXDG === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXDG;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeProjectConfig(cfg: unknown): string {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h6-project-'));
		fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(cfg),
		);
		return projectDir;
	}

	it('preserves the rest of the config when council has a nested typo', () => {
		const projectDir = writeProjectConfig({
			max_iterations: 9,
			memory: { enabled: true },
			council: { enabled: true, maxRoundz: 5 },
		});
		const result = loadPluginConfig(projectDir);

		// Unrelated user settings survive.
		expect(result.max_iterations).toBe(9);
		expect(result.memory?.enabled).toBe(true);
		// The valid part of council survives; only the typo is dropped.
		expect(result.council?.enabled).toBe(true);
		expect(
			(result.council as Record<string, unknown>).maxRoundz,
		).toBeUndefined();
		// NOT wiped to guardrails-only defaults.
		expect(result.max_iterations).not.toBe(5);

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('preserves the rest of the config when checkpoint has a nested typo', () => {
		const projectDir = writeProjectConfig({
			max_iterations: 8,
			checkpoint: { enabled: true, totallyBogusKey: 1 },
		});
		const result = loadPluginConfig(projectDir);

		expect(result.max_iterations).toBe(8);
		expect(result.checkpoint?.enabled).toBe(true);
		expect(
			(result.checkpoint as Record<string, unknown>).totallyBogusKey,
		).toBeUndefined();

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('preserves the rest of the config when pr_monitor has a nested typo', () => {
		const projectDir = writeProjectConfig({
			max_iterations: 7,
			pr_monitor: { enabled: true, notARealKey: true },
		});
		const result = loadPluginConfig(projectDir);

		expect(result.max_iterations).toBe(7);
		expect(result.pr_monitor?.enabled).toBe(true);
		expect(
			(result.pr_monitor as Record<string, unknown>).notARealKey,
		).toBeUndefined();

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('does not delete valid z.record (open-ended) keys during recovery', () => {
		// `agents` is a z.record — arbitrary user keys are legal and must survive
		// even when another section carries a typo that triggers recovery.
		const projectDir = writeProjectConfig({
			agents: { my_custom_agent: { model: 'anthropic/claude' } },
			council: { enabled: true, bogusTypoKey: 1 },
		});
		const result = loadPluginConfig(projectDir);

		expect(result.agents?.my_custom_agent).toBeDefined();
		expect(result.council?.enabled).toBe(true);
		expect(
			(result.council as Record<string, unknown>).bogusTypoKey,
		).toBeUndefined();

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('recovers a typo in the user config (no project config)', () => {
		// User config lives under XDG_CONFIG_HOME/opencode/opencode-swarm.json.
		const userConfigDir = path.join(tempDir, 'opencode');
		fs.mkdirSync(userConfigDir, { recursive: true });
		fs.writeFileSync(
			path.join(userConfigDir, 'opencode-swarm.json'),
			JSON.stringify({
				max_iterations: 6,
				council: { enabled: true, misspelled: true },
			}),
		);
		// A separate empty project dir (no project config).
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h6-empty-'));
		const result = loadPluginConfig(projectDir);

		expect(result.max_iterations).toBe(6);
		expect(result.council?.enabled).toBe(true);
		expect(
			(result.council as Record<string, unknown>).misspelled,
		).toBeUndefined();

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it('forces guardrails ENABLED during recovery when a config file failed to load (#1778 H6 F2)', () => {
		// Project config is malformed JSON → hadError (fail-secure signal).
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h6-failsecure-'));
		fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, '.opencode', 'opencode-swarm.json'),
			'{ this is not valid json',
		);
		// User config is valid JSON but has a typo AND explicitly disables
		// guardrails. Targeted recovery would strip the typo and otherwise return
		// guardrails:false — but because a file failed to load, guardrails must be
		// forced ENABLED (never a fail-secure downgrade).
		const userConfigDir = path.join(tempDir, 'opencode');
		fs.mkdirSync(userConfigDir, { recursive: true });
		fs.writeFileSync(
			path.join(userConfigDir, 'opencode-swarm.json'),
			JSON.stringify({
				guardrails: { enabled: false },
				council: { enabled: true, typoKey: 1 },
			}),
		);

		const result = loadPluginConfig(projectDir);

		// Fail-secure: guardrails forced enabled despite the user's `false`.
		expect(result.guardrails?.enabled).toBe(true);

		fs.rmSync(projectDir, { recursive: true, force: true });
	});
});
