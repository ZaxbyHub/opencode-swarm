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
import * as path from 'node:path';
import {
	_resetCapabilityCache,
	_internals as probeInternals,
	SandboxCapabilityProbe,
} from '../../../src/sandbox/capability-probe';
import { _internals as bwrapInternals } from '../../../src/sandbox/linux/bubblewrap-executor';
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
