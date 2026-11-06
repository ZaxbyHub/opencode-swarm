/**
 * Loader/schema coverage for the declarative `sdd.source` setting:
 * readSddSourceSetting, PluginConfigSchema.sdd, and loadPluginConfig wiring.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	loadPluginConfig,
	loadPluginConfigWithMeta,
	readSddSourceSetting,
} from '../../../src/config/loader';
import { PluginConfigSchema, SDD_SOURCES } from '../../../src/config/schema';
import { readEffectiveSpecSync } from '../../../src/sdd/effective-spec';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;
let xdgDir: string;
let savedEnv: string | undefined;
let savedXdg: string | undefined;

function writeProject(content: string): string {
	const abs = path.join(tempDir, '.opencode', 'opencode-swarm.json');
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
	return abs;
}

function writeUser(content: string): string {
	const abs = path.join(xdgDir, 'opencode', 'opencode-swarm.json');
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
	return abs;
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('sdd-setting-');
	xdgDir = path.join(tempDir, '.xdg-config');
	savedEnv = process.env.SWARM_SDD_SOURCE;
	savedXdg = process.env.XDG_CONFIG_HOME;
	delete process.env.SWARM_SDD_SOURCE;
	process.env.XDG_CONFIG_HOME = xdgDir;
	_internals.resetUnknownTopLevelKeyWarning();
	_internals.resetGatesAdvisoryDedup();
	clearDeferredWarnings();
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.SWARM_SDD_SOURCE;
	else process.env.SWARM_SDD_SOURCE = savedEnv;
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	_internals.resetUnknownTopLevelKeyWarning();
	_internals.resetGatesAdvisoryDedup();
	clearDeferredWarnings();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('readSddSourceSetting', () => {
	test('returns each accepted source from project config with origin=project', () => {
		for (const source of SDD_SOURCES) {
			writeProject(JSON.stringify({ sdd: { source } }));
			const s = readSddSourceSetting(tempDir);
			expect(s.source).toBe(source);
			expect(s.origin).toBe('project');
			expect(s.rejected).toBeUndefined();
		}
		expect(SDD_SOURCES).toEqual(['openspec', 'speckit', 'swarm']);
	});

	test('returns user-level source with origin=user when no project config', () => {
		writeUser(JSON.stringify({ sdd: { source: 'speckit' } }));
		const s = readSddSourceSetting(tempDir);
		expect(s).toEqual({
			source: 'speckit',
			origin: 'user',
			rejected: undefined,
		});
	});

	test('project wins over user', () => {
		writeUser(JSON.stringify({ sdd: { source: 'speckit' } }));
		writeProject(JSON.stringify({ sdd: { source: 'openspec' } }));
		const s = readSddSourceSetting(tempDir);
		expect(s.source).toBe('openspec');
		expect(s.origin).toBe('project');
	});

	test('missing files yield an empty setting without throwing', () => {
		expect(readSddSourceSetting(tempDir)).toEqual({
			source: undefined,
			rejected: undefined,
		});
	});

	test('config without an sdd key is skipped and falls through to user config', () => {
		writeProject(JSON.stringify({ max_iterations: 3 }));
		writeUser(JSON.stringify({ sdd: { source: 'swarm' } }));
		const s = readSddSourceSetting(tempDir);
		expect(s.source).toBe('swarm');
		expect(s.origin).toBe('user');
	});

	test('empty sdd object (no source) yields no source and no rejection', () => {
		writeProject(JSON.stringify({ sdd: {} }));
		const s = readSddSourceSetting(tempDir);
		expect(s.source).toBeUndefined();
		expect(s.rejected).toBeUndefined();
	});

	for (const [name, value, display] of [
		['wrong-case string', 'Speckit', 'Speckit'],
		['empty string', '', ''],
		['number', 42, '42'],
		['object', { a: 1 }, '{"a":1}'],
		['array', ['x'], '["x"]'],
		['null', null, 'null'],
		['boolean', false, 'false'],
	] as const) {
		test(`rejects invalid source (${name}) and reports value + config path`, () => {
			const cfg = writeProject(JSON.stringify({ sdd: { source: value } }));
			const s = readSddSourceSetting(tempDir);
			expect(s.source).toBeUndefined();
			expect(s.rejected).toEqual({
				value: display,
				configPath: cfg,
				field: 'sdd.source',
			});
		});
	}

	test('rejected value is truncated to 40 characters', () => {
		writeProject(JSON.stringify({ sdd: { source: 'q'.repeat(300) } }));
		const s = readSddSourceSetting(tempDir);
		expect(s.rejected?.value).toBe('q'.repeat(40));
	});

	for (const [name, sdd, display] of [
		['string', 'openspec', 'openspec'],
		['array', ['openspec'], '["openspec"]'],
		['number', 7, '7'],
		['null', null, 'null'],
	] as const) {
		test(`non-object sdd (${name}) is rejected, not thrown, and does not select`, () => {
			const cfg = writeProject(JSON.stringify({ sdd }));
			const s = readSddSourceSetting(tempDir);
			expect(s.source).toBeUndefined();
			expect(s.rejected).toEqual({
				value: display,
				configPath: cfg,
				field: 'sdd',
			});
		});
	}

	test('invalid project value does not mask a valid user value; rejection still reported', () => {
		const cfg = writeProject(JSON.stringify({ sdd: { source: 'nope' } }));
		writeUser(JSON.stringify({ sdd: { source: 'openspec' } }));
		const s = readSddSourceSetting(tempDir);
		expect(s.source).toBe('openspec');
		expect(s.origin).toBe('user');
		expect(s.rejected).toEqual({
			value: 'nope',
			configPath: cfg,
			field: 'sdd.source',
		});
	});

	test('NOTE-1 mirror: a valid PROJECT source wins while an invalid USER value is still reported', () => {
		writeProject(JSON.stringify({ sdd: { source: 'speckit' } }));
		const userCfg = writeUser(JSON.stringify({ sdd: { source: 'Bogus' } }));
		const s = readSddSourceSetting(tempDir);
		expect(s.source).toBe('speckit');
		expect(s.origin).toBe('project');
		expect(s.rejected).toEqual({
			value: 'Bogus',
			configPath: userCfg,
			field: 'sdd.source',
		});
	});

	test('malformed JSON, oversize file: no throw, no source', () => {
		writeProject('{ not json');
		expect(() => readSddSourceSetting(tempDir)).not.toThrow();
		expect(readSddSourceSetting(tempDir).source).toBeUndefined();
		writeProject(
			JSON.stringify({ sdd: { source: 'speckit' }, pad: 'x'.repeat(110_000) }),
		);
		expect(readSddSourceSetting(tempDir).source).toBeUndefined();
	});

	test('BOM-prefixed config is honored', () => {
		writeProject(`﻿${JSON.stringify({ sdd: { source: 'speckit' } })}`);
		expect(readSddSourceSetting(tempDir).source).toBe('speckit');
	});

	test('repo-root opencode-swarm.json is not read', () => {
		fs.writeFileSync(
			path.join(tempDir, 'opencode-swarm.json'),
			JSON.stringify({ sdd: { source: 'speckit' } }),
		);
		expect(readSddSourceSetting(tempDir).source).toBeUndefined();
	});
});

describe('PluginConfigSchema.sdd', () => {
	test('accepts every valid source', () => {
		for (const source of SDD_SOURCES) {
			const r = PluginConfigSchema.safeParse({ sdd: { source } });
			expect(r.success).toBe(true);
			expect(r.success && r.data.sdd?.source).toBe(source);
		}
	});

	test('accepts a config without sdd (sdd stays undefined)', () => {
		const r = PluginConfigSchema.safeParse({});
		expect(r.success).toBe(true);
		expect(r.success && r.data.sdd).toBeUndefined();
	});

	for (const bad of ['bogus', 'Speckit', 42, {}, ['x'], null]) {
		test(`rejects malformed source ${JSON.stringify(bad)} at path sdd.source (never silently swallowed)`, () => {
			const r = PluginConfigSchema.safeParse({
				sdd: { source: bad },
				max_iterations: 3,
			});
			// The schema reports it so the loader recovery ladder and
			// `/swarm doctor` can name the bad leaf; the sibling-key survival is
			// asserted end-to-end in the loadPluginConfig tests below.
			expect(r.success).toBe(false);
			if (r.success) return;
			expect(
				r.error.issues.some((i) => i.path.join('.') === 'sdd.source'),
			).toBe(true);
		});
	}
});

describe('loadPluginConfig wiring', () => {
	test('project {sdd:{source:"openspec"}} loads as config.sdd.source and emits no unknown-top-level advisory', () => {
		writeProject(JSON.stringify({ sdd: { source: 'openspec' } }));
		const config = loadPluginConfig(tempDir);
		expect(config.sdd?.source).toBe('openspec');
		const unknown = [...getDeferredWarnings()].filter((m) =>
			m.includes('unknown top-level config key'),
		);
		expect(unknown).toEqual([]);
		expect([...getDeferredWarnings()].filter((m) => m.includes('sdd'))).toEqual(
			[],
		);
	});

	test('control: a genuinely unknown top-level key DOES emit the advisory (proves the sdd check is not vacuous)', () => {
		writeProject(
			JSON.stringify({ sdd: { source: 'openspec' }, sddd: { source: 'x' } }),
		);
		loadPluginConfig(tempDir);
		const unknown = [...getDeferredWarnings()].filter((m) =>
			m.includes('unknown top-level config key'),
		);
		expect(unknown).toHaveLength(1);
		expect(unknown[0]).toContain('sddd');
		expect(unknown[0]).not.toMatch(/(^|[ ,:])sdd(,|\.| |$)/);
	});

	test('invalid sdd.source in a project config (no user-level config): the recovery ladder drops only that leaf and keeps other keys', () => {
		writeProject(
			JSON.stringify({ sdd: { source: 'Speckit' }, max_iterations: 4 }),
		);
		const config = loadPluginConfig(tempDir);
		expect(config.sdd?.source).toBeUndefined();
		expect(config.max_iterations).toBe(4);
	});

	test('with a user-level (installer-shape) config present, an invalid sdd.source is a validation error handled like ANY invalid key (fail-secure user_only recovery) — pins the documented behavior', () => {
		writeUser(JSON.stringify({ agents: { coder: { model: 'x/y' } } }));
		writeProject(
			JSON.stringify({ sdd: { source: 'Speckit' }, max_iterations: 7 }),
		);
		const bad = loadPluginConfigWithMeta(tempDir);

		// Control: a bad value in a DIFFERENT key takes the identical path, so
		// sdd.source is not special-cased (and not silently swallowed).
		writeProject(JSON.stringify({ max_iterations: 'nope', max_other: 1 }));
		const control = loadPluginConfigWithMeta(tempDir);
		expect(control.recovery).toBe('user_only');
		expect(bad.recovery).toBe(control.recovery);
		expect(bad.config.sdd?.source).toBeUndefined();

		// Fixing the value restores the project config in full.
		writeProject(
			JSON.stringify({ sdd: { source: 'speckit' }, max_iterations: 7 }),
		);
		const fixed = loadPluginConfigWithMeta(tempDir);
		expect(fixed.recovery).toBe('none');
		expect(fixed.config.sdd?.source).toBe('speckit');
		expect(fixed.config.max_iterations).toBe(7);
	});
});

describe('file-level diagnostics stay with the full loader (the SDD resolver runs on every gate call)', () => {
	const failureCount = (): number =>
		[...getDeferredWarnings()].filter((m) => m.includes('CONFIG LOAD FAILURE'))
			.length;

	test('a malformed project config: readSddSourceSetting emits NO file-level diagnostics, however often it is called', () => {
		writeProject('{ not json');
		for (let i = 0; i < 5; i++) readSddSourceSetting(tempDir);
		// Without the silent read this is 5 (and a SECURITY line each): the
		// deferred-warning buffer is capped, so a resolver called in a gate loop
		// would crowd out every other advisory.
		expect(getDeferredWarnings()).toEqual([]);
	});

	test('an oversize project config and a non-object config are also silent', () => {
		writeProject(JSON.stringify({ pad: 'x'.repeat(110_000) }));
		readSddSourceSetting(tempDir);
		writeProject('[1,2,3]');
		readSddSourceSetting(tempDir);
		expect(getDeferredWarnings()).toEqual([]);
	});

	test('default-path parity: readEffectiveSpecSync on a repo with a malformed config and NO SDD setting buffers zero warnings of its own', () => {
		writeProject('{ not json');
		for (let i = 0; i < 3; i++) readEffectiveSpecSync(tempDir);
		expect(getDeferredWarnings()).toEqual([]);
	});

	test('control: the full config loader still reports the same file (once per load)', () => {
		writeProject('{ not json');
		loadPluginConfig(tempDir);
		loadPluginConfig(tempDir);
		expect(failureCount()).toBeGreaterThanOrEqual(2);
	});
});
