/**
 * #3355 AC7 (acceptance check C7): the bun test preload
 * tests/preload/sdd-selection-env-pin.ts must neutralize the HOST user-level
 * config file's influence, not just the ambient SWARM_SDD_SOURCE env var —
 * a host carrying `sdd.source` in ~/.config/opencode/opencode-swarm.json must
 * not change any suite's results.
 *
 * Contract under test (the preload file itself is FIX SURFACE — this test
 * only pins its behavior, it does not modify it): when the preload runs in a
 * process where XDG_CONFIG_HOME is NOT set, the preload must point
 * XDG_CONFIG_HOME at an existing EMPTY directory (no opencode-swarm.json
 * inside), so config-reading tests resolve against a known-empty user config
 * instead of the host's real one.
 *
 * RED at base (the preload only deletes SWARM_SDD_SOURCE, so the child prints
 * XDG=UNSET), GREEN after the fix.
 *
 * The child is a fresh `bun -e` process: bunfig's [test] preload does NOT run
 * under `bun -e`, so the preload module is imported explicitly — exactly the
 * environment a test process sees at load time.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearDeferredWarnings } from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const repoRoot = path.join(import.meta.dir, '..', '..', '..');

let tempDir: string;
let savedEnv: string | undefined;
let savedXdg: string | undefined;

/** Bounded scan (depth <= 3) proving no opencode-swarm.json lives under dir. */
function containsConfigFile(dir: string): boolean {
	const queue: { p: string; depth: number }[] = [{ p: dir, depth: 0 }];
	let visited = 0;
	while (queue.length > 0 && visited < 200) {
		const { p, depth } = queue.shift() as { p: string; depth: number };
		visited += 1;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(p, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.name === 'opencode-swarm.json') return true;
			if (e.isDirectory() && depth < 3) {
				queue.push({ p: path.join(p, e.name), depth: depth + 1 });
			}
		}
	}
	return false;
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('sdd-xdg-pin-');
	savedEnv = process.env.SWARM_SDD_SOURCE;
	savedXdg = process.env.XDG_CONFIG_HOME;
	delete process.env.SWARM_SDD_SOURCE;
	clearDeferredWarnings();
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.SWARM_SDD_SOURCE;
	else process.env.SWARM_SDD_SOURCE = savedEnv;
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	clearDeferredWarnings();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('#3355 AC7: the sdd-selection preload neutralizes the host user-level config', () => {
	test('preload sets XDG_CONFIG_HOME to an existing empty directory when the environment does not set it', () => {
		const preloadUrl = pathToFileURL(
			path.join(repoRoot, 'tests', 'preload', 'sdd-selection-env-pin.ts'),
		).href;
		const script =
			`import ${JSON.stringify(preloadUrl)}; ` +
			"console.log('XDG=' + (process.env.XDG_CONFIG_HOME ?? 'UNSET'));";

		// The child must see a world where neither variable is set — the same
		// starting state a bare `bun test` process has before the preload runs.
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.XDG_CONFIG_HOME;
		delete env.SWARM_SDD_SOURCE;

		let out = '';
		let failure: string | undefined;
		try {
			out = child_process.execFileSync(process.execPath, ['-e', script], {
				env,
				timeout: 15_000,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			failure = String(err).slice(0, 300);
		}
		if (failure !== undefined) {
			throw new Error(`preload child failed: ${failure}`);
		}

		const match = /^XDG=(.*)$/m.exec(out);
		expect(match).not.toBeNull();
		const printed = match?.[1]?.trim();

		// At base the preload does not touch XDG_CONFIG_HOME and the child
		// prints XDG=UNSET — the leak vector #3355 describes.
		expect(printed).toBeDefined();
		expect(printed).not.toBe('UNSET');

		// The pinned directory must exist and contain no opencode-swarm.json,
		// so a host user-level sdd.source can never leak through it.
		const dir = printed as string;
		expect(fs.existsSync(dir)).toBe(true);
		expect(fs.statSync(dir).isDirectory()).toBe(true);
		expect(containsConfigFile(dir)).toBe(false);
	});

	test('critic round-1 finding 2: an EXPLICITLY SET ambient XDG_CONFIG_HOME is also neutralized by the preload', () => {
		const preloadUrl = pathToFileURL(
			path.join(repoRoot, 'tests', 'preload', 'sdd-selection-env-pin.ts'),
		).href;
		const script =
			`import ${JSON.stringify(preloadUrl)}; ` +
			"console.log('XDG=' + process.env.XDG_CONFIG_HOME);";

		// A developer host that EXPORTED XDG_CONFIG_HOME pointing at its real
		// user config (with sdd.source inside) must not leak through: the
		// preload overwrites the ambient value, not only the unset case.
		const hostConfigDir = path.join(tempDir, 'host-xdg');
		fs.mkdirSync(path.join(hostConfigDir, 'opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(hostConfigDir, 'opencode', 'opencode-swarm.json'),
			JSON.stringify({ sdd: { source: 'speckit' } }),
			'utf-8',
		);
		const env: NodeJS.ProcessEnv = { ...process.env };
		env.XDG_CONFIG_HOME = hostConfigDir;
		delete env.SWARM_SDD_SOURCE;

		let out = '';
		let failure: string | undefined;
		try {
			out = child_process.execFileSync(process.execPath, ['-e', script], {
				env,
				timeout: 15_000,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			failure = String(err).slice(0, 300);
		}
		if (failure !== undefined) {
			throw new Error(`preload child failed: ${failure}`);
		}
		const match = /^XDG=(.*)$/m.exec(out);
		expect(match).not.toBeNull();
		const printed = match?.[1]?.trim();

		// At base the preload leaves the ambient value untouched and the child
		// prints the host dir — the leak. Post-fix it must print the
		// neutralized dir, which must exist, be a directory, and hold no
		// opencode-swarm.json.
		expect(printed).toBeDefined();
		expect(printed).not.toBe(hostConfigDir);
		expect(fs.existsSync(printed as string)).toBe(true);
		expect(containsConfigFile(printed as string)).toBe(false);
	});
});
