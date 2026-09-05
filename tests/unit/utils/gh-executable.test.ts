import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	__seedGhExecutableForTests,
	_internals,
	describeGhResolution,
	GH_BINARY_ENV_VAR,
	GH_VERSION_PATTERN,
	resetGhExecutableCache,
	resolveGhExecutable,
} from '../../../src/utils/gh-executable';

/**
 * Issue #2476 AC1 (source issue #2262): the gh resolver must match the git
 * resolver's contract — absolute-candidate-first ordering, absoluteness
 * requirement, `gh --version` probe, bounded budget, caching, bare-'gh'
 * terminal fallback, never throws.
 */
describe('gh resolver parity (#2476 AC1)', () => {
	const realInternals = { ..._internals };
	const probes: Array<{ cmd: string; args: string[] }> = [];
	let scratch = '';
	const winSep = String.fromCharCode(92);

	beforeEach(() => {
		probes.length = 0;
		resetGhExecutableCache();
		scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ghres-')));
		_internals.env = () => ({ PATH: '' }) as NodeJS.ProcessEnv;
		_internals.now = () => 0;
		_internals.spawnSync = ((cmd: string, args: string[]) => {
			probes.push({ cmd, args });
			return {
				status: 0,
				stdout: Buffer.from('gh version 2.74.0 (2025-01-01)\n'),
				stderr: Buffer.from(''),
				pid: 1,
				output: [],
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;
	});

	afterEach(() => {
		Object.assign(_internals, realInternals);
		fs.rmSync(scratch, { recursive: true, force: true });
	});

	// Host-native absolute paths on purpose: the resolver builds candidates
	// with path.join and gates on path.win32.isAbsolute, which accepts both
	// "/abs/..." and "C:\..." shapes — so planting AND expecting the SAME
	// native string is deterministic on every CI host (a hand-converted
	// backslash form desynchronizes from the planted file on POSIX hosts).
	function writeCandidate(rel: string): string {
		const dir = path.join(scratch, path.dirname(rel));
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(scratch, rel);
		fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
		return file;
	}

	test('win32: platform absolutes are probed BEFORE any PATH match (the #2262 ordering)', () => {
		const platformAbs = writeCandidate('ProgramFiles/GitHub CLI/gh.exe');
		const hostilePathHit = writeCandidate('hostile/gh.exe');
		const hostileDir = path.dirname(hostilePathHit);
		_internals.platform = () => 'win32';
		_internals.env = () =>
			({
				PATH: hostileDir,
				ProgramFiles: path.join(scratch, 'ProgramFiles'),
			}) as NodeJS.ProcessEnv;

		expect(resolveGhExecutable()).toBe(platformAbs);
		// The hostile PATH entry was probed (or skipped) only AFTER the
		// platform absolute was accepted — ordering is the assertion.
		expect(probes[0]?.cmd).toBe(platformAbs);
		expect(probes[0]?.cmd).not.toBe(hostilePathHit);
	});

	test('a hostile plain-text gh file is rejected by the version pattern gate', () => {
		const fake = writeCandidate('fake/gh.exe');
		_internals.platform = () => 'win32';
		// Env override vector on purpose: the override candidate is used
		// verbatim (no platform-separator join), so the fixture is identical
		// on every host — only the version gate can reject it.
		_internals.env = () =>
			({
				[GH_BINARY_ENV_VAR]: fake,
			}) as unknown as NodeJS.ProcessEnv;
		// Exit 0 but prints non-gh output — pre-fix this was ACCEPTED (R2).
		_internals.spawnSync = ((cmd: string) => {
			probes.push({ cmd, args: [] });
			return {
				status: 0,
				stdout: Buffer.from('not really gh'),
				stderr: Buffer.from(''),
				pid: 1,
				output: [],
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		expect(resolveGhExecutable()).toBe('gh'); // bare fallback
		const desc = describeGhResolution();
		expect(desc.resolved).toBe(false);
		expect(desc.attempts.some((a) => a.candidate === fake && !a.accepted)).toBe(
			true,
		);
	});

	test('relative candidates are rejected as "not an absolute path"', () => {
		_internals.platform = () => 'win32';
		_internals.env = () =>
			({
				PATH: 'node_modules' + winSep + '.bin',
			}) as NodeJS.ProcessEnv;
		expect(resolveGhExecutable()).toBe('gh');
		expect(
			describeGhResolution().attempts.some(
				(a) => a.reason === 'not an absolute path',
			),
		).toBe(true);
	});

	test('darwin and linux have absolute platform candidates (pre-fix gap)', () => {
		for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
			resetGhExecutableCache();
			_internals.platform = () => platform;
			_internals.env = () => ({ PATH: '' }) as NodeJS.ProcessEnv;
			resolveGhExecutable();
			const sources = describeGhResolution().attempts.map((a) => a.source);
			expect(sources).toContain('platform');
		}
	});

	test('env override wins and is probed first', () => {
		const override = writeCandidate('custom/gh.exe');
		_internals.platform = () => 'win32';
		_internals.env = () =>
			({
				[GH_BINARY_ENV_VAR]: override,
			}) as unknown as NodeJS.ProcessEnv;
		expect(resolveGhExecutable()).toBe(override);
		expect(probes[0]?.cmd).toBe(override);
	});

	test('budget exhaustion returns the bare fallback without probing everything', () => {
		_internals.platform = () => 'linux';
		const manyDirs = Array.from({ length: 30 }, (_, i) => `/opt/d${i}`);
		_internals.env = () =>
			({
				PATH: manyDirs.join(':'),
			}) as NodeJS.ProcessEnv;
		let clock = 0;
		_internals.now = () => {
			clock += 600; // every probe eats 600ms of the 1000ms budget
			return clock;
		};
		_internals.spawnSync = ((cmd: string) => {
			probes.push({ cmd, args: [] });
			return {
				status: 1,
				stdout: Buffer.from(''),
				stderr: Buffer.from('nope'),
				pid: 1,
				output: [],
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;

		expect(resolveGhExecutable()).toBe('gh');
		// 30 PATH entries exist; the budget must stop the walk early.
		expect(probes.length).toBeLessThan(30);
	});

	test('success is cached; fallback is cached with a TTL that expires', () => {
		// A planted env-override candidate that EXISTS but fails the version
		// gate makes every step deterministic on any host — no reliance on
		// which real platform absolutes a runner happens to have installed.
		const rejectAbs = writeCandidate('reject/gh.exe');
		_internals.platform = () => 'win32';
		_internals.spawnSync = ((cmd: string) => {
			probes.push({ cmd, args: [] });
			return {
				status: 0,
				stdout: Buffer.from(''), // gh --version printed nothing -> reject
				stderr: Buffer.from(''),
				pid: 1,
				output: [],
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;
		let clock = 0;
		_internals.now = () => clock;
		_internals.env = () =>
			({ [GH_BINARY_ENV_VAR]: rejectAbs }) as unknown as NodeJS.ProcessEnv;
		expect(resolveGhExecutable()).toBe('gh');
		const first = probes.length;
		expect(first).toBe(1); // the override candidate was probed once
		expect(resolveGhExecutable()).toBe('gh');
		expect(probes.length).toBe(first); // negative cache — no re-probe

		clock = 61_000; // TTL expired
		resolveGhExecutable();
		expect(probes.length).toBe(first + 1); // override re-probed after TTL

		// A validated candidate is cached for the process lifetime.
		const goodAbs = writeCandidate('good/gh.exe');
		_internals.platform = () => 'win32';
		_internals.spawnSync = ((cmd: string) => {
			probes.push({ cmd, args: [] });
			return {
				status: 0,
				stdout: Buffer.from('gh version 2.74.0\n'),
				stderr: Buffer.from(''),
				pid: 1,
				output: [],
				error: undefined,
			} as ReturnType<typeof _internals.spawnSync>;
		}) as typeof _internals.spawnSync;
		_internals.env = () =>
			({
				[GH_BINARY_ENV_VAR]: goodAbs,
			}) as unknown as NodeJS.ProcessEnv;
		resetGhExecutableCache();
		expect(resolveGhExecutable()).toBe(goodAbs);
		const after = probes.length;
		expect(resolveGhExecutable()).toBe(goodAbs);
		expect(probes.length).toBe(after); // cached — no re-probe
	});

	test('never throws when spawn throws', () => {
		_internals.platform = () => 'linux';
		_internals.spawnSync = (() => {
			throw new Error('boom');
		}) as typeof _internals.spawnSync;
		expect(resolveGhExecutable()).toBe('gh');
	});

	test('GH_VERSION_PATTERN anchors to gh version output only', () => {
		expect(GH_VERSION_PATTERN.test('gh version 2.74.0 (2025-01-01)')).toBe(
			true,
		);
		expect(GH_VERSION_PATTERN.test('not really gh')).toBe(false);
		expect(GH_VERSION_PATTERN.test('git version 2.43.0')).toBe(false);
	});

	test('__seedGhExecutableForTests pre-seeds the cache (zero probes)', () => {
		__seedGhExecutableForTests('/seeded/gh');
		const before = probes.length;
		expect(resolveGhExecutable()).toBe('/seeded/gh');
		expect(probes.length).toBe(before);
		resetGhExecutableCache();
	});
});
