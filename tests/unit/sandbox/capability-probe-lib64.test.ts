/**
 * #3332 regression: the Linux capability probe's bwrap args consult
 * fs.existsSync('/lib64') PER PROBE RUN (arg-construction time inside
 * probeLinuxBehavior), so the same process can observe both host shapes.
 *
 * Drives the exported _internals.detectBehavioralEvidence seam directly with
 * a spawnSync recorder (the real probe binary never runs); mkdtemp/mkdir/rm
 * are stubbed so no real temp root is created.
 *
 * RED at base (the bind was unconditional), GREEN after the fix.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import * as realFs from 'node:fs';

// Bun hot-swaps the captured namespace too — capture originals first.
const realMkdirSync = realFs.mkdirSync;
const realExistsSync = realFs.existsSync;
void realMkdirSync;
void realExistsSync;

/** Mutable host shape under test: does this fake host have /lib64? */
let hostHasLib64 = false;

const recordedArgvs: string[][] = [];

mock.module('node:fs', () => ({
	...realFs,
	existsSync: (probePath: string) =>
		probePath === '/lib64' ? hostHasLib64 : false,
	mkdtempSync: (prefix: string) => `${prefix}probe-lib64-test`,
	mkdirSync: () => undefined,
	rmSync: () => undefined,
	readlinkSync: () => {
		throw new Error('probe-lib64-test: no /proc on this fake host');
	},
}));

const { _internals } = await import('../../../src/sandbox/capability-probe.js');

const linuxCapability = {
	status: 'enabled',
	strength: 'advisory',
	mechanism: 'Bubblewrap',
	platform: 'linux',
} as const;

function recordSpawn(): typeof _internals.spawnSync {
	const stub = ((_cmd: string, args: string[]) => {
		recordedArgvs.push(args);
		return {
			status: 0,
			stdout: 'fake-ns:net:[4000000000]',
			stderr: '',
		} satisfies Partial<SpawnSyncReturns<string>> as SpawnSyncReturns<string>;
	}) as unknown as typeof _internals.spawnSync;
	return stub;
}

afterEach(() => {
	mock.restore();
	recordedArgvs.length = 0;
});

describe('capability probe /lib64 bind is host-conditional (per call)', () => {
	test('omits the /lib64 bind when the host has no /lib64', () => {
		hostHasLib64 = false;
		const original = _internals.spawnSync;
		_internals.spawnSync = recordSpawn();
		try {
			const result = _internals.detectBehavioralEvidence(linuxCapability);
			expect(recordedArgvs.length).toBeGreaterThan(0);
			for (const argv of recordedArgvs) {
				expect(argv).not.toContain('/lib64');
			}
			expect(result.filesystem).toBeDefined();
		} finally {
			_internals.spawnSync = original;
		}
	}, 60_000);

	test('includes the /lib64 bind when the host has /lib64', () => {
		hostHasLib64 = true;
		const original = _internals.spawnSync;
		_internals.spawnSync = recordSpawn();
		try {
			_internals.detectBehavioralEvidence(linuxCapability);
			expect(recordedArgvs.length).toBeGreaterThan(0);
			// Every recorded spawn carries the conditional bind on this host.
			for (const argv of recordedArgvs) {
				expect(argv).toContain('/lib64');
			}
		} finally {
			_internals.spawnSync = original;
		}
	}, 60_000);
});
