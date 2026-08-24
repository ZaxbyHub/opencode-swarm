/**
 * Issue #2102 contracts C/E/F — config-doctor council visibility findings.
 *
 * Warnings fire ONLY when the user explicitly wrote the key in a raw config
 * file; absent/default config produces no noise.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginConfigSchema } from '../../../src/config/schema';
import { runConfigDoctor } from '../../../src/services/config-doctor';

let tempDir: string;

function writeProjectConfig(council: Record<string, unknown> | undefined) {
	mkdirSync(join(tempDir, '.opencode'), { recursive: true });
	const config: Record<string, unknown> = {};
	if (council !== undefined) {
		config.council = council;
	}
	writeFileSync(
		join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config),
	);
}

function councilFindingIds(): string[] {
	const parsed = PluginConfigSchema.parse({});
	const result = runConfigDoctor(parsed, tempDir);
	return result.findings
		.filter((finding) => finding.id.startsWith('council-'))
		.map((finding) => finding.id);
}

let xdgDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-council-')));
	// Isolate the user-level config so the developer's global
	// opencode-swarm.json cannot leak findings into these assertions.
	xdgDir = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-council-xdg-')));
	originalXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = xdgDir;
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	rmSync(xdgDir, { recursive: true, force: true });
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
});

describe('council.parallelTimeoutMs deprecation warning', () => {
	test('explicit set produces a warn finding', () => {
		writeProjectConfig({ enabled: true, parallelTimeoutMs: 60_000 });
		expect(councilFindingIds()).toContain(
			'council-parallel-timeout-deprecated',
		);
	});

	test('absent config produces no finding (no default noise)', () => {
		writeProjectConfig({ enabled: true });
		expect(councilFindingIds()).toEqual([]);
	});

	test('no council config at all produces no finding', () => {
		writeProjectConfig(undefined);
		expect(councilFindingIds()).toEqual([]);
	});
});

describe('council.escalateOnMaxRounds inert warning (#1650)', () => {
	test('explicit set produces a warn finding', () => {
		writeProjectConfig({
			enabled: true,
			escalateOnMaxRounds: 'https://hooks.example.invalid/x?q=secret',
		});
		const ids = councilFindingIds();
		expect(ids).toContain('council-escalate-inert');
	});

	test('the handler/webhook string is never echoed in the finding', () => {
		writeProjectConfig({
			enabled: true,
			escalateOnMaxRounds: 'https://hooks.example.invalid/x?q=secret',
		});
		const parsed = PluginConfigSchema.parse({});
		const result = runConfigDoctor(parsed, tempDir);
		const finding = result.findings.find(
			(f) => f.id === 'council-escalate-inert',
		);
		expect(finding).toBeDefined();
		expect(JSON.stringify(finding)).not.toContain('hooks.example');
		expect(JSON.stringify(finding)).not.toContain('secret');
	});

	test('absent config produces no finding', () => {
		writeProjectConfig({ enabled: true });
		expect(councilFindingIds()).toEqual([]);
	});
});

describe('council.finalCompletionPolicy quorum visibility', () => {
	test('explicit quorum mode is visibly flagged as weaker than strict', () => {
		writeProjectConfig({
			enabled: true,
			finalCompletionPolicy: { mode: 'quorum', minimumMembers: 4 },
		});
		expect(councilFindingIds()).toContain('council-final-quorum-weaker');
	});

	test('explicit all_required produces no finding', () => {
		writeProjectConfig({
			enabled: true,
			finalCompletionPolicy: { mode: 'all_required' },
		});
		expect(councilFindingIds()).toEqual([]);
	});

	test('absent policy (strict default) produces no finding', () => {
		writeProjectConfig({ enabled: true });
		expect(councilFindingIds()).toEqual([]);
	});
});
