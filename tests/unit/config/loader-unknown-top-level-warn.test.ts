import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, loadPluginConfig } from '../../../src/config/loader';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #1663 — top-level unknown-key visibility. The root config schema is
 * intentionally not `.strict()` (legacy configs must keep loading), so Zod
 * silently strips unknown top-level keys. Before this change a typo like
 * `guardrailz` produced NO signal at all — unlike nested strict-section typos,
 * which at least enter the recovery ladder. The loader now warns once per load.
 */

let sandbox: string;
let projectDir: string;
let originalXdg: string | undefined;

function writeProjectConfig(config: Record<string, unknown>): void {
	const dir = path.join(projectDir, '.opencode');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'opencode-swarm.json'),
		JSON.stringify(config),
	);
}

function unknownKeyWarnings(): string[] {
	return getDeferredWarnings().filter((w) =>
		w.includes('unknown top-level config key'),
	);
}

beforeEach(() => {
	sandbox = canonicalMkdtemp('loader-unknown-top-level-');
	projectDir = path.join(sandbox, 'repo');
	fs.mkdirSync(projectDir, { recursive: true });
	originalXdg = process.env.XDG_CONFIG_HOME;
	// Point the user config at an empty dir so only the project config loads.
	process.env.XDG_CONFIG_HOME = path.join(sandbox, 'xdg-empty');
	fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
	clearDeferredWarnings();
	// The warning is deduped per process (bounded module state); reset so
	// tests stay order-independent (AGENTS.md invariant 7).
	_internals.resetUnknownTopLevelKeyWarning();
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
	fs.rmSync(sandbox, { recursive: true, force: true });
	clearDeferredWarnings();
});

describe('config/loader — unknown top-level key warning (#1663)', () => {
	it('warns once listing the unknown top-level keys', () => {
		writeProjectConfig({ guardrailz: { enabled: true }, max_iterations: 7 });
		const config = loadPluginConfig(projectDir);

		const warnings = unknownKeyWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('guardrailz');
		expect(warnings[0]).toContain('unknown top-level config key');
		// The rest of the config still loads normally.
		expect(config.max_iterations).toBe(7);
	});

	it('warns for a $shcema typo (defense below the editor layer)', () => {
		writeProjectConfig({ $shcema: 'https://example.com/x.json' });
		loadPluginConfig(projectDir);
		const warnings = unknownKeyWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('$shcema');
	});

	it('warns exactly once for an object-shaped top-level typo (no step-6 duplicate)', () => {
		// The root schema is not strict, so a top-level typo produces no Zod
		// issue and the step-6 nested-key recovery never names it — the 4b
		// warning must be the ONLY signal, even when the parse also enters a
		// recovery path for an unrelated nested strict-section typo.
		writeProjectConfig({
			some_typo: { nested: true },
			council: { enabled: true, maxRoundz: 5 },
		});
		const config = loadPluginConfig(projectDir);

		const warnings = unknownKeyWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('some_typo');
		// The nested typo keeps its own recovery warning; the rest survives.
		expect(getDeferredWarnings().some((w) => w.includes('maxRoundz'))).toBe(
			true,
		);
		expect(config.council?.enabled).toBe(true);
	});

	it('does not warn for a valid $schema reference', () => {
		writeProjectConfig({
			$schema: 'https://unpkg.com/opencode-swarm/opencode-swarm.schema.json',
		});
		loadPluginConfig(projectDir);
		expect(unknownKeyWarnings()).toEqual([]);
	});

	it('does not warn for a config with only known keys', () => {
		writeProjectConfig({ max_iterations: 3, quiet: false });
		loadPluginConfig(projectDir);
		expect(unknownKeyWarnings()).toEqual([]);
	});

	it('does not warn when no config file exists', () => {
		loadPluginConfig(projectDir);
		expect(unknownKeyWarnings()).toEqual([]);
	});

	it('warns at most once per distinct unknown-key set (dedup across loads)', () => {
		writeProjectConfig({ guardrailz: { enabled: true } });
		loadPluginConfig(projectDir);
		loadPluginConfig(projectDir);
		loadPluginConfig(projectDir);
		expect(unknownKeyWarnings()).toHaveLength(1);
	});

	it('a changed unknown-key set warns again after a resolved set', () => {
		writeProjectConfig({ guardrailz: { enabled: true } });
		loadPluginConfig(projectDir);
		fs.writeFileSync(
			path.join(projectDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ max_iterations: 4 }),
		);
		loadPluginConfig(projectDir);
		expect(unknownKeyWarnings()).toHaveLength(1);
		fs.writeFileSync(
			path.join(projectDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ watchccion: { enabled: true }, max_iterations: 4 }),
		);
		loadPluginConfig(projectDir);
		// Different unknown set → surfaces again; the resolved middle load
		// warned nothing new.
		expect(unknownKeyWarnings()).toHaveLength(2);
	});
});

describe('config/loader — malformed $schema containment (PR review: MF-1)', () => {
	it('degrades a malformed $schema to absent instead of failing the load', () => {
		writeProjectConfig({ $schema: 123, max_iterations: 7 });
		const config = loadPluginConfig(projectDir);
		expect(config.max_iterations).toBe(7);
		expect(config.$schema).toBeUndefined();
		// Inert metadata — never reported as an unknown key.
		expect(unknownKeyWarnings()).toEqual([]);
	});

	it('a malformed $schema never cascades to guardrails-only defaults', () => {
		// Regression guard for the review finding: a typed $schema raised
		// invalid_type, which stripUnrecognizedKeys cannot drop, and with
		// guardrails explicitly disabled the value-recovery path was skipped —
		// wiping the entire config to guardrails defaults. `.catch(undefined)`
		// keeps this ordinary payload loading intact.
		writeProjectConfig({
			$schema: 123,
			max_iterations: 7,
			guardrails: { enabled: false },
		});
		const config = loadPluginConfig(projectDir);
		expect(config.max_iterations).toBe(7);
		expect(config.guardrails?.enabled).toBe(false);
		expect(unknownKeyWarnings()).toEqual([]);
	});
});

describe('config/loader — dormant legacy v6.12 keys (PR review: MF-2)', () => {
	it('strips legacy keys with accurate wording when an agents block exists', () => {
		writeProjectConfig({
			presets: { remote: { architect: { model: 'x' } } },
			preset: 'remote',
			swarm_mode: true,
			agents: { coder: { model: 'y' } },
		});
		const config = loadPluginConfig(projectDir);

		// agents wins; legacy keys are gone from the merged raw config.
		expect(config.agents?.coder?.model).toBe('y');
		expect((config as Record<string, unknown>).presets).toBeUndefined();

		// A dedicated legacy warning — NOT the unknown-top-level-key warning,
		// which would misreport recognized v6.12 fields as typos.
		expect(
			getDeferredWarnings().some((w) =>
				w.includes('Ignored legacy v6.12 config key(s)'),
			),
		).toBe(true);
		expect(unknownKeyWarnings()).toEqual([]);
	});
});
