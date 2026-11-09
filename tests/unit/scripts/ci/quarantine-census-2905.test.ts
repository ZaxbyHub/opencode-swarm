/**
 * Quarantine census unit tests (issue #2905, Workstream I8).
 *
 * Covers the census module contract frozen by the trace's acceptance checks:
 * parser parity with the pre-#2905 Check 7 grammar, census aggregates on
 * mixed-date fixture ledgers, the renewal-requires-issue policy (enforced
 * ERROR vs soft-warn WARNING, path-global identity), and the deterministic
 * trend fail-open forms. All clocks use Date.UTC — no raw clock reads
 * (check:test-clock).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkQuarantineMetadata } from '../../../../scripts/check-invariants';
import {
	buildQuarantineCensus,
	_internals as censusInternals,
	checkQuarantineRenewal,
	collectAddRetireTrend,
	DEFAULT_QUARANTINE_LEDGERS,
	formatQuarantineCensus,
	parseQuarantineLedger,
} from '../../../../scripts/ci/quarantine-census';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const NOW = new Date(Date.UTC(2026, 9, 3)); // 2026-10-03 UTC

function ledgerFixture(
	entries: { owner: string[]; expiry: string[]; entry: string }[],
): string {
	const lines: string[] = ['# fixture ledger (2905 census tests)'];
	for (const block of entries) {
		for (const ownerLine of block.owner) lines.push(ownerLine);
		for (const expiryLine of block.expiry) lines.push(expiryLine);
		lines.push(block.entry);
		lines.push('');
	}
	return `${lines.join('\n')}\n`;
}

function ledgerContents(
	mainContent: string,
	others: Record<number, string> = {},
) {
	return DEFAULT_QUARANTINE_LEDGERS.map((ledger, index) => ({
		ledger,
		content: others[index] ?? (index === 0 ? mainContent : '# empty\n'),
	}));
}

describe('parseQuarantineLedger (grammar parity)', () => {
	test('extracts OWNER/EXPIRY and issue refs from the comment block', () => {
		const content = ledgerFixture([
			{
				owner: ['# OWNER: @alice — issue #2973 renewal tracker'],
				expiry: ['# EXPIRY: 2026-11-18 — retire when fixed'],
				entry: 'tests/unit/alpha.test.ts',
			},
		]);
		const entries = parseQuarantineLedger(content, 'scripts/ci/x.txt');
		expect(entries.length).toBe(1);
		expect(entries[0]?.ownerHandle).toBe('@alice');
		expect(entries[0]?.ownerIssueRefs).toEqual(['#2973']);
		expect(entries[0]?.expiry).toBe('2026-11-18');
	});

	test('captures continuation refs; # Renewed provenance never counts', () => {
		// R3-A placement: the provenance line sits INSIDE the continuation run
		// (directly below OWNER, above EXPIRY) in the real no-colon form.
		const content = [
			'# fixture',
			'# OWNER: @alice — renewal cohort',
			'#   original flake evidence: closed #2660',
			'# EXPIRY: 2026-11-18 — retire when fixed',
			'# Renewed 2026-09-25 per issue #2900 (Workstream I3); previous EXPIRY 2026-10-15.',
			'tests/unit/alpha.test.ts',
		].join('\n');
		const entries = parseQuarantineLedger(content, 'scripts/ci/x.txt');
		expect(entries[0]?.ownerIssueRefs).toEqual(['#2660']);
		expect(entries[0]?.ownerIssueRefs).not.toContain('#2900');

		// R3-A placement: provenance directly below OWNER (the sandwich shape
		// where a keyed-colon-only stop would leak #2900 into the value).
		const sandwich = [
			'# fixture',
			'# OWNER: @alice — renewal cohort',
			'# Renewed 2026-09-25 per issue #2900; previous EXPIRY 2026-10-15.',
			'# EXPIRY: 2026-11-18 — retire when fixed',
			'tests/unit/alpha.test.ts',
		].join('\n');
		const sandwichEntries = parseQuarantineLedger(sandwich, 'x');
		expect(sandwichEntries[0]?.ownerIssueRefs).toEqual([]);
	});

	test('blank line between metadata and path disassociates the block', () => {
		const content = [
			'# fixture',
			'# OWNER: @alice — #1',
			'# EXPIRY: 2026-11-18 — x',
			'',
			'tests/unit/alpha.test.ts',
		].join('\n');
		const entries = parseQuarantineLedger(content, 'scripts/ci/x.txt');
		expect(entries[0]?.ownerRaw).toBeNull();
		expect(entries[0]?.expiry).toBeNull();
	});

	test('ownerHandle stops at whitespace or em-dash', () => {
		const entries = parseQuarantineLedger(
			[
				'# OWNER: zaxbysauce — issue #2973 (cohort)',
				'# EXPIRY: 2026-11-18 — x',
				'tests/a.test.ts',
			].join('\n'),
			'x',
		);
		expect(entries[0]?.ownerHandle).toBe('zaxbysauce');
	});
});

describe('buildQuarantineCensus + formatQuarantineCensus', () => {
	test('aggregates mixed dates, histogram ascending, unlinked owner line', () => {
		const main = ledgerFixture([
			{
				owner: ['# OWNER: @alice — issue #2973 flaky retry'],
				expiry: ['# EXPIRY: 2026-10-08 — retire when retry lands'],
				entry: 'tests/unit/alpha.test.ts',
			},
			{
				owner: ['# OWNER: @bob — legacy owner without issue ref'],
				expiry: ['# EXPIRY: 2026-11-20 — waiting on upstream fix'],
				entry: 'tests/unit/beta.test.ts',
			},
		]);
		const windows = ledgerFixture([
			{
				owner: ['# OWNER: @alice — #3001 windows-only path'],
				expiry: ['# EXPIRY: 2026-11-20 — windows runner flake'],
				entry: 'tests/unit/win.test.ts',
			},
		]);
		const census = buildQuarantineCensus(
			ledgerContents(main, { 1: windows }),
			NOW,
		);
		expect(census.totalActive).toBe(3);
		expect(census.histogram).toEqual([
			{ date: '2026-10-08', count: 1 },
			{ date: '2026-11-20', count: 2 },
		]);
		expect(census.firstHardFailDate).toBe('2026-10-23');
		expect(census.daysToFirstWall).toBe(20);
		expect(census.owners).toEqual(['@alice', '@bob']);
		expect(census.unlinkedOwnerEntries).toEqual([
			{
				ledger: 'scripts/ci/quarantined-tests.txt',
				path: 'tests/unit/beta.test.ts',
			},
		]);
		const lines = formatQuarantineCensus(census, null);
		expect(lines).toContain('owner missing issue ref: tests/unit/beta.test.ts');
		expect(lines).toContain('owners: @alice, @bob');
		expect(lines.indexOf('histogram 2026-10-08: 1')).toBeLessThan(
			lines.indexOf('histogram 2026-11-20: 2'),
		);
		// no trend supplied => deterministic unavailable form
		expect(lines).toContain('trend: unavailable (ledger history not readable)');
	});

	test('zero-entry census block byte form', () => {
		const census = buildQuarantineCensus(ledgerContents('# empty\n'), NOW);
		const lines = formatQuarantineCensus(census, {
			available: true,
			added: 0,
			retired: 0,
		});
		expect(lines).toEqual([
			'Quarantine census',
			'ledger scripts/ci/quarantined-tests.txt: 0 active',
			'ledger scripts/ci/quarantined-tests-windows.txt: 0 active',
			'ledger scripts/ci/quarantined-tests-macos.txt: 0 active',
			'ledger scripts/ci/quarantined-integration-tests.txt: 0 active',
			'total active: 0',
			'first hard-fail date: none',
			'days-to-first-wall: n/a',
			'owners: none',
			'trend: +0/-0 over 30d',
		]);
	});

	test('malformed-EXPIRY entries are excluded from the histogram', () => {
		const main = [
			'# fixture',
			'# OWNER: @alice — #1',
			'# EXPIRY: soon-ish',
			'tests/unit/bad.test.ts',
			'',
			'# OWNER: @alice — #2',
			'# EXPIRY: 2026-11-20 — x',
			'tests/unit/good.test.ts',
		].join('\n');
		const census = buildQuarantineCensus(ledgerContents(main), NOW);
		expect(census.histogram).toEqual([{ date: '2026-11-20', count: 1 }]);
		expect(census.firstHardFailDate).toBe('2026-12-05');
	});

	test('expiringSoon covers 0..21 days only', () => {
		const main = ledgerFixture([
			{
				owner: ['# OWNER: @a — #1'],
				expiry: ['# EXPIRY: 2026-10-10 — x'],
				entry: 'tests/unit/in-window.test.ts',
			},
			{
				owner: ['# OWNER: @a — #2'],
				expiry: ['# EXPIRY: 2026-12-01 — x'],
				entry: 'tests/unit/out-window.test.ts',
			},
		]);
		const census = buildQuarantineCensus(ledgerContents(main), NOW);
		expect(census.expiringSoon.map((e) => e.path)).toEqual([
			'tests/unit/in-window.test.ts',
		]);
	});
});

describe('checkQuarantineRenewal (renewal-requires-issue)', () => {
	const headMain = ledgerFixture([
		{
			owner: ['# OWNER: @bob — legacy owner no issue reference'],
			expiry: ['# EXPIRY: 2026-11-20 — renewed expiry'],
			entry: 'tests/unit/renew.test.ts',
		},
	]);
	const baseMain = ledgerFixture([
		{
			owner: ['# OWNER: @bob — legacy owner no issue reference'],
			expiry: ['# EXPIRY: 2026-10-08 — original expiry'],
			entry: 'tests/unit/renew.test.ts',
		},
	]);

	test('enforced: unlinked later EXPIRY => ERROR naming the entry + violation', () => {
		const result = checkQuarantineRenewal({
			headLedgerContents: ledgerContents(headMain),
			baseLedgerContents: ledgerContents(baseMain),
			enforce: true,
		});
		expect(result.violations).toBe(1);
		expect(result.messages.length).toBe(1);
		expect(result.messages[0]?.startsWith('ERROR: ')).toBe(true);
		expect(result.messages[0]).toContain('tests/unit/renew.test.ts');
		expect(result.messages[0]).toContain('2026-11-20');
		expect(result.messages[0]).toContain('2026-10-08');
	});

	test('soft-warn: same finding prints WARNING and counts nothing', () => {
		const result = checkQuarantineRenewal({
			headLedgerContents: ledgerContents(headMain),
			baseLedgerContents: ledgerContents(baseMain),
			enforce: false,
		});
		expect(result.violations).toBe(0);
		expect(result.messages[0]?.startsWith('WARNING: ')).toBe(true);
		expect(result.messages[0]).toContain('tests/unit/renew.test.ts');
	});

	test('issue-referenced renewal passes; new entry is not a renewal', () => {
		const linkedHead = ledgerFixture([
			{
				owner: ['# OWNER: @alice — #2973 renewal tracked'],
				expiry: ['# EXPIRY: 2026-11-20 — renewed'],
				entry: 'tests/unit/renew.test.ts',
			},
			{
				owner: ['# OWNER: @alice — no ref'],
				expiry: ['# EXPIRY: 2026-11-20 — brand new'],
				entry: 'tests/unit/new.test.ts',
			},
		]);
		const result = checkQuarantineRenewal({
			headLedgerContents: ledgerContents(linkedHead),
			baseLedgerContents: ledgerContents(baseMain),
			enforce: true,
		});
		expect(result.violations).toBe(0);
		expect(result.messages).toEqual([]);
	});

	test('entry moved between ledgers with a bumped EXPIRY is still a renewal', () => {
		const headWindows = ledgerFixture([
			{
				owner: ['# OWNER: @bob — legacy owner no issue reference'],
				expiry: ['# EXPIRY: 2026-11-20 — renewed after move'],
				entry: 'tests/unit/renew.test.ts',
			},
		]);
		const result = checkQuarantineRenewal({
			headLedgerContents: ledgerContents('# empty\n', { 1: headWindows }),
			baseLedgerContents: ledgerContents(baseMain),
			enforce: true,
		});
		expect(result.violations).toBe(1);
		expect(result.messages[0]).toContain(
			'previously quarantined in scripts/ci/quarantined-tests.txt',
		);
	});
});

describe('Check 7 integration (census + wall warning + renewal extras)', () => {
	function makeRepo(mainContent: string): string {
		const dir = canonicalMkdtemp('q-census-2905-');
		fs.mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true });
		for (const name of DEFAULT_QUARANTINE_LEDGERS) {
			fs.writeFileSync(
				path.join(dir, ...name.split('/')),
				name.endsWith('quarantined-tests.txt')
					? mainContent
					: '# fixture ledger\n',
			);
		}
		return dir;
	}

	test('wall warning fires at 20 days with census block after the header', () => {
		const repo = makeRepo(
			[
				'# fixture ledger (2905 C2 wall probe)',
				'# OWNER: @carol — #2905 wall probe',
				'# EXPIRY: 2026-10-08 — retire after wall probe',
				'tests/unit/wall.test.ts',
			].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		expect(result.violations).toBe(0);
		const warning = result.messages.find(
			(m) =>
				m.includes('::warning::') &&
				m.includes('2026-10-23') &&
				m.includes('tests/unit/wall.test.ts'),
		);
		expect(warning).toBeTruthy();
		expect(result.messages).toContain('total active: 1');
		expect(result.messages).toContain('first hard-fail date: 2026-10-23');
		expect(result.messages).toContain('days-to-first-wall: 20');
		expect(
			result.messages.findIndex((m) => m.includes('=== Check 7')),
		).toBeLessThan(result.messages.findIndex((m) => m === 'total active: 1'));
	});

	test('wall warning absent at 21+ days', () => {
		const repo = makeRepo(
			[
				'# fixture ledger',
				'# OWNER: @carol — #2905',
				'# EXPIRY: 2026-10-09 — wall lands exactly 21 days out',
				'tests/unit/wall.test.ts',
			].join('\n'),
		);
		const result = checkQuarantineMetadata(repo, NOW);
		const hasWallWarning = result.messages.some((m) =>
			m.includes('::warning::[quarantine-census]'),
		);
		expect(hasWallWarning).toBe(false);
		expect(result.violations).toBe(0);
		expect(result.messages).toContain('days-to-first-wall: 21');
	});

	test('renewal extras: soft-warn keeps violations 0; enforced counts', () => {
		const repo = makeRepo(
			[
				'# fixture ledger',
				'# OWNER: @bob — no ref',
				'# EXPIRY: 2026-11-20 — renewed',
				'tests/unit/renew.test.ts',
			].join('\n'),
		);
		const soft = checkQuarantineMetadata(repo, NOW, {
			renewal: {
				messages: ['WARNING: scripts/ci/quarantined-tests.txt soft-warn line'],
				violations: 0,
			},
		});
		expect(soft.violations).toBe(0);
		expect(soft.messages).toContain(
			'WARNING: scripts/ci/quarantined-tests.txt soft-warn line',
		);
		const hard = checkQuarantineMetadata(repo, NOW, {
			renewal: { messages: ['ERROR: enforced line'], violations: 1 },
		});
		expect(hard.violations).toBe(1);
	});
});

describe('collectAddRetireTrend', () => {
	test('fail-open when git fails (non-git fixture)', async () => {
		const dir = canonicalMkdtemp('q-census-nogit-');
		const original = censusInternals.collectTrendGitLog;
		censusInternals.collectTrendGitLog = async () => ({
			exitCode: 128,
			stdout: '',
			stderr: 'not a git repository',
		});
		try {
			const trend = await collectAddRetireTrend(dir, NOW);
			expect(trend.available).toBe(false);
		} finally {
			censusInternals.collectTrendGitLog = original;
		}
	});

	test('counts added/retired active-entry lines from git log -p', async () => {
		const dir = canonicalMkdtemp('q-census-gitlog-');
		const original = censusInternals.collectTrendGitLog;
		censusInternals.collectTrendGitLog = async () => ({
			exitCode: 0,
			stdout: [
				'commit abc',
				'--- a/scripts/ci/quarantined-tests.txt',
				'+++ b/scripts/ci/quarantined-tests.txt',
				'@@ -1 +1,2 @@',
				'+# comment line (not an entry)',
				'+tests/unit/added.test.ts',
				'-tests/unit/removed.test.ts',
				'+# EXPIRY: 2026-11-18 — comment edit only',
			].join('\n'),
			stderr: '',
		});
		try {
			const trend = await collectAddRetireTrend(dir, NOW);
			expect(trend).toEqual({ available: true, added: 1, retired: 1 });
		} finally {
			censusInternals.collectTrendGitLog = original;
		}
	});
});
describe('formatQuarantineCensus trend reasons', () => {
	test('null keeps the default unreadable-history reason', () => {
		const lines = formatQuarantineCensus(
			buildQuarantineCensus(
				DEFAULT_QUARANTINE_LEDGERS.map((ledger) => ({
					ledger,
					content: '# empty\n',
				})),
				NOW,
			),
			null,
		);
		expect(lines).toContain('trend: unavailable (ledger history not readable)');
	});

	test('a carried reason is printed verbatim', () => {
		const lines = formatQuarantineCensus(
			buildQuarantineCensus(
				DEFAULT_QUARANTINE_LEDGERS.map((ledger) => ({
					ledger,
					content: '# empty\n',
				})),
				NOW,
			),
			{ available: false, reason: 'no active entries' },
		);
		expect(lines).toContain('trend: unavailable (no active entries)');
	});
});
