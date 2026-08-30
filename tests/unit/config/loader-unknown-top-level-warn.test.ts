import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPluginConfig } from '../../../src/config/loader';
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
});
