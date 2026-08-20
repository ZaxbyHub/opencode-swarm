/**
 * `git.binary` provenance gate — CWE-427 (uncontrolled search path) /
 * CWE-77 (command injection) regression coverage.
 *
 * THE ATTACK these tests exist to keep closed: `git.binary` names the
 * executable the plugin spawns for EVERY host-side git call, and it is
 * registered as the first resolver candidate (`setGitBinaryOverride`,
 * src/index.ts → src/utils/git-executable.ts). The project config is read
 * from `<repo>/.opencode/opencode-swarm.json` — a file inside the repository.
 * A hostile repo therefore needs no second write primitive: it commits the
 * config AND the shim it points at, and the shim (already on the victim's
 * disk the moment they clone) runs with the user's privileges.
 *
 * The gate lives in `enforceGitBinaryProvenance` (src/config/loader.ts),
 * applied to the RAW inputs immediately after the deep-merge, because merge
 * gives the project value precedence and every recovery branch downstream
 * derives from the merged object.
 *
 * These assertions are made at the LOADER layer on purpose. Asserting
 * "the shim was not spawned" through the resolver instead would pass for the
 * wrong reason whenever the fixture path shape does not match the simulated
 * platform (`probeCandidate` rejects on absoluteness first).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	loadPluginConfig,
	loadPluginConfigWithMetaAsync,
} from '../../../src/config/loader';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const USER_GIT = '/opt/homebrew/bin/git';

let sandbox: string;
let userConfigDir: string;
let projectDir: string;
let originalXdg: string | undefined;

/** The repo-local shim a malicious repository would commit alongside its config. */
function shimPath(): string {
	return path.join(projectDir, '.opencode', 'git-shim');
}

function writeUserConfig(config: Record<string, unknown>): void {
	fs.mkdirSync(userConfigDir, { recursive: true });
	fs.writeFileSync(
		path.join(userConfigDir, 'opencode-swarm.json'),
		JSON.stringify(config),
	);
}

function writeProjectConfig(config: Record<string, unknown>): void {
	const dir = path.join(projectDir, '.opencode');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'opencode-swarm.json'),
		JSON.stringify(config),
	);
}

function refusalWarnings(): string[] {
	return getDeferredWarnings().filter((w) => w.includes('git.binary'));
}

beforeEach(() => {
	sandbox = canonicalMkdtemp('git-binary-provenance-');
	userConfigDir = path.join(sandbox, 'xdg', 'opencode');
	projectDir = path.join(sandbox, 'repo');
	fs.mkdirSync(projectDir, { recursive: true });
	originalXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = path.join(sandbox, 'xdg');
	clearDeferredWarnings();
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
	clearDeferredWarnings();
	fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('git.binary provenance — project config is untrusted', () => {
	it('refuses a project-supplied git.binary pointing at a repo-local shim', () => {
		const shim = shimPath();
		fs.mkdirSync(path.dirname(shim), { recursive: true });
		fs.writeFileSync(shim, '#!/bin/sh\n');
		// Precondition: the shim really is on disk, so a pass cannot come from
		// "the file did not exist" instead of "the value was refused".
		expect(fs.existsSync(shim)).toBe(true);
		writeProjectConfig({ git: { binary: shim } });

		const config = loadPluginConfig(projectDir);

		expect(config.git?.binary).toBeUndefined();
		const warnings = refusalWarnings();
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('SECURITY');
		expect(warnings[0]).toContain('project config');
		expect(warnings[0]).toContain('OPENCODE_SWARM_GIT_BINARY');
	});

	it('keeps the USER value when the project config tries to replace it', () => {
		writeUserConfig({ git: { binary: USER_GIT } });
		writeProjectConfig({ git: { binary: shimPath() } });

		const config = loadPluginConfig(projectDir);

		expect(config.git?.binary).toBe(USER_GIT);
		expect(refusalWarnings().length).toBe(1);
	});

	it('refuses the project value on the RECOVERY path too — a bogus key alongside git.binary must not reopen the hole', () => {
		// A malicious repo can force the loader off its happy path at will by
		// adding one unrecognized key. Every recovery branch must still see the
		// neutralized object.
		writeProjectConfig({
			git: { binary: shimPath() },
			totally_unrecognized_key: { forces: 'recovery' },
		});

		const config = loadPluginConfig(projectDir);

		expect(config.git?.binary).toBeUndefined();
		expect(refusalWarnings().length).toBe(1);
	});

	it('refuses the project value when a malformed VALUE forces value-recovery', () => {
		// Wrong-type value on a recognized key drives step 7b
		// (sanitizeMalformedValues) rather than the unrecognized-key strip.
		writeProjectConfig({
			git: { binary: shimPath() },
			quiet: 'not-a-boolean',
		});

		const config = loadPluginConfig(projectDir);

		expect(config.git?.binary).toBeUndefined();
	});

	it('refuses the project value through the async init path as well', async () => {
		writeUserConfig({ git: { binary: USER_GIT } });
		writeProjectConfig({ git: { binary: shimPath() } });

		const { config } = await loadPluginConfigWithMetaAsync(projectDir);

		expect(config.git?.binary).toBe(USER_GIT);
	});

	it('refuses a git.binary smuggled through a __proto__ payload', () => {
		// MEASURED BYPASS, not a hypothetical. `JSON.parse` makes "__proto__" an
		// own ENUMERABLE data property, and `deepMerge` walks `Object.keys`, so
		// this payload reaches `result['__proto__'] = …` on an object with no own
		// `__proto__` — invoking the setter and REPARENTING the merged object.
		// `mergedRaw.git` then resolves through the hostile prototype. An earlier
		// revision of the gate checked `rawProjectConfig.git` (an own-property
		// read, `undefined` for this shape) and returned "/x/shim" here.
		//
		// Written as raw JSON text on purpose: an object literal `{__proto__: …}`
		// sets the prototype instead of creating the own key, so it would NOT
		// reproduce the payload.
		fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, '.opencode', 'opencode-swarm.json'),
			`{"__proto__":{"git":{"binary":${JSON.stringify(shimPath())}}}}`,
		);

		const config = loadPluginConfig(projectDir);

		expect(config.git?.binary).toBeUndefined();
		expect(refusalWarnings().length).toBe(1);
	});

	it('refuses a git.binary reachable only through the git object own prototype', () => {
		fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, '.opencode', 'opencode-swarm.json'),
			`{"git":{"__proto__":{"binary":${JSON.stringify(shimPath())}}}}`,
		);

		const config = loadPluginConfig(projectDir);

		expect(config.git?.binary).toBeUndefined();
	});

	it('does not leave a "git": {} husk that only the project config introduced', () => {
		writeProjectConfig({ git: { binary: shimPath() } });

		const config = loadPluginConfig(projectDir);

		expect(config.git).toBeUndefined();
	});
});

describe('git.binary provenance — the legitimate escape hatch still works', () => {
	it('honors a user-level git.binary with no project config present', () => {
		writeUserConfig({ git: { binary: USER_GIT } });

		const config = loadPluginConfig(projectDir);

		expect(config.git?.binary).toBe(USER_GIT);
		expect(refusalWarnings()).toEqual([]);
	});

	it('honors a user-level git.binary when the project config sets OTHER keys', () => {
		writeUserConfig({ git: { binary: USER_GIT } });
		writeProjectConfig({ quiet: true });

		const config = loadPluginConfig(projectDir);

		expect(config.git?.binary).toBe(USER_GIT);
		expect(config.quiet).toBe(true);
		expect(refusalWarnings()).toEqual([]);
	});

	it('does not warn when both configs name the SAME executable — the user already authorized it', () => {
		writeUserConfig({ git: { binary: USER_GIT } });
		writeProjectConfig({ git: { binary: USER_GIT } });

		const config = loadPluginConfig(projectDir);

		expect(config.git?.binary).toBe(USER_GIT);
		expect(refusalWarnings()).toEqual([]);
	});

	it('leaves an unrelated project-supplied git section untouched', () => {
		writeProjectConfig({ git: {} });

		const config = loadPluginConfig(projectDir);

		expect(config.git?.binary).toBeUndefined();
		expect(refusalWarnings()).toEqual([]);
	});
});
