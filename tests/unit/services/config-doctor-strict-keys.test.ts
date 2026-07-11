import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginConfig } from '../../../src/config/loader';
import { runConfigDoctor } from '../../../src/services/config-doctor';

/**
 * Issue #1778 H6: config-doctor must surface a nested unrecognized key in any
 * strict section by re-reading the RAW on-disk config. Previously it only saw
 * the already-parsed (post-recovery) config, so a nested typo produced no
 * finding.
 */
describe('config-doctor — nested unknown strict-section keys (#1778 H6)', () => {
	let projectDir: string;
	let originalXDG: string | undefined;

	beforeEach(() => {
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-h6-'));
		fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
		// Isolate user config away from the real home dir.
		originalXDG = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = fs.mkdtempSync(
			path.join(os.tmpdir(), 'doctor-h6-xdg-'),
		);
	});

	afterEach(() => {
		if (originalXDG === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXDG;
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	function writeProjectConfig(cfg: unknown): void {
		fs.writeFileSync(
			path.join(projectDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(cfg),
		);
	}

	it('flags a nested unknown key under council', () => {
		writeProjectConfig({ council: { enabled: true, maxRoundz: 5 } });
		const config = loadPluginConfig(projectDir);
		const result = runConfigDoctor(config, projectDir);

		const finding = result.findings.find(
			(f) => f.id === 'unknown-config-key' && f.path === 'council.maxRoundz',
		);
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe('warn');
	});

	it('flags a nested unknown key under checkpoint', () => {
		writeProjectConfig({ checkpoint: { enabled: true, bogusKey: 1 } });
		const config = loadPluginConfig(projectDir);
		const result = runConfigDoctor(config, projectDir);

		expect(
			result.findings.some(
				(f) =>
					f.id === 'unknown-config-key' && f.path === 'checkpoint.bogusKey',
			),
		).toBe(true);
	});

	it('does not flag a fully valid config', () => {
		writeProjectConfig({
			council: { enabled: true },
			memory: { enabled: true },
		});
		const config = loadPluginConfig(projectDir);
		const result = runConfigDoctor(config, projectDir);

		expect(result.findings.some((f) => f.id === 'unknown-config-key')).toBe(
			false,
		);
	});
});
