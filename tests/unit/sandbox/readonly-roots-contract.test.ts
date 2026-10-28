/**
 * `readonly_roots` is a Linux-Bubblewrap-only, per-call policy field. Two
 * contracts keep it from leaking anywhere else:
 *
 * - O-003: it is derived per call from the session workspace and must NOT take
 *   part in the enforcement assessment (policy object or cache key), otherwise
 *   every workspace would fragment the assessment cache.
 * - O-005: executors whose containment is not Bubblewrap (macOS sandbox-exec,
 *   the Windows PowerShell wrapper) ignore it, so their wrapped command is
 *   identical with and without it.
 *
 * Not pinned: NativeWindowsSandboxExecutor. Its strong path needs a real
 * runner binary (the constructor probes and may spawn it) and its weak path
 * delegates to the PowerShell wrapper pinned below.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	_resetSandboxAssessmentCache,
	assessSandboxEnforcement,
	_internals as executorInternals,
	type SandboxPolicyOptions,
} from '../../../src/sandbox/executor';
import {
	MacOSSandboxExecutor,
	_internals as macInternals,
} from '../../../src/sandbox/macos/sandbox-exec-executor';
import {
	WindowsSandboxExecutor,
	_internals as winInternals,
} from '../../../src/sandbox/win32/restricted-environment-executor';

const ROOT = path.resolve('readonly-root-sentinel-dir');
const WITH_ROOTS: SandboxPolicyOptions = {
	network_mode: 'off',
	readonly_roots: [ROOT],
};
const WITHOUT_ROOTS: SandboxPolicyOptions = { network_mode: 'off' };

const originalPlatform = process.platform;
const originalDetect = executorInternals.detectSandboxCapability;
const originalMacProbe = macInternals.probeSandboxExec;
const originalWinProbe = winInternals.probeWindowsSandbox;

beforeEach(() => {
	_resetSandboxAssessmentCache();
	macInternals.resetProbeMemo();
});

afterEach(() => {
	Object.defineProperty(process, 'platform', {
		value: originalPlatform,
		configurable: true,
	});
	executorInternals.detectSandboxCapability = originalDetect;
	macInternals.probeSandboxExec = originalMacProbe;
	macInternals.resetProbeMemo();
	(
		winInternals as { probeWindowsSandbox: typeof originalWinProbe }
	).probeWindowsSandbox = originalWinProbe;
	_resetSandboxAssessmentCache();
});

describe('O-003: readonly_roots is not part of the enforcement assessment', () => {
	test('cache key and policy are identical with and without readonly_roots', async () => {
		executorInternals.detectSandboxCapability = async () =>
			({
				v: 1,
				status: 'enabled',
				strength: 'strong',
				mechanism: 'Bubblewrap',
				platform: 'linux',
				filesystem: 'enforced',
				network: 'enforced',
				process: 'enforced',
				effective: 'enforced',
				reasons: [],
				identity: 'linux:bubblewrap:contract',
			}) as Awaited<ReturnType<typeof originalDetect>>;
		const base = { mode: 'required' as const, require_filesystem: true };
		const plain = await assessSandboxEnforcement(base);
		// Drop the memoized assessment so the second call is evaluated for real:
		// the same key would otherwise return the first call's cached result and
		// the smuggled-field assertions below could never observe a leak.
		_resetSandboxAssessmentCache();
		// A caller smuggling readonly_roots into the requirements must not move
		// the key: the assessment only reads the declared requirement fields.
		const smuggled = await assessSandboxEnforcement({
			...base,
			readonly_roots: [ROOT],
		} as typeof base);
		expect(smuggled.cacheKey).toBe(plain.cacheKey);
		expect(plain.cacheKey).not.toContain(ROOT);
		expect(Object.keys(plain.policy)).not.toContain('readonly_roots');
		expect(Object.keys(smuggled.policy)).not.toContain('readonly_roots');
		expect(Object.keys(smuggled.requirements)).not.toContain('readonly_roots');
	});
});

describe('O-005: non-Linux executors ignore readonly_roots', () => {
	test('macOS sandbox-exec wrap and profile are identical with and without it', () => {
		Object.defineProperty(process, 'platform', {
			value: 'darwin',
			configurable: true,
		});
		macInternals.probeSandboxExec = () => true;
		macInternals.resetProbeMemo();
		const executor = new MacOSSandboxExecutor([]);
		const scope = [path.resolve('scope-dir')];
		// The profile is passed inline (-p), so the wrapped command string IS the
		// command plus the profile: equality of the two strings covers both.
		const wrap = (policy: SandboxPolicyOptions) =>
			executor.wrapCommand('ls', scope, undefined, undefined, policy);
		const withRoots = wrap(WITH_ROOTS);
		const withoutRoots = wrap(WITHOUT_ROOTS);
		expect(withRoots).toContain("sandbox-exec -p '");
		expect(withRoots).toBe(withoutRoots);
		expect(withRoots).not.toContain(ROOT);
	});

	test('Windows PowerShell wrapper output is identical with and without it', () => {
		(
			winInternals as { probeWindowsSandbox: () => boolean }
		).probeWindowsSandbox = () => true;
		const executor = new WindowsSandboxExecutor([]);
		const wrap = (policy: SandboxPolicyOptions) =>
			(
				executor.wrapCommand as (
					c: string,
					s: string[],
					t?: string,
					e?: Record<string, string | null>,
					p?: SandboxPolicyOptions,
				) => string
			).call(executor, 'echo hello', [], undefined, undefined, policy);
		const withRoots = wrap(WITH_ROOTS);
		const withoutRoots = wrap(WITHOUT_ROOTS);
		expect(withRoots).toBe(withoutRoots);
		expect(withRoots).not.toContain(ROOT);
	});
});
