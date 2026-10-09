/**
 * bwrap availability is proven by creating a sandbox, not by `--version`.
 *
 * Ubuntu 24.04+ restricts unprivileged user namespaces
 * (`kernel.apparmor_restrict_unprivileged_userns=1`): `bwrap --version`
 * succeeds, but every real invocation fails with "setting up uid map:
 * Permission denied". Both probes reported a strong Bubblewrap sandbox there,
 * and every sandboxed command then failed. A fake bwrap reproduces that host.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_resetCapabilityCache,
	_internals as probeInternals,
	SandboxCapabilityProbe,
} from '../../../src/sandbox/capability-probe';
import {
	BubblewrapSandboxExecutor,
	BWRAP_NAMESPACE_SMOKE_ARGS,
	_internals as bwrapInternals,
} from '../../../src/sandbox/linux/bubblewrap-executor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realBwrapInternals = { ...bwrapInternals };
const realProbeInternals = { ...probeInternals };
const originalPlatform = process.platform;
let dir: string;

function fakeBwrap(name: string, sandboxWorks: boolean): string {
	const file = path.join(dir, name);
	fs.writeFileSync(
		file,
		[
			'#!/bin/sh',
			'if [ "$1" = "--version" ]; then echo "bubblewrap 0.9.0"; exit 0; fi',
			sandboxWorks
				? 'exit 0'
				: 'echo "bwrap: setting up uid map: Permission denied" >&2; exit 1',
			'',
		].join('\n'),
	);
	fs.chmodSync(file, 0o755);
	return file;
}

beforeEach(() => {
	dir = canonicalMkdtemp('bwrap-smoke-');
	_resetCapabilityCache();
});

afterEach(() => {
	Object.assign(bwrapInternals, realBwrapInternals);
	Object.assign(probeInternals, realProbeInternals);
	Object.defineProperty(process, 'platform', {
		value: originalPlatform,
		configurable: true,
	});
	_resetCapabilityCache();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')(
	'bwrap namespace smoke test',
	() => {
		test('executor: --version works but no namespace can be created → unavailable', () => {
			const binary = fakeBwrap('bwrap-restricted', false);
			bwrapInternals.resolveBwrapBinary = () => binary;
			expect(bwrapInternals.probeBwrap()).toBe(false);
			const smoke = bwrapInternals.probeBwrapNamespace(binary);
			expect(smoke.ok).toBe(false);
			if (!smoke.ok) expect(smoke.reason).toContain('uid map');
		});

		test('executor: a working sandbox is available', () => {
			const binary = fakeBwrap('bwrap-ok', true);
			bwrapInternals.resolveBwrapBinary = () => binary;
			expect(bwrapInternals.probeBwrap()).toBe(true);
		});

		test('executor: the smoke run uses the temp directory as its cwd, never the process cwd', () => {
			const binary = path.join(dir, 'bwrap-pwd');
			fs.writeFileSync(binary, '#!/bin/sh\npwd -P >&2\nexit 1\n');
			fs.chmodSync(binary, 0o755);
			const smoke = bwrapInternals.probeBwrapNamespace(binary);
			expect(smoke.ok).toBe(false);
			if (!smoke.ok) expect(smoke.reason).toBe(fs.realpathSync(os.tmpdir()));
		});

		test('executor: a missing binary or an invalid argument is unavailable, never a throw', () => {
			const missing = bwrapInternals.probeBwrapNamespace(
				path.join(dir, 'no-such-bwrap'),
			);
			expect(missing.ok).toBe(false);
			if (!missing.ok) expect(missing.reason).toContain('ENOENT');
			// A NUL byte makes spawnSync throw synchronously (the catch arm).
			const invalid = bwrapInternals.probeBwrapNamespace('bwrap\0');
			expect(invalid.ok).toBe(false);
			if (!invalid.ok) expect(invalid.reason.length).toBeGreaterThan(0);
		});

		test('executor: a smoke run that hangs times out as unavailable', () => {
			const binary = path.join(dir, 'bwrap-hang');
			fs.writeFileSync(binary, '#!/bin/sh\nexec sleep 30\n');
			fs.chmodSync(binary, 0o755);
			const smoke = bwrapInternals.probeBwrapNamespace(binary);
			expect(smoke.ok).toBe(false);
			if (!smoke.ok) expect(smoke.reason).toContain('ETIMEDOUT');
		}, 20_000);

		test('capability probe: reports disabled with the cause, not a strong sandbox', async () => {
			Object.defineProperty(process, 'platform', {
				value: 'linux',
				configurable: true,
			});
			const binary = fakeBwrap('bwrap-restricted', false);
			bwrapInternals.resolveBwrapBinary = () => binary;
			const capability = await new SandboxCapabilityProbe().detect();
			expect(capability.status).toBe('disabled');
			expect(capability.mechanism).toBe('Bubblewrap');
			expect(capability.error).toContain('cannot create a sandbox');
			expect(capability.error).toContain('uid map');
		});

		test('capability probe: a working sandbox is still enabled', async () => {
			Object.defineProperty(process, 'platform', {
				value: 'linux',
				configurable: true,
			});
			const binary = fakeBwrap('bwrap-ok', true);
			bwrapInternals.resolveBwrapBinary = () => binary;
			probeInternals.detectBehavioralEvidence = (() => ({
				filesystem: 'strong',
				network: 'strong',
				reasons: [],
			})) as never;
			const capability = await new SandboxCapabilityProbe().detect();
			expect(capability.status).toBe('enabled');
		});
	},
);

describe('bwrap namespace smoke args match a real default-policy wrap', () => {
	// The smoke test must need every kernel feature and mount a real wrap
	// needs: with fewer (no --unshare-net, `--ro-bind / /` instead of the
	// /etc /usr /lib /lib64 binds, no sized tmpfs) it passes on hosts where
	// every real wrap then fails.
	function realDefaultWrapArgs(): string[] {
		bwrapInternals.probeBwrap = () => true;
		bwrapInternals.resolveBwrapBinary = () => 'bwrap';
		const wrapped = new BubblewrapSandboxExecutor([], '/tmp').wrapCommand(
			'true',
			[],
		);
		// Every interpolated value is a single-quoted token without spaces
		// here, so a whitespace split recovers the argv.
		return wrapped
			.split(' ')
			.slice(1)
			.map((arg) => arg.replace(/^'(.*)'$/, '$1'));
	}

	test('the smoke argv equals the real default-policy wrap argv', () => {
		expect([...BWRAP_NAMESPACE_SMOKE_ARGS]).toEqual(realDefaultWrapArgs());
	});

	test('every flag the real wrap emits appears in the smoke args', () => {
		const smoke = new Set(BWRAP_NAMESPACE_SMOKE_ARGS);
		for (const flag of realDefaultWrapArgs().filter((a) => a.startsWith('--')))
			expect(smoke.has(flag)).toBe(true);
		for (const required of ['--unshare-net', '--size', '--tmpfs', '/lib64'])
			expect(smoke.has(required)).toBe(true);
		// No whole-root bind standing in for the real system binds.
		const roBinds = BWRAP_NAMESPACE_SMOKE_ARGS.flatMap((arg, i) =>
			arg === '--ro-bind' ? [BWRAP_NAMESPACE_SMOKE_ARGS[i + 1]] : [],
		);
		expect(roBinds).toEqual(['/etc', '/usr', '/lib', '/lib64']);
	});
});
