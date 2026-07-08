/**
 * Tests for scripts/release-notes-fragments.mjs — pure helper functions.
 *
 * Network/`gh` interactions are intentionally not exercised here. The
 * pure helpers are exported from the script and tested directly.
 */
import { describe, expect, test } from 'bun:test';
// @ts-expect-error — .mjs script with no .d.ts; runtime imports are fine.
import {
	extractCandidatePrNumbers,
	extractCommitShasFromBody,
	isValidPrNumber,
	MARKER_END,
	MARKER_START,
	mergeCandidateLists,
	resolveAllCandidates,
	selectValidPrNumbers,
	stripCustomReleaseNotesBlock,
} from '../../../scripts/release-notes-fragments.mjs';

describe('extractCommitShasFromBody', () => {
	const sha40 = 'ba948b40159e1641d158d2efbd815abac1f94ad2';
	const sha40b = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

	test('extracts a full 40-char SHA from a GitHub commit URL', () => {
		const body = `* feat: something ([ba948b4](https://github.com/owner/repo/commit/${sha40}))`;
		expect(extractCommitShasFromBody(body)).toEqual([sha40]);
	});
	test('is case-insensitive for hex digits and normalises to lowercase', () => {
		const mixed = sha40.toUpperCase();
		expect(extractCommitShasFromBody(`/commit/${mixed}`)).toEqual([sha40]);
	});
	test('returns empty for empty/non-string input', () => {
		expect(extractCommitShasFromBody('')).toEqual([]);
		expect(extractCommitShasFromBody(null as unknown as string)).toEqual([]);
		expect(extractCommitShasFromBody(undefined as unknown as string)).toEqual(
			[],
		);
	});
	test('does NOT extract short (7-char) SHA labels in link text', () => {
		// The link text `ba948b4` is only 7 chars; only the URL target (40 chars) counts.
		const body = `* change ([ba948b4](https://github.com/owner/repo/commit/${sha40}))`;
		const result = extractCommitShasFromBody(body);
		expect(result).toEqual([sha40]);
		expect(result).not.toContain('ba948b4'); // short label not extracted
	});
	test('deduplicates identical SHAs appearing multiple times', () => {
		const body = `/commit/${sha40} and again /commit/${sha40}`;
		expect(extractCommitShasFromBody(body)).toEqual([sha40]);
	});
	test('extracts multiple distinct SHAs in first-seen order', () => {
		const body = `/commit/${sha40} then /commit/${sha40b}`;
		expect(extractCommitShasFromBody(body)).toEqual([sha40, sha40b]);
	});
	test('does NOT extract 39-char or 41-char hex strings', () => {
		const short = 'a'.repeat(39);
		const long = 'b'.repeat(41);
		expect(extractCommitShasFromBody(`/commit/${short}`)).toEqual([]);
		expect(extractCommitShasFromBody(`/commit/${long}`)).toEqual([]);
	});
	test('does NOT extract non-hex characters embedded in a 40-char string', () => {
		expect(
			extractCommitShasFromBody(
				'/commit/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
			),
		).toEqual([]);
	});
	test('extracts a release-please-style body with commit links and no PR refs', () => {
		// This matches the actual format observed in the wild that broke the
		// original PR-number-only extractor.
		const body = [
			':robot: I have created a release *beep* *boop*',
			'',
			'## [7.110.0](https://github.com/owner/repo/compare/v7.109.4...v7.110.0) (2026-07-08)',
			'',
			'### Features',
			`* **skills:** add swarm-ci-monitor skill ([ba948b4](https://github.com/owner/repo/commit/${sha40}))`,
		].join('\n');
		expect(extractCommitShasFromBody(body)).toEqual([sha40]);
		// Confirm PR-number extractor finds nothing (proving the gap the new
		// function closes).
		expect(extractCandidatePrNumbers(body)).toEqual([]);
	});
	test('does NOT extract SHAs from /compare/ URLs (changelog section headers)', () => {
		// CHANGELOG.md lines like:
		//   ## [7.109.4](https://github.com/owner/repo/compare/v7.109.3...v7.109.4)
		// contain 40-hex-like version strings after /compare/, but the URL
		// path is /compare/ not /commit/, so they must NOT be extracted.
		const body = [
			'## [7.109.4](https://github.com/owner/repo/compare/v7.109.3...v7.109.4) (2026-07-08)',
			`## also this [compare](https://github.com/owner/repo/compare/${sha40}...${sha40b})`,
		].join('\n');
		expect(extractCommitShasFromBody(body)).toEqual([]);
	});
});

describe('mergeCandidateLists', () => {
	test('returns direct candidates when shaResolved is empty', () => {
		expect(mergeCandidateLists([1, 2, 3], [])).toEqual([1, 2, 3]);
	});
	test('appends non-overlapping shaResolved entries after direct', () => {
		expect(mergeCandidateLists([1, 2, 3], [4, 5])).toEqual([1, 2, 3, 4, 5]);
	});
	test('deduplicates: shaResolved entries already in direct are dropped', () => {
		expect(mergeCandidateLists([1, 2, 3], [2, 4])).toEqual([1, 2, 3, 4]);
	});
	test('preserves first-seen order from direct then shaResolved', () => {
		expect(mergeCandidateLists([50, 10], [30, 10, 20])).toEqual([
			50, 10, 30, 20,
		]);
	});
	test('returns shaResolved when direct is empty', () => {
		expect(mergeCandidateLists([], [7, 8, 9])).toEqual([7, 8, 9]);
	});
	test('returns empty when both inputs are empty', () => {
		expect(mergeCandidateLists([], [])).toEqual([]);
	});
	test('deduplicates within direct itself (intra-list dups)', () => {
		expect(mergeCandidateLists([1, 1, 2], [3])).toEqual([1, 2, 3]);
	});
	test('handles non-array inputs gracefully', () => {
		expect(mergeCandidateLists(null as unknown as number[], [1, 2])).toEqual([
			1, 2,
		]);
		expect(mergeCandidateLists([1, 2], null as unknown as number[])).toEqual([
			1, 2,
		]);
		expect(
			mergeCandidateLists(
				null as unknown as number[],
				null as unknown as number[],
			),
		).toEqual([]);
	});
});

describe('stripCustomReleaseNotesBlock + re-scan defense', () => {
	test('strips the marker block when present', () => {
		const body = [
			'some context (#100)',
			'',
			`${MARKER_START}`,
			'injected content with (#200) (#300) references',
			`${MARKER_END}`,
			'',
			'trailing release-please body referencing (#400)',
		].join('\n');
		const stripped = stripCustomReleaseNotesBlock(body);
		expect(stripped).toContain('(#100)');
		expect(stripped).toContain('(#400)');
		expect(stripped).not.toContain('(#200)');
		expect(stripped).not.toContain('(#300)');
		expect(stripped).not.toContain(MARKER_START);
		expect(stripped).not.toContain(MARKER_END);
	});
	test('returns body unchanged when markers absent', () => {
		const body = 'no markers here, just (#500) text';
		expect(stripCustomReleaseNotesBlock(body)).toBe(body);
	});
	test('handles empty / non-string body', () => {
		expect(stripCustomReleaseNotesBlock('')).toBe('');
		expect(stripCustomReleaseNotesBlock(null as unknown as string)).toBe('');
	});
	test('PR-number extraction on a body with injected notes no longer picks up references inside the marker block', () => {
		// Simulates a rerun scenario where a previous aggregation injected
		// the fragment for PR #896 (which cites #885 and #890 as context).
		// A naive extractor would re-list #885 and #890 as new candidates;
		// the strip-first pattern prevents that drift.
		const body = [
			':robot: release-please created a release',
			'## [7.22.0]',
			'### Features',
			'* something ([#896](https://github.com/owner/repo/pull/896))',
			'',
			`${MARKER_START}`,
			'# spec-drift fix — closes (#890), builds on (#885)',
			`${MARKER_END}`,
		].join('\n');
		const stripped = stripCustomReleaseNotesBlock(body);
		const candidates = extractCandidatePrNumbers(stripped);
		expect(candidates).toEqual([896]);
		expect(candidates).not.toContain(885);
		expect(candidates).not.toContain(890);
	});
	test('commit SHA extraction on a body with previously-injected notes does NOT re-scan SHAs inside the marker block', () => {
		// A prior run injected a fragment whose prose cites an older commit
		// SHA (e.g. "fixes regression introduced in abc123..."). On re-run,
		// the strip-first strategy must prevent that injected SHA from being
		// treated as a new source commit and spuriously re-resolving to a PR.
		const injectedSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		const realSha = 'ba948b40159e1641d158d2efbd815abac1f94ad2';
		const body = [
			':robot: release-please created a release',
			'## [7.110.0]',
			'### Features',
			`* feat: add skill ([ba948b4](https://github.com/owner/repo/commit/${realSha}))`,
			'',
			`${MARKER_START}`,
			`Previously fixed by https://github.com/owner/repo/commit/${injectedSha}`,
			`${MARKER_END}`,
		].join('\n');
		const stripped = stripCustomReleaseNotesBlock(body);
		const shas = extractCommitShasFromBody(stripped);
		expect(shas).toEqual([realSha]);
		expect(shas).not.toContain(injectedSha);
	});
	test('absorbs nested markers (matches upsertReleaseNotesBlock semantics)', () => {
		const body = [
			`${MARKER_START}`,
			'outer (#1)',
			`${MARKER_START}`,
			'nested (#2)',
			`${MARKER_END}`,
			'still inside (#3)',
			`${MARKER_END}`,
			'',
			'outside (#4)',
		].join('\n');
		const stripped = stripCustomReleaseNotesBlock(body);
		expect(stripped).toContain('(#4)');
		expect(stripped).not.toContain('(#1)');
		expect(stripped).not.toContain('(#2)');
		expect(stripped).not.toContain('(#3)');
	});
});

describe('isValidPrNumber', () => {
	test('accepts valid positive integers', () => {
		expect(isValidPrNumber(1)).toBe(true);
		expect(isValidPrNumber(123)).toBe(true);
		expect(isValidPrNumber(9999999)).toBe(true); // max 7-digit
	});
	test('rejects zero', () => {
		expect(isValidPrNumber(0)).toBe(false);
	});
	test('rejects negative numbers', () => {
		expect(isValidPrNumber(-1)).toBe(false);
		expect(isValidPrNumber(-100)).toBe(false);
	});
	test('rejects NaN', () => {
		expect(isValidPrNumber(NaN)).toBe(false);
	});
	test('rejects Infinity', () => {
		expect(isValidPrNumber(Infinity)).toBe(false);
	});
	test('rejects non-number types', () => {
		expect(isValidPrNumber('123')).toBe(false);
		expect(isValidPrNumber(null)).toBe(false);
		expect(isValidPrNumber(undefined)).toBe(false);
		expect(isValidPrNumber({})).toBe(false);
		expect(isValidPrNumber([123])).toBe(false);
	});
	test('rejects numbers exceeding MAX_PR_DIGITS (10_000_000)', () => {
		expect(isValidPrNumber(10_000_000)).toBe(false);
		expect(isValidPrNumber(99_999_999)).toBe(false);
	});
	test('accepts boundary value 9_999_999 (just under cap)', () => {
		expect(isValidPrNumber(9_999_999)).toBe(true);
	});
});

describe('selectValidPrNumbers', () => {
	test('returns [] for non-array inputs (null, undefined, object, string)', () => {
		expect(selectValidPrNumbers(null as unknown as number[])).toEqual([]);
		expect(selectValidPrNumbers(undefined as unknown as number[])).toEqual([]);
		expect(selectValidPrNumbers({} as unknown as number[])).toEqual([]);
		expect(selectValidPrNumbers('x' as unknown as number[])).toEqual([]);
	});
	test('skips null and undefined elements without throwing', () => {
		const input = [null, { number: 123 }, undefined, { number: 456 }];
		expect(selectValidPrNumbers(input as never[])).toEqual([123, 456]);
	});
	test('skips non-object elements (raw numbers, strings)', () => {
		const input = [123, 'x', { number: 7 }];
		expect(selectValidPrNumbers(input as never[])).toEqual([7]);
	});
	test('rejects objects whose number fails isValidPrNumber (0, negative, NaN, float, >1e7)', () => {
		const input = [
			{ number: 0 },
			{ number: -1 },
			{ number: NaN },
			{ number: 1.5 },
			{ number: 99_999_999 },
			{ number: 123 },
		];
		expect(selectValidPrNumbers(input)).toEqual([123]);
	});
	test('deduplicates preserving first-seen order', () => {
		const input = [{ number: 123 }, { number: 123 }, { number: 456 }];
		expect(selectValidPrNumbers(input)).toEqual([123, 456]);
	});
	test('returns [] for an all-invalid array', () => {
		const input = [null, { number: 0 }, 'x'];
		expect(selectValidPrNumbers(input as never[])).toEqual([]);
	});
});

describe('resolveAllCandidates (no commit SHAs path)', () => {
	test('body with direct PR refs and no commit SHAs returns merged direct candidates', () => {
		const logs: string[] = [];
		const log = (m: string) => logs.push(m);
		const body = 'some text (#123) more text /pull/456 trailing';
		const result = resolveAllCandidates(body, log);
		expect(result).toEqual([123, 456]);
		expect(logs).toContain('found 2 direct PR ref(s) in body');
		expect(logs).toContain('found 0 commit SHA(s) in body');
	});
	test('body with no refs and no SHAs returns []', () => {
		const logs: string[] = [];
		const log = (m: string) => logs.push(m);
		const result = resolveAllCandidates('no references at all', log);
		expect(result).toEqual([]);
		expect(logs).toContain('found 0 direct PR ref(s) in body');
		expect(logs).toContain('found 0 commit SHA(s) in body');
	});
	test('body with direct refs but no extractable commit SHAs returns just the direct list', () => {
		const logs: string[] = [];
		const log = (m: string) => logs.push(m);
		// Only direct PR refs — no /commit/<sha> URLs, so SHA path is skipped entirely
		const body = 'changes from (#10) and (#20)';
		const result = resolveAllCandidates(body, log);
		expect(result).toEqual([10, 20]);
		expect(logs.some((m) => m.includes('resolved 0 PR number(s) from commit SHAs'))).toBe(true);
	});
});
