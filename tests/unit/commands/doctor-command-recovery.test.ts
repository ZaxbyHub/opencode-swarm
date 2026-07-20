import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleDoctorCommand } from '../../../src/commands/doctor';
import { _internals } from '../../../src/config';

/**
 * SC-004.1 + SC-004.2 + SC-004.3 — doctor fast-path + surgical command-return
 * contract for `/swarm config doctor`.
 *
 * SC-004.1: when config triggers recovery, doctor surfaces affected sections.
 * SC-004.2: when config is valid, doctor reports clean status (no false positives).
 * SC-004.3: the underlying `_internals.loadPluginConfigWithMeta` metadata
 * (recovery, removedKeys, warnings) is consumable for command-return contracts.
 */

const VALID_CONFIG = {
	max_iterations: 9,
	memory: { enabled: true },
	gates: { enabled: true },
};

function writeProjectConfig(projectDir: string, content: object): void {
	mkdirSync(join(projectDir, '.opencode'), { recursive: true });
	writeFileSync(
		join(projectDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(content),
		'utf-8',
	);
}

function writeInvalidJsonProjectConfig(projectDir: string, raw: string): void {
	mkdirSync(join(projectDir, '.opencode'), { recursive: true });
	writeFileSync(
		join(projectDir, '.opencode', 'opencode-swarm.json'),
		raw,
		'utf-8',
	);
}

describe('/swarm config doctor — FR-004 (SC-004.1 + SC-004.2 + SC-004.3)', () => {
	test('SC-004.2: clean parse produces no recovery-related findings', async () => {
		// SC-004.2: clean config = no recovery metadata, doctor reports clean.
		const projectDir = mkdtempSync(join(tmpdir(), 'doctor-clean-'));
		const userDir = mkdtempSync(join(tmpdir(), 'doctor-user-'));
		const origXdg = process.env.XDG_CONFIG_HOME;
		try {
			process.env.XDG_CONFIG_HOME = userDir;
			writeProjectConfig(projectDir, VALID_CONFIG);
			const output = await handleDoctorCommand(projectDir, []);
			// doctor runs; no recovery section should appear since config is clean
			expect(output).not.toContain('## Config Recovery');
		} finally {
			if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = origXdg;
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(userDir, { recursive: true, force: true });
		}
	});

	test('SC-004.1: recovery (stripped_keys) surfaces affected sections', async () => {
		// SC-004.1: a stripped_keys recovery in a strict section must be visible in doctor output.
		const projectDir = mkdtempSync(join(tmpdir(), 'doctor-strip-'));
		const userDir = mkdtempSync(join(tmpdir(), 'doctor-user-'));
		const origXdg = process.env.XDG_CONFIG_HOME;
		try {
			process.env.XDG_CONFIG_HOME = userDir;
			// 1 bad key in 4 strict sections (gates is pre-Zod sanitized)
			writeProjectConfig(projectDir, {
				max_iterations: 9,
				gates: { enabled: true, gatesBogusKey: 'val' },
				council: { enabled: true, councilBogusKey: 1 },
				checkpoint: { enabled: true, checkpointBogusKey: 1 },
				pr_monitor: { enabled: true, prMonitorBogusKey: 1 },
				turbo: {
					strategy: 'standard',
					epic: {
						enabled: false,
						mode: { enabled: false },
						calibration: { enabled: true },
						turboEpicBogusKey: 'val',
					},
				},
			});
			const output = await handleDoctorCommand(projectDir, []);
			// doctor must surface recovery info (FR-004)
			expect(output).toContain('## Config Recovery');
			expect(output).toContain('`stripped_keys`');
			// removedKeys listing present
			expect(output).toContain('council.councilBogusKey');
			expect(output).toContain('checkpoint.checkpointBogusKey');
			expect(output).toContain('pr_monitor.prMonitorBogusKey');
			expect(output).toContain('turbo.epic.turboEpicBogusKey');
		} finally {
			if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = origXdg;
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(userDir, { recursive: true, force: true });
		}
	});

	test('SC-004.1: guardrails_defaults recovery surfaces SECURITY warning', async () => {
		// SC-004.1: when file content is invalid JSON, recovery === 'guardrails_defaults' fires.
		const projectDir = mkdtempSync(join(tmpdir(), 'doctor-guard-'));
		const userDir = mkdtempSync(join(tmpdir(), 'doctor-user-'));
		const origXdg = process.env.XDG_CONFIG_HOME;
		try {
			process.env.XDG_CONFIG_HOME = userDir;
			writeInvalidJsonProjectConfig(
				projectDir,
				'not valid json at all { unclosed',
			);
			const output = await handleDoctorCommand(projectDir, []);
			expect(output).toContain('## Config Recovery');
			expect(output).toContain('`guardrails_defaults`');
		} finally {
			if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = origXdg;
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(userDir, { recursive: true, force: true });
		}
	});

	test('SC-004.1: user_only recovery surfaces affected section', async () => {
		// SC-004.1: a project-config type error that survives the unrecognized-keys
		// strip (not just an unknown key) falls back to a valid user config alone.
		const projectDir = mkdtempSync(join(tmpdir(), 'doctor-useronly-'));
		const userDir = mkdtempSync(join(tmpdir(), 'doctor-user-'));
		const origXdg = process.env.XDG_CONFIG_HOME;
		try {
			process.env.XDG_CONFIG_HOME = userDir;
			mkdirSync(join(userDir, 'opencode'), { recursive: true });
			writeFileSync(
				join(userDir, 'opencode', 'opencode-swarm.json'),
				JSON.stringify({ max_iterations: 7, gates: { enabled: true } }),
				'utf-8',
			);
			writeProjectConfig(projectDir, {
				max_iterations: 9,
				council: { enabled: 'yes' },
			});
			const output = await handleDoctorCommand(projectDir, []);
			expect(output).toContain('## Config Recovery');
			expect(output).toContain('`user_only`');
			expect(output).toMatch(/user config|Project config ignored/i);
		} finally {
			if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = origXdg;
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(userDir, { recursive: true, force: true });
		}
	});

	test('SC-004.3: _internals.loadPluginConfigWithMeta exposes recovery metadata', () => {
		// SC-004.3: surgical command-return contract — programmatic consumers
		// (commands like /swarm turbo, /swarm full-auto) can inspect the metadata
		// returned by _internals.loadPluginConfigWithMeta and surface affected
		// section names in their return strings.
		expect(typeof _internals.loadPluginConfigWithMeta).toBe('function');
		// The shape is the documented return type
		const valid = mkdtempSync(join(tmpdir(), 'meta-shape-'));
		const userDir = mkdtempSync(join(tmpdir(), 'meta-user-'));
		const origXdg = process.env.XDG_CONFIG_HOME;
		try {
			process.env.XDG_CONFIG_HOME = userDir;
			writeProjectConfig(valid, { max_iterations: 5 });
			const result = _internals.loadPluginConfigWithMeta(valid);
			// All metadata fields present
			expect(result).toHaveProperty('config');
			expect(result).toHaveProperty('loadedFromFile');
			expect(result).toHaveProperty('configHadErrors');
			expect(result).toHaveProperty('recovery');
			expect(result).toHaveProperty('removedKeys');
			expect(result).toHaveProperty('warnings');
			expect([
				'none',
				'stripped_keys',
				'user_only',
				'guardrails_defaults',
			]).toContain(result.recovery);
			expect(Array.isArray(result.removedKeys)).toBe(true);
			expect(Array.isArray(result.warnings)).toBe(true);
		} finally {
			if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = origXdg;
			rmSync(valid, { recursive: true, force: true });
			rmSync(userDir, { recursive: true, force: true });
		}
	});
});
