/**
 * #3105 (AC1 + AC3, acceptance check C3): a raw-level `full_auto.locked: true`
 * at EITHER config level must survive EVERY recovery branch of
 * `loadPluginConfigWithMeta` — no recovery branch may hand back a silently
 * unlocked config that `authorizeFullAuto` would then authorize.
 *
 * Remedy-agnostic contract under test (either remedy satisfies it):
 *   `meta.config.full_auto?.locked === true || meta.configHadErrors === true`
 *
 * Legs (a) step-7 user_only via invalid project + valid user,
 *      (b) step-7 user_only via invalid project + stray-key user,
 *      (c) step-8 guardrails_defaults via invalid user + guardrails-disabled
 *          project,
 * are RED at base (the lock is dropped and the load is not classified as
 * errored), GREEN after the fix. Legs (d) read-level error arm and (e) valid
 * control are GREEN at base and must STAY green after the fix (controls that
 * pin the already-correct branches).
 *
 * Fixtures are adapted from the trace probes
 * (.agents/issue-traces/3105-3354-3355-3356-config-loader-sdd/repro/).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigLoadResult } from '../../../src/config/loader';
import {
	_internals,
	loadPluginConfigWithMeta,
} from '../../../src/config/loader';
import { clearDeferredWarnings } from '../../../src/services/warning-buffer';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;
let xdgDir: string;
let savedEnv: string | undefined;
let savedXdg: string | undefined;

function writeProject(content: string): string {
	const abs = path.join(tempDir, 'project', '.opencode', 'opencode-swarm.json');
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

function projectDir(): string {
	return path.join(tempDir, 'project');
}

/** The authorizeFullAuto fail-closed predicate, replicated: refuse unless the
 * lock survived the recovery branch OR the load was classified as errored. */
function lockPreservedOrErrored(meta: ConfigLoadResult): boolean {
	return (
		(meta.config as { full_auto?: { locked?: boolean } }).full_auto?.locked ===
			true || meta.configHadErrors === true
	);
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('full-auto-lock-');
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

describe('#3105 full_auto.locked must survive every loader recovery branch', () => {
	test('(a) invalid project (wrong-typed recognized key) + valid user: user_only recovery must not silently unlock', () => {
		writeProject(JSON.stringify({ full_auto: { locked: true, mode: 123 } }));
		writeUser(JSON.stringify({ max_iterations: 9 }));

		const meta = loadPluginConfigWithMeta(projectDir());
		expect(meta.recovery).toBe('user_only');
		expect(lockPreservedOrErrored(meta)).toBe(true);
		// Critic round-1 finding 3: valid NON-lock user settings must survive the
		// lock-preservation overlay byte-identically.
		expect((meta.config as { max_iterations?: number }).max_iterations).toBe(9);
	});

	test('(b) invalid project + user config with a strippable strict-section typo: the step-7 STRIPPED-RETRY return must not silently unlock', () => {
		writeProject(JSON.stringify({ full_auto: { locked: true, mode: 123 } }));
		// A nested unrecognized key inside a strict section defeats the FIRST
		// user parse, then stripUnrecognizedKeys recovers it — reaching the
		// second user_only return (loader.ts :940), not the first (:918).
		writeUser(
			JSON.stringify({ checkpoint: { enabled: true, totallyBogusKey: 1 } }),
		);

		const meta = loadPluginConfigWithMeta(projectDir());
		expect(meta.recovery).toBe('user_only');
		expect(meta.removedKeys).toContain('checkpoint.totallyBogusKey');
		expect(lockPreservedOrErrored(meta)).toBe(true);
	});

	test('(c) schema-invalid user lock + guardrails-disabled project: guardrails_defaults recovery must not silently unlock', () => {
		writeUser(JSON.stringify({ full_auto: { locked: true, mode: 123 } }));
		writeProject(JSON.stringify({ guardrails: { enabled: false } }));

		const meta = loadPluginConfigWithMeta(projectDir());
		expect(meta.recovery).toBe('guardrails_defaults');
		expect(lockPreservedOrErrored(meta)).toBe(true);
	});

	test('(d) read-level error arm: unreadable project JSON + locked user config stays fail-secure (control — green before and after the fix)', () => {
		writeProject('{ not json');
		writeUser(JSON.stringify({ full_auto: { locked: true } }));

		const meta = loadPluginConfigWithMeta(projectDir());
		// Read-level failures are classified (configHadErrors) AND the step-5
		// fail-secure closure keeps the merged lock: neither property may
		// regress under the #3105 fix.
		expect(meta.configHadErrors).toBe(true);
		expect(meta.recovery).toBe('guardrails_defaults');
		expect(lockPreservedOrErrored(meta)).toBe(true);
	});

	test('(e) control: valid configs with a lock parse on the happy path with the lock intact', () => {
		writeProject(JSON.stringify({ full_auto: { locked: true } }));
		writeUser(JSON.stringify({}));

		const meta = loadPluginConfigWithMeta(projectDir());
		expect(meta.recovery).toBe('none');
		expect(meta.configHadErrors).toBe(false);
		expect(
			(meta.config as { full_auto?: { locked?: boolean } }).full_auto?.locked,
		).toBe(true);
	});

	test('(f) control (critic round-1 finding 3): step-6 stripped_keys return keeps the merged lock', () => {
		// The merged config fails its first parse on an unrecognized strict
		// nested key; targeted stripping recovers it — the step-6 return. The
		// mergedRaw already carried the OR-merged lock, so this is green before
		// AND after the fix.
		writeProject(
			JSON.stringify({
				full_auto: { locked: true },
				checkpoint: { enabled: true, totallyBogusKey: 1 },
			}),
		);
		writeUser(JSON.stringify({}));

		const meta = loadPluginConfigWithMeta(projectDir());
		expect(meta.recovery).toBe('stripped_keys');
		expect(
			(meta.config as { full_auto?: { locked?: boolean } }).full_auto?.locked,
		).toBe(true);
		expect(lockPreservedOrErrored(meta)).toBe(true);
	});

	test('(g) control (critic round-1 finding 3): step-7b sanitized_values return keeps the merged lock', () => {
		// Both files carry a malformed VALUE (council.enabled "yes") so the
		// merged parse, the strip retry, and the user-only fallback all fail;
		// recursive malformed-value recovery drops the leaf — the step-7b
		// return, derived from mergedRaw (lock already OR-merged in).
		writeProject(JSON.stringify({ full_auto: { locked: true } }));
		writeUser(JSON.stringify({ council: { enabled: 'yes' } }));

		const meta = loadPluginConfigWithMeta(projectDir());
		expect(meta.recovery).toBe('sanitized_values');
		expect(
			(meta.config as { full_auto?: { locked?: boolean } }).full_auto?.locked,
		).toBe(true);
		expect(lockPreservedOrErrored(meta)).toBe(true);
	});
});
