import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	probeSettlementSource,
} from '../../../src/worktree/settlement-source-recovery';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const MISSING_OID = 'f'.repeat(40);
const roots: string[] = [];
const realSpawn = _internals.bunSpawn;

function fixture(): string {
	const root = canonicalMkdtemp('settlement-object-db-3409-');
	roots.push(root);
	execFileSync('git', ['init', '--initial-branch=main'], {
		cwd: root,
		stdio: 'ignore',
		timeout: 10000,
	});
	return root;
}

function fakeGit(exitCode: number, stdout: string, stderr: string) {
	return {
		stdout: { text: async () => stdout },
		stderr: { text: async () => stderr },
		exited: Promise.resolve(exitCode),
		exitCode,
		kill: () => {},
	} as unknown as ReturnType<typeof realSpawn>;
}

afterEach(() => {
	_internals.bunSpawn = realSpawn;
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('settlement source absence requires a healthy object database #3409', () => {
	test('a healthy object database proves a quiet-missing source absent (control)', async () => {
		const root = fixture();
		const seen: string[][] = [];
		_internals.bunSpawn = (argv, options) => {
			seen.push([...argv]);
			return realSpawn(argv, options);
		};

		expect(await probeSettlementSource(root, MISSING_OID)).toBe('absent');
		// The health probe must really run: absence is never inferred from the
		// quiet revision exit status alone.
		expect(seen.some((argv) => argv.includes('count-objects'))).toBe(true);
	});

	test.each([
		['a failing', 128, '', 'fatal: unable to read object database\n'],
		['a nonzero silent', 1, '', ''],
		['a stderr-reporting successful', 0, 'count: 0\n', 'error: bad object\n'],
	] as const)('%s count-objects health probe makes absence uncertain', async (_label, exitCode, stdout, stderr) => {
		const root = fixture();
		_internals.bunSpawn = (argv, options) => {
			if (argv.includes('count-objects'))
				return fakeGit(exitCode, stdout, stderr);
			return realSpawn(argv, options);
		};

		const failure = await probeSettlementSource(root, MISSING_OID).then(
			() => undefined,
			(error: unknown) => error as Error,
		);

		expect(failure).toBeInstanceOf(Error);
		// The unreadable branch must be distinguishable from the unavailable
		// (unusable object directory) and generic probe-failure branches.
		expect(failure?.message).toBe(
			`CODER_SETTLEMENT_SOURCE_UNCERTAIN: object database unreadable for ${MISSING_OID}`,
		);
		expect(fs.existsSync(path.join(root, '.git'))).toBe(true);
	});
});
