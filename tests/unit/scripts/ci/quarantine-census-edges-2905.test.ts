/**
 * Census edge-case tests (issue #2905, swarm-pr-review pr3067-20261004
 * findings PRR-006/007/008/011/028/029/030): the expiringSoon window edges,
 * the trend git argv shape, cross-ledger duplicate-path renewal semantics,
 * and the census CLI's own contract (--json, usage exit 2, violation exit 1,
 * soft-warn exit 0). All clocks are Date.UTC literals.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildQuarantineCensus,
	_internals as censusInternals,
	checkQuarantineRenewal,
	collectAddRetireTrend,
	DEFAULT_QUARANTINE_LEDGERS,
	type QuarantineLedgerContent,
} from '../../../../scripts/ci/quarantine-census';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const NOW = new Date(Date.UTC(2026, 9, 3)); // 2026-10-03 UTC

function censusWithExpiries(expiries: string[]) {
	const contents: QuarantineLedgerContent[] = DEFAULT_QUARANTINE_LEDGERS.map(
		(ledger, index) => ({
			ledger,
			content:
				index === 0
					? expiries
							.map(
								(expiry, i) =>
									`# fixture ${i}\n# OWNER: @a — #2973\n# EXPIRY: ${expiry} — x\ntests/unit/edge-${i}.test.ts`,
							)
							.join('\n')
					: '# empty\n',
		}),
	);
	return buildQuarantineCensus(contents, NOW);
}

describe('expiringSoon window edges (PRR-028)', () => {
	test('expires today (0 days) is included', () => {
		expect(censusWithExpiries(['2026-10-03']).expiringSoon).toHaveLength(1);
	});

	test('exactly 21 days out is included, 22 days out is not', () => {
		expect(censusWithExpiries(['2026-10-24']).expiringSoon).toHaveLength(1);
		expect(censusWithExpiries(['2026-10-25']).expiringSoon).toHaveLength(0);
	});
});

describe('trend git argv shape (PRR-029)', () => {
	test('collectAddRetireTrend asks git for a 30-day, capped, pathspec-scoped log', async () => {
		const originalRunGit = censusInternals.runGit;
		const calls: string[][] = [];
		censusInternals.runGit = (async (args: string[]) => {
			calls.push(args);
			return { exitCode: 0, stdout: '', stderr: '' };
		}) as typeof censusInternals.runGit;
		try {
			const trend = await collectAddRetireTrend('whatever-root', NOW);
			expect(trend).toEqual({ available: true, added: 0, retired: 0 });
			expect(calls).toHaveLength(1);
			const argv = calls[0];
			expect(argv[0]).toBe('log');
			// NOW minus 30 days, date-only ISO.
			expect(argv[1]).toBe('--since=2026-09-03');
			expect(argv).toContain('--max-count=200');
			expect(argv).toContain('-p');
			expect(argv).toContain('--unified=0');
			const separatorAt = argv.indexOf('--');
			expect(separatorAt).toBeGreaterThan(0);
			expect(argv.slice(separatorAt + 1)).toEqual([
				...DEFAULT_QUARANTINE_LEDGERS,
			]);
		} finally {
			censusInternals.runGit = originalRunGit;
		}
	});
});

describe('cross-ledger duplicate-path renewal (PRR-006)', () => {
	const path_line = 'tests/unit/dup.test.ts';

	function contents(
		aHead: string,
		bHead: string,
		aBase: string,
		bBase: string,
	): { head: QuarantineLedgerContent[]; base: QuarantineLedgerContent[] } {
		const ledgerA = DEFAULT_QUARANTINE_LEDGERS[0];
		const ledgerB = DEFAULT_QUARANTINE_LEDGERS[1];
		const make = (ledger: string, body: string): QuarantineLedgerContent => ({
			ledger,
			content: body,
		});
		return {
			head: [make(ledgerA, aHead), make(ledgerB, bHead)],
			base: [make(ledgerA, aBase), make(ledgerB, bBase)],
		};
	}

	test('a renewed duplicate is not shadowed by a same-path entry in another ledger', () => {
		const renewedNoRef = [
			'# fixture',
			'# OWNER: @a — no ref',
			'# EXPIRY: 2099-01-20 — renewed',
			path_line,
		].join('\n');
		const sameAsBase = [
			'# fixture',
			'# OWNER: @b — #9',
			'# EXPIRY: 2099-01-01 — unchanged',
			path_line,
		].join('\n');
		const baseBody = [
			'# fixture',
			'# OWNER: @a — #9',
			'# EXPIRY: 2099-01-01 — base',
			path_line,
		].join('\n');
		const { head, base } = contents(
			renewedNoRef,
			sameAsBase,
			baseBody,
			baseBody,
		);
		const result = checkQuarantineRenewal({
			headLedgerContents: head,
			baseLedgerContents: base,
			enforce: true,
		});
		expect(result.violations).toBe(1);
		expect(result.messages.join('\n')).toContain(path_line);
	});

	test('renewal anchored to an issue ref still passes with duplicates present', () => {
		const renewedWithRef = [
			'# fixture',
			'# OWNER: @a — #2973',
			'# EXPIRY: 2099-01-20 — renewed',
			path_line,
		].join('\n');
		const sameAsBase = [
			'# fixture',
			'# OWNER: @b — #9',
			'# EXPIRY: 2099-01-01 — unchanged',
			path_line,
		].join('\n');
		const baseBody = [
			'# fixture',
			'# OWNER: @a — #9',
			'# EXPIRY: 2099-01-01 — base',
			path_line,
		].join('\n');
		const { head, base } = contents(
			renewedWithRef,
			sameAsBase,
			baseBody,
			baseBody,
		);
		const result = checkQuarantineRenewal({
			headLedgerContents: head,
			baseLedgerContents: base,
			enforce: true,
		});
		expect(result.violations).toBe(0);
	});

	test('non-renewed duplicate in either order does not violate', () => {
		const body = [
			'# fixture',
			'# OWNER: @a — #9',
			'# EXPIRY: 2099-01-01 — same',
			path_line,
		].join('\n');
		const { head, base } = contents(body, body, body, body);
		const result = checkQuarantineRenewal({
			headLedgerContents: head,
			baseLedgerContents: base,
			enforce: true,
		});
		expect(result.violations).toBe(0);
	});
});

describe('census CLI contract (PRR-011/030)', () => {
	const SCRIPT = path.resolve(
		import.meta.dir,
		'../../../../scripts/ci/quarantine-census.ts',
	);

	function writeLedgers(root: string, expiry: string, withRef: boolean): void {
		fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
		const owner = withRef ? '# OWNER: @a — #2973' : '# OWNER: @a — no ref';
		for (const ledger of DEFAULT_QUARANTINE_LEDGERS) {
			fs.writeFileSync(
				path.join(root, ...ledger.split('/')),
				ledger === DEFAULT_QUARANTINE_LEDGERS[0]
					? [
							'# fixture',
							owner,
							`# EXPIRY: ${expiry} — x`,
							'tests/unit/cli.test.ts',
						].join('\n')
					: '# empty\n',
			);
		}
	}

	test('--json prints a parseable census envelope', () => {
		const root = canonicalMkdtemp('q-census-cli-');
		try {
			writeLedgers(root, '2099-01-01', true);
			const result = spawnSync(
				process.execPath,
				[SCRIPT, '--root', root, '--now', '2026-10-03', '--json'],
				{ encoding: 'utf8', timeout: 60_000 },
			);
			expect(result.status).toBe(0);
			const parsed = JSON.parse(result.stdout) as {
				census: { totalActive: number };
				trend: { available: boolean; reason?: string };
				renewal: null;
			};
			expect(parsed.census.totalActive).toBe(1);
			// The tmp fixture is not a git repo, so the trend leg fail-opens —
			// pinning that the --json envelope carries the unavailable form.
			expect(parsed.trend.available).toBe(false);
			expect(parsed.trend.reason).toContain('git log');
			expect(parsed.renewal).toBeNull();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);

	test('--check-renewal without --baseline-root is a usage error (exit 2)', () => {
		const root = canonicalMkdtemp('q-census-cli-');
		try {
			writeLedgers(root, '2099-01-01', true);
			const result = spawnSync(
				process.execPath,
				[SCRIPT, '--root', root, '--now', '2026-10-03', '--check-renewal'],
				{ encoding: 'utf8', timeout: 60_000 },
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain(
				'--check-renewal requires --baseline-root',
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);

	test('unlinked renewal vs a baseline dir: exit 1 enforced, exit 0 soft-warn', () => {
		const head = canonicalMkdtemp('q-census-cli-head-');
		const base = canonicalMkdtemp('q-census-cli-base-');
		try {
			writeLedgers(head, '2099-01-20', false);
			writeLedgers(base, '2099-01-01', true);
			const enforced = spawnSync(
				process.execPath,
				[
					SCRIPT,
					'--root',
					head,
					'--baseline-root',
					base,
					'--now',
					'2026-10-03',
					'--check-renewal',
				],
				{ encoding: 'utf8', timeout: 60_000 },
			);
			expect(enforced.status).toBe(1);
			expect(enforced.stdout).toContain('renewed EXPIRY 2099-01-20');
			expect(enforced.stderr).toContain('1 quarantine renewal violation');

			const soft = spawnSync(
				process.execPath,
				[
					SCRIPT,
					'--root',
					head,
					'--baseline-root',
					base,
					'--now',
					'2026-10-03',
					'--check-renewal',
				],
				{
					encoding: 'utf8',
					timeout: 60_000,
					env: { ...process.env, QUARANTINE_RENEWAL_ENFORCE: '0' },
				},
			);
			expect(soft.status).toBe(0);
			expect(soft.stdout).toContain('WARNING:');
		} finally {
			fs.rmSync(head, { recursive: true, force: true });
			fs.rmSync(base, { recursive: true, force: true });
		}
	}, 120_000);

	test('invalid --now is a usage error (exit 2)', () => {
		const root = canonicalMkdtemp('q-census-cli-');
		try {
			writeLedgers(root, '2099-01-01', true);
			const result = spawnSync(
				process.execPath,
				[SCRIPT, '--root', root, '--now', 'not-a-date'],
				{ encoding: 'utf8', timeout: 60_000 },
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('invalid --now');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);
});
