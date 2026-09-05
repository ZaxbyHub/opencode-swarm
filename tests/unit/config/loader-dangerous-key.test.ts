import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPluginConfigWithMeta } from '../../../src/config/loader';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Issue #2476 AC2 loader arm: a repo-supplied project config carrying a
 * dangerous merge key must be refused fail-closed (project overlay dropped)
 * while plugin config loading stays fail-open for every benign config.
 * The hostile file is written as RAW JSON TEXT — JSON.parse is what creates
 * `__proto__` as an own enumerable key (source issue #2264).
 */
describe('loader: dangerous-key project config (#2476 AC2)', () => {
	let xdgDir: { dir: string; cleanup: () => void } | undefined;
	let originalXdg: string | undefined;
	let project: { dir: string; cleanup: () => void } | undefined;

	beforeAll(() => {
		xdgDir = createSafeTestDir('loader-danger-xdg-');
		originalXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = xdgDir.dir;
	});

	afterAll(() => {
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		xdgDir?.cleanup();
	});

	beforeEach(() => {
		project = createSafeTestDir('loader-danger-');
		clearDeferredWarnings();
	});

	afterEach(() => {
		project?.cleanup();
		project = undefined;
		clearDeferredWarnings();
	});

	function writeProjectConfig(rawJsonText: string): string {
		const { dir } = project ?? {};
		if (!dir) throw new Error('writeProjectConfig called outside a test');
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			rawJsonText,
		);
		return dir;
	}

	test('hostile __proto__ project config: no throw, security advisory, hostile value absent', () => {
		const dir = writeProjectConfig(
			'{"git":{"__proto__":{"binary":"/evil/shim"}},"max_iterations":9}',
		);
		let meta: ReturnType<typeof loadPluginConfigWithMeta>;
		// Fail-open for the plugin: the load must complete, not crash init.
		expect(() => {
			meta = loadPluginConfigWithMeta(dir);
		}).not.toThrow();
		const warnings = getDeferredWarnings().join('\n');
		expect(warnings).toContain('SECURITY');
		expect(warnings).toContain('__proto__');
		// Fail-closed on the attack: the project overlay is dropped wholesale,
		// so neither the reparented git.binary nor its sibling keys survive.
		expect(
			meta?.config.git?.binary ??
				(meta?.config as Record<string, unknown>)?.git?.binary,
		).toBeUndefined();
		expect(meta?.config.max_iterations).not.toBe(9);
	});

	test('nested __proto__ payload is refused the same way', () => {
		const dir = writeProjectConfig(
			'{"a":{"b":{"__proto__":{"x":1}}},"quiet":true}',
		);
		expect(() => loadPluginConfigWithMeta(dir)).not.toThrow();
		expect(getDeferredWarnings().join('\n')).toContain('SECURITY');
	});

	test('benign project config still merges and emits no security advisory', () => {
		const dir = writeProjectConfig('{"max_iterations": 7}');
		const meta = loadPluginConfigWithMeta(dir);
		expect(meta.config.max_iterations).toBe(7);
		expect(getDeferredWarnings().join('\n')).not.toContain(
			'prototype-pollution',
		);
	});
});
