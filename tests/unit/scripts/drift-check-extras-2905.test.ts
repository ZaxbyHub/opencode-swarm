/**
 * Drift-report census-block tests (issue #2905, swarm-pr-review
 * pr3067-20261004 finding PRR-004): the quarantine census block must render
 * on BOTH buildReport paths (zero-findings and populated) and its
 * interaction with the 64 KiB truncation budget must be honest — the census
 * is appended last, so an overflowing report truncates it. Pure string
 * assembly; no clock, no network.
 */
import { describe, expect, test } from 'bun:test';
import { buildReport, type DriftFinding } from '../../../scripts/drift-check';

const CENSUS_EXTRAS = [
	'Quarantine census',
	'ledger scripts/ci/quarantined-tests.txt: 1 active',
	'total active: 1',
	'first hard-fail date: none',
	'days-to-first-wall: n/a',
	'owners: @a',
	'trend: unavailable (no active entries)',
];

describe('buildReport census extras (PRR-004)', () => {
	test('zero-findings path renders the census block', () => {
		const report = buildReport([], CENSUS_EXTRAS);
		expect(report).toContain('No drift detected');
		expect(report).toContain('### Quarantine census');
		expect(report).toContain('total active: 1');
	});

	test('populated path renders the census block after the findings', () => {
		const findings: DriftFinding[] = [
			{
				category: 'skills',
				severity: 'warning',
				message: 'a skill drifted',
				file: 'x.md',
			},
		];
		const report = buildReport(findings, CENSUS_EXTRAS);
		expect(report).toContain('a skill drifted');
		expect(report).toContain('### Quarantine census');
		expect(report.indexOf('a skill drifted')).toBeLessThan(
			report.indexOf('### Quarantine census'),
		);
	});

	test('reports without extras never render an empty census heading', () => {
		expect(buildReport([], [])).not.toContain('Quarantine census');
	});

	test('a report over the 64 KiB budget truncates and drops the census tail', () => {
		const filler: DriftFinding[] = Array.from({ length: 400 }, (_, i) => ({
			category: 'filler',
			severity: 'notice' as const,
			message: `finding ${i}: ${'x'.repeat(200)}`,
			file: `f${i}.md`,
		}));
		const report = buildReport(filler, CENSUS_EXTRAS);
		expect(report).toContain('report truncated at 65536 bytes');
		expect(report).not.toContain('### Quarantine census');
		// And it stays within the budget.
		expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(64 * 1024);
	});
});
