/**
 * Init-safety tests for the external skill curation feature.
 *
 * Verifies the core invariant: curation is disabled by default and the
 * plugin fails OPEN on config errors — it never crashes or blocks
 * initialisation due to a bad external_skills section.
 *
 * AGENTS.md #1 — plugin init is fast, bounded, fail-open.
 * AGENTS.md #4 — .swarm containment (no init-time network calls).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginConfig } from '../../../src/config/loader';
import {
	DEFAULT_EXTERNAL_SKILLS_CONFIG,
	resolveExternalSkillsConfig,
} from '../../../src/config/schema.js';

describe('external-skill init safety', () => {
	describe('resolveExternalSkillsConfig fail-open defaults', () => {
		test('undefined input returns disabled config', () => {
			const result = resolveExternalSkillsConfig(undefined);
			expect(result.curation_enabled).toBe(false);
			expect(result.sources).toEqual([]);
		});

		test('null input returns disabled config', () => {
			const result = resolveExternalSkillsConfig(null);
			expect(result.curation_enabled).toBe(false);
			expect(result.sources).toEqual([]);
		});

		test('empty object returns disabled config', () => {
			const result = resolveExternalSkillsConfig({});
			expect(result.curation_enabled).toBe(false);
			expect(result.sources).toEqual([]);
		});

		test('string input returns disabled config', () => {
			const result = resolveExternalSkillsConfig('invalid');
			expect(result.curation_enabled).toBe(false);
			expect(result.sources).toEqual([]);
		});

		test('array input returns disabled config', () => {
			const result = resolveExternalSkillsConfig([1, 2, 3]);
			expect(result.curation_enabled).toBe(false);
			expect(result.sources).toEqual([]);
		});

		test('valid config with curation_enabled true enables curation', () => {
			const result = resolveExternalSkillsConfig({ curation_enabled: true });
			expect(result.curation_enabled).toBe(true);
		});

		test('valid config preserves other defaults when only curation_enabled is set', () => {
			const result = resolveExternalSkillsConfig({ curation_enabled: true });
			expect(result.max_candidates).toBe(
				DEFAULT_EXTERNAL_SKILLS_CONFIG.max_candidates,
			);
			expect(result.ttl_days).toBe(DEFAULT_EXTERNAL_SKILLS_CONFIG.ttl_days);
			expect(result.evaluation_enabled).toBe(false);
			expect(result.sources).toEqual([]);
		});
	});

	describe('DEFAULT_EXTERNAL_SKILLS_CONFIG', () => {
		test('has no sources (no auto-configured sources)', () => {
			expect(DEFAULT_EXTERNAL_SKILLS_CONFIG.sources).toEqual([]);
		});

		test('curation_enabled is false', () => {
			expect(DEFAULT_EXTERNAL_SKILLS_CONFIG.curation_enabled).toBe(false);
		});

		test('evaluation_enabled is false', () => {
			expect(DEFAULT_EXTERNAL_SKILLS_CONFIG.evaluation_enabled).toBe(false);
		});
	});

	describe('loadPluginConfig with invalid external_skills (indirect sanitize)', () => {
		let tempDir: string;
		let originalXDG: string | undefined;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-es-test-'));
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

		test('invalid external_skills config does not crash plugin', () => {
			const projectDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-es-proj-')),
			);
			const configDir = path.join(projectDir, '.opencode');
			const configFile = path.join(configDir, 'opencode-swarm.json');

			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				configFile,
				JSON.stringify({
					external_skills: {
						curation_enabled: 'not-a-boolean',
						sources: 'not-an-array',
					},
				}),
			);

			// Should NOT throw — fail-open sanitization strips the bad section
			const result = loadPluginConfig(projectDir);

			// external_skills is either undefined (stripped) or resolved to safe defaults
			if (result.external_skills) {
				expect(result.external_skills.curation_enabled).toBe(false);
			}

			fs.rmSync(projectDir, { recursive: true, force: true });
		});

		test('missing external_skills section leaves curation disabled', () => {
			// Create a project config with no external_skills section at all
			const projectDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-es-proj-')),
			);
			const configDir = path.join(projectDir, '.opencode');
			const configFile = path.join(configDir, 'opencode-swarm.json');

			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(configFile, JSON.stringify({ max_iterations: 7 }));

			const result = loadPluginConfig(projectDir);

			// external_skills should be undefined (Zod optional) or have safe defaults
			if (result.external_skills) {
				expect(result.external_skills.curation_enabled).toBe(false);
			}

			fs.rmSync(projectDir, { recursive: true, force: true });
		});

		test('no config files at all returns plugin defaults with no crash', () => {
			const projectDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-es-proj-')),
			);

			// No config files — isolated temp means no user config either
			const result = loadPluginConfig(projectDir);

			// Plugin should load successfully with defaults
			expect(result).toBeDefined();
			expect(result.max_iterations).toBeDefined();
			expect(result.qa_retry_limit).toBeDefined();

			fs.rmSync(projectDir, { recursive: true, force: true });
		});
	});

	describe('no auto-fetch during init', () => {
		test('resolveExternalSkillsConfig never calls fetch (AGENTS.md #1)', () => {
			let fetchCallCount = 0;
			const originalFetch = globalThis.fetch;
			globalThis.fetch = (() => {
				fetchCallCount++;
				throw new Error('fetch should not be called during init');
			}) as typeof fetch;

			try {
				// Exercise all config resolution paths with various inputs
				resolveExternalSkillsConfig(undefined);
				resolveExternalSkillsConfig(null);
				resolveExternalSkillsConfig({});
				resolveExternalSkillsConfig('invalid');
				resolveExternalSkillsConfig([1, 2, 3]);
				resolveExternalSkillsConfig({ curation_enabled: false });
				resolveExternalSkillsConfig({
					curation_enabled: true,
					sources: [
						{
							type: 'url',
							location: 'https://example.com/skill',
							enabled: true,
						},
					],
				});

				expect(fetchCallCount).toBe(0);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		test('loadPluginConfig with external_skills sources does not call fetch (AGENTS.md #1)', () => {
			const projectDir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-es-fetch-')),
			);
			const configDir = path.join(projectDir, '.opencode');
			const configFile = path.join(configDir, 'opencode-swarm.json');

			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				configFile,
				JSON.stringify({
					external_skills: {
						curation_enabled: true,
						sources: [
							{
								type: 'url',
								location: 'https://example.com/skills',
								enabled: true,
							},
						],
					},
				}),
			);

			let fetchCallCount = 0;
			const originalFetch = globalThis.fetch;
			globalThis.fetch = (() => {
				fetchCallCount++;
				throw new Error('fetch should not be called during loadPluginConfig');
			}) as typeof fetch;

			try {
				loadPluginConfig(projectDir);
				expect(fetchCallCount).toBe(0);
			} finally {
				globalThis.fetch = originalFetch;
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});
});
