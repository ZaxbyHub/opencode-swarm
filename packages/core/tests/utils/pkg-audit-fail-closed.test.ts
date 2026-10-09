import { afterEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	auditFailureForTest,
	runCargoAuditForTest,
} from '../../src/tools/pkg-audit';
import { BunCompatOutputLimitError } from '../../src/utils/bun-compat';

/**
 * Fail-closed regression tests for the pkg-audit cargo runner (PR #3163
 * feedback round): the swarm review reproduced a fail-open end-to-end — a
 * ~9 MB audit payload and a missing binary both reported clean:true. These
 * tests pin the repaired contract and run in the INCLUDED CI scope
 * (packages/core/tests/utils is a ci.yml test invocation), unlike the
 * 7.x-layout pkg-audit suites in the root tests/ tree (#3160).
 *
 * Contract: clean:true is reserved EXCLUSIVELY for genuinely-missing
 * tooling; overflow, unknown failures, and timeouts are clean:false, so an
 * unusable audit result can never read as "no vulnerabilities found".
 * Deterministic via the `_internals` DI seam — no real cargo, no
 * mock.module.
 */

const CMD = ['cargo', 'audit', '--json'];
const FAKE_DIR = 'packages/core/tests/fixtures/nonexistent-pkg-audit-fake';

const realSpawn = _internals.spawnAuditProc;
const realTimeoutMs = _internals.auditTimeoutMs;

type SpawnFn = typeof realSpawn;

function fakeSpawnOf(proc: unknown): SpawnFn {
	return (() => proc) as unknown as SpawnFn;
}

function procWithSpawnError(spawnError: unknown) {
	return {
		stdout: { text: async () => '' },
		stderr: { text: async () => '' },
		exited: Promise.resolve(1),
		spawnError,
		kill: () => {},
	};
}

function neverSettlingProc() {
	const never = new Promise<string>(() => {});
	return {
		stdout: { text: () => never },
		stderr: { text: () => never },
		exited: new Promise<number>(() => {}),
		spawnError: undefined,
		kill: () => {},
	};
}

const enoent = Object.assign(new Error('spawn cargo ENOENT'), {
	code: 'ENOENT',
});

afterEach(() => {
	_internals.spawnAuditProc = realSpawn;
	_internals.auditTimeoutMs = realTimeoutMs;
});

describe('pkg-audit fail-closed contract (PR #3163 feedback)', () => {
	test('classifier: overflow is clean:false, never a silent pass', () => {
		const err = new BunCompatOutputLimitError(
			5 * 1024 * 1024,
			5 * 1024 * 1024,
			9 * 1024 * 1024,
		);
		const result = auditFailureForTest('cargo', 'cargo audit', CMD, err);
		expect(result.clean).toBe(false);
		expect(result.note).toContain('capture budget');
		expect(result.totalCount).toBe(0);
	});

	test('classifier: unknown failure is clean:false', () => {
		const result = auditFailureForTest(
			'cargo',
			'cargo audit',
			CMD,
			new Error('unexpected boom'),
		);
		expect(result.clean).toBe(false);
		expect(result.note).toContain('unexpected boom');
	});

	test('classifier: genuinely-missing tooling stays clean:true (designed arm)', () => {
		const result = auditFailureForTest('cargo', 'cargo audit', CMD, enoent);
		expect(result.clean).toBe(true);
		expect(result.note).toContain('not available');
	});

	test('runner: spawnError routes through the classifier, not empty-findings-clean', async () => {
		// The bun-compat shim never throws — a failed spawn is the spawnError
		// VALUE. The runner must check it before the exitCode===0 shortcut.
		_internals.spawnAuditProc = fakeSpawnOf(procWithSpawnError(enoent));
		const result = await runCargoAuditForTest(FAKE_DIR);
		expect(result.clean).toBe(true); // designed not-installed arm…
		expect(result.note).toContain('not available'); // …with its note
	});

	test('runner: non-missing spawn failure is clean:false', async () => {
		_internals.spawnAuditProc = fakeSpawnOf(
			procWithSpawnError(new Error('spawn failed weirdly')),
		);
		const result = await runCargoAuditForTest(FAKE_DIR);
		expect(result.clean).toBe(false);
		expect(result.note).toContain('spawn failed weirdly');
	});

	test('runner: timeout is clean:false', async () => {
		_internals.spawnAuditProc = fakeSpawnOf(neverSettlingProc());
		_internals.auditTimeoutMs = 50;
		const result = await runCargoAuditForTest(FAKE_DIR);
		expect(result.clean).toBe(false);
		expect(result.note).toContain('timed out');
	});
});
