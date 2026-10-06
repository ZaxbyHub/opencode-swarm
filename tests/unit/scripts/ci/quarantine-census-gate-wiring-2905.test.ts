/**
 * Gate wiring tests (issue #2905, reviewer R2 / mutation M5 kill): the
 * renewal-requires-issue policy must actually run through check-invariants
 * main() — computeQuarantineRenewalFromBaseline against the fixture's own
 * `main` branch, results threaded into checkQuarantineMetadata. Dropping the
 * extras wiring (M5) leaves every unit-level Check 7 call green, so this file
 * drives the REAL main() entry over a git fixture and asserts the ERROR line
 * and the gate exit code. Fixture EXPIRYs are far-future literals: the
 * renewal comparison never reads a clock, and Check 7's real-clock per-entry
 * math cannot interfere at any wall-clock date (review PRR-002 time-bomb).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	computeQuarantineRenewalFromBaseline,
	main,
} from '../../../../scripts/check-invariants';
import { DEFAULT_QUARANTINE_LEDGERS } from '../../../../scripts/ci/quarantine-census';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

describe('gate wiring: main() drives the renewal gate (reviewer M5 kill)', () => {
	function gitFixture(): string {
		const dir = canonicalMkdtemp('q-census-gatewiring-');
		fs.mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
		for (const name of DEFAULT_QUARANTINE_LEDGERS) {
			fs.writeFileSync(
				path.join(dir, ...name.split('/')),
				'# fixture ledger\n',
			);
		}
		const repoRoot = path.resolve(import.meta.dir, '../../../..');
		for (const [src, rel] of [
			['scripts/mock-allowlist.txt', 'scripts/mock-allowlist.txt'],
			[
				'scripts/lib/normalize-mock-target.sh',
				'scripts/lib/normalize-mock-target.sh',
			],
			[
				'scripts/check-no-raw-advisory-push.sh',
				'scripts/check-no-raw-advisory-push.sh',
			],
		] as const) {
			fs.copyFileSync(path.join(repoRoot, src), path.join(dir, rel));
		}
		const git = (args: string[]) =>
			spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000 });
		git(['init', '-b', 'main']);
		git(['config', 'user.email', 't@example.com']);
		git(['config', 'user.name', 'T']);
		// Base: entry with an OWNER issue ref, EXPIRY 2026-10-08.
		fs.writeFileSync(
			path.join(dir, 'scripts', 'ci', 'quarantined-tests.txt'),
			[
				'# fixture',
				'# OWNER: @bob — #2973 anchor',
				'# EXPIRY: 2099-01-01 — original expiry',
				'tests/unit/renew.test.ts',
			].join('\n'),
		);
		git(['add', '-A']);
		git(['commit', '-m', 'base']);
		// Head: same entry renewed to a later EXPIRY, OWNER ref dropped.
		fs.writeFileSync(
			path.join(dir, 'scripts', 'ci', 'quarantined-tests.txt'),
			[
				'# fixture',
				'# OWNER: @bob — legacy owner no ref',
				'# EXPIRY: 2099-01-20 — renewed expiry',
				'tests/unit/renew.test.ts',
			].join('\n'),
		);
		return dir;
	}

	async function runMainCaptured(
		dir: string,
	): Promise<{ code: number; log: string }> {
		const originalLog = console.log;
		const originalError = console.error;
		const chunks: string[] = [];
		console.log = (...args: unknown[]) => {
			chunks.push(args.map(String).join(' '));
		};
		console.error = (...args: unknown[]) => {
			chunks.push(args.map(String).join(' '));
		};
		try {
			const code = await main(dir);
			return { code, log: chunks.join('\n') };
		} finally {
			console.log = originalLog;
			console.error = originalError;
		}
	}

	test('enforced: unlinked renewal surfaces as a Check 7 ERROR and fails the gate', async () => {
		const dir = gitFixture();
		try {
			const { code, log } = await runMainCaptured(dir);
			expect(log).toContain('renewed EXPIRY 2099-01-20');
			expect(log).toContain('tests/unit/renew.test.ts');
			expect(log).toContain('without an OWNER issue reference');
			expect(code).toBe(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);

	test('soft-warn env downgrades the same wiring to a passing gate', async () => {
		const dir = gitFixture();
		const previous = process.env.QUARANTINE_RENEWAL_ENFORCE;
		process.env.QUARANTINE_RENEWAL_ENFORCE = '0';
		try {
			const { code, log } = await runMainCaptured(dir);
			expect(log).toContain('without an OWNER issue reference');
			expect(code).toBe(0);
		} finally {
			if (previous === undefined) {
				delete process.env.QUARANTINE_RENEWAL_ENFORCE;
			} else {
				process.env.QUARANTINE_RENEWAL_ENFORCE = previous;
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});

describe('renewal fail-open contract (review PRR-022): no base, no violation', () => {
	test('repo with no resolvable base ref yields no renewal leg and no violations', async () => {
		const dir = canonicalMkdtemp('q-census-gatewiring-nobase-');
		try {
			fs.mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true });
			// Head ledgers carry an active entry, so the fast all-empty guard
			// passes and the base-ref resolution is the leg that fails open.
			fs.writeFileSync(
				path.join(dir, 'scripts', 'ci', 'quarantined-tests.txt'),
				[
					'# fixture',
					'# OWNER: @bob — legacy owner no ref',
					'# EXPIRY: 2099-01-20 — renewed expiry',
					'tests/unit/renew.test.ts',
				].join('\n'),
			);
			const renewal = await computeQuarantineRenewalFromBaseline(dir);
			expect(renewal).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test('base branch without the ledgers yields no baseline and no violations', async () => {
		const dir = canonicalMkdtemp('q-census-gatewiring-nobaseline-');
		try {
			fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};\n');
			const git = (args: string[]) =>
				spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000 });
			git(['init', '-b', 'main']);
			git(['config', 'user.email', 't@example.com']);
			git(['config', 'user.name', 'T']);
			git(['add', '-A']);
			git(['commit', '-m', 'base without ledgers']);
			// Head ledgers appear only in the working tree, uncommitted.
			fs.mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true });
			fs.writeFileSync(
				path.join(dir, 'scripts', 'ci', 'quarantined-tests.txt'),
				[
					'# fixture',
					'# OWNER: @bob — legacy owner no ref',
					'# EXPIRY: 2099-01-20 — renewed expiry',
					'tests/unit/renew.test.ts',
				].join('\n'),
			);
			const renewal = await computeQuarantineRenewalFromBaseline(dir);
			expect(renewal).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
