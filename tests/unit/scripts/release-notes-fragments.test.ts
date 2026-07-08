/**
 * Tests for scripts/release-notes-fragments.mjs — pure helper functions.
 *
 * Network/`gh` interactions are intentionally not exercised here. The
 * pure helpers are exported from the script and tested directly.
 */
import { describe, expect, test } from 'bun:test';
// @ts-expect-error — .mjs script with no .d.ts; runtime imports are fine.
import {
	combineFragments,
	extractCandidatePrNumbers,
	extractCommitShasFromBody,
	filterPendingFragmentPaths,
	MARKER_END,
	MARKER_START,
	mergeCandidateLists,
	stripCustomReleaseNotesBlock,
	upsertReleaseNotesBlock,
} from '../../../scripts/release-notes-fragments.mjs';

describe('extractCandidatePrNumbers', () => {
	test('extracts (#123) parenthesized references', () => {
		expect(extractCandidatePrNumbers('- some change (#123)')).toEqual([123]);
	});
	test('extracts [#123] bracketed references', () => {
		expect(extractCandidatePrNumbers('See [#456](https://x)')).toEqual([456]);
	});
	test('extracts /pull/123 URL references', () => {
		expect(
			extractCandidatePrNumbers('https://github.com/owner/repo/pull/789'),
		).toEqual([789]);
	});
	test('extracts bare #123 references', () => {
		expect(extractCandidatePrNumbers('Closes #42 and #43')).toEqual([42, 43]);
	});
	test('de-duplicates PR numbers across multiple syntaxes', () => {
		const body = '- thing (#100)\n- thing [#100](url)\n- /pull/100';
		expect(extractCandidatePrNumbers(body)).toEqual([100]);
	});
	test('preserves first-seen order', () => {
		const body = '- (#50)\n- (#10)\n- (#30)';
		expect(extractCandidatePrNumbers(body)).toEqual([50, 10, 30]);
	});
	test('returns empty for null/empty/non-string body', () => {
		expect(extractCandidatePrNumbers('')).toEqual([]);
		expect(extractCandidatePrNumbers(null as unknown as string)).toEqual([]);
		expect(extractCandidatePrNumbers(undefined as unknown as string)).toEqual(
			[],
		);
	});
	test('ignores numbers that are part of larger paths (not really PR refs)', () => {
		// `/notes/123` — no leading `#`, no `pull/`, no parens/brackets → not extracted
		expect(extractCandidatePrNumbers('see /notes/123')).toEqual([]);
	});
});

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
		expect(extractCommitShasFromBody(undefined as unknown as string)).toEqual([]);
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
		expect(extractCommitShasFromBody('/commit/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toEqual([]);
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
		expect(mergeCandidateLists([50, 10], [30, 10, 20])).toEqual([50, 10, 30, 20]);
	});
	test('returns shaResolved when direct is empty', () => {
		expect(mergeCandidateLists([], [7, 8, 9])).toEqual([7, 8, 9]);
	});
	test('returns empty when both inputs are empty', () => {
		expect(mergeCandidateLists([], [])).toEqual([]);
	});
	test('handles non-array inputs gracefully', () => {
		expect(mergeCandidateLists(null as unknown as number[], [1, 2])).toEqual([1, 2]);
		expect(mergeCandidateLists([1, 2], null as unknown as number[])).toEqual([1, 2]);
		expect(mergeCandidateLists(null as unknown as number[], null as unknown as number[])).toEqual([]);
	});
});

describe('filterPendingFragmentPaths', () => {
	test('keeps docs/releases/pending/*.md only', () => {
		const files = [
			{ path: 'docs/releases/pending/a.md' },
			{ path: 'docs/releases/pending/b.md' },
			{ path: 'docs/releases/v7.21.4.md' },
			{ path: 'src/foo.ts' },
			{ path: 'README.md' },
		];
		expect(filterPendingFragmentPaths(files)).toEqual([
			'docs/releases/pending/a.md',
			'docs/releases/pending/b.md',
		]);
	});
	test('ignores versioned docs/releases/vX.Y.Z.md files', () => {
		const files = [
			{ path: 'docs/releases/v6.86.9.md' },
			{ path: 'docs/releases/v7.0.0.md' },
		];
		expect(filterPendingFragmentPaths(files)).toEqual([]);
	});
	test('handles plain-string entries', () => {
		expect(
			filterPendingFragmentPaths(['docs/releases/pending/x.md', 'README.md']),
		).toEqual(['docs/releases/pending/x.md']);
	});
	test('normalizes Windows backslash paths', () => {
		const files = [{ path: 'docs\\releases\\pending\\win.md' }];
		expect(filterPendingFragmentPaths(files)).toEqual([
			'docs/releases/pending/win.md',
		]);
	});
	test('case-sensitive directory match, case-insensitive .md extension', () => {
		expect(
			filterPendingFragmentPaths([
				{ path: 'docs/releases/pending/CAPS.MD' },
				{ path: 'docs/releases/Pending/wrong-case.md' }, // wrong case in dir
			]),
		).toEqual(['docs/releases/pending/CAPS.MD']);
	});
	test('returns empty for non-array input', () => {
		expect(filterPendingFragmentPaths(null as unknown as unknown[])).toEqual(
			[],
		);
		expect(
			filterPendingFragmentPaths(undefined as unknown as unknown[]),
		).toEqual([]);
	});
});

describe('combineFragments', () => {
	const entry = (prNumber: number, filePath: string, content: string) => ({
		prNumber,
		filePath,
		content,
	});

	test('returns empty string for empty input', () => {
		expect(combineFragments([])).toBe('');
	});
	test('joins single fragment without separator', () => {
		expect(combineFragments([entry(1, 'a.md', '# One')])).toBe('# One');
	});
	test('joins multiple fragments with --- separator', () => {
		const result = combineFragments([
			entry(1, 'a.md', '# A'),
			entry(2, 'b.md', '# B'),
		]);
		expect(result).toBe('# A\n\n---\n\n# B');
	});
	test('orders by PR number ascending', () => {
		const result = combineFragments([
			entry(50, 'fifty.md', 'fifty'),
			entry(10, 'ten.md', 'ten'),
			entry(30, 'thirty.md', 'thirty'),
		]);
		expect(result).toBe('ten\n\n---\n\nthirty\n\n---\n\nfifty');
	});
	test('secondary sort by filePath when PR numbers tie', () => {
		const result = combineFragments([
			entry(5, 'b.md', 'b-content'),
			entry(5, 'a.md', 'a-content'),
		]);
		expect(result).toBe('a-content\n\n---\n\nb-content');
	});
	test('de-duplicates by filePath', () => {
		const result = combineFragments([
			entry(1, 'a.md', '# A'),
			entry(2, 'a.md', '# A-dup'),
		]);
		// First-seen wins (Map insertion order), and only one copy in output.
		expect(result).toBe('# A');
	});
	test('trims trailing whitespace from each fragment', () => {
		const result = combineFragments([
			entry(1, 'a.md', '# A\n\n\n'),
			entry(2, 'b.md', '# B\n   '),
		]);
		expect(result).toBe('# A\n\n---\n\n# B');
	});
});

describe('upsertReleaseNotesBlock', () => {
	test('prepends marker block when none exists, preserving original body', () => {
		const body = ':robot: I have created a release\n\n<changelog content>';
		const out = upsertReleaseNotesBlock(body, '# Topic\n\nNotes here');
		expect(out.startsWith(MARKER_START)).toBe(true);
		expect(out).toContain('# Topic');
		expect(out).toContain(MARKER_END);
		expect(out).toContain(':robot: I have created a release');
		expect(out).toContain('<changelog content>');
	});
	test('replaces existing marker block without duplication (idempotent)', () => {
		const original = `${MARKER_START}\nold content\n${MARKER_END}\n\n:robot: rest`;
		const out = upsertReleaseNotesBlock(original, 'new content');
		expect(out).toBe(
			`${MARKER_START}\nnew content\n${MARKER_END}\n\n:robot: rest`,
		);
		// Idempotent: same input → same output.
		expect(upsertReleaseNotesBlock(out, 'new content')).toBe(out);
		// And no duplicate marker blocks.
		const matches = out.match(/custom-release-notes:start/g) ?? [];
		expect(matches.length).toBe(1);
	});
	test('returns body unchanged when combined notes are empty', () => {
		const body = ':robot: existing';
		expect(upsertReleaseNotesBlock(body, '')).toBe(body);
		expect(upsertReleaseNotesBlock(body, '   ')).toBe(body);
	});
	test('handles empty body by producing just the marker block', () => {
		const out = upsertReleaseNotesBlock('', '# X');
		expect(out).toBe(`${MARKER_START}\n# X\n${MARKER_END}`);
	});
	test('preserves release-please robot/body markers below the block', () => {
		const releaseBody = [
			':robot: I have created a release *beep* *boop*',
			'',
			'---',
			'',
			'## [7.22.0](compare/...) (2026-05-17)',
			'',
			'### Features',
			'* something ([#900](https://github.com/owner/repo/pull/900))',
		].join('\n');
		const out = upsertReleaseNotesBlock(releaseBody, '# Notes');
		expect(out).toContain(':robot: I have created a release');
		expect(out).toContain('## [7.22.0]');
		expect(out).toContain('### Features');
		expect(out).toContain('[#900]');
		expect(out.indexOf(MARKER_END)).toBeLessThan(
			out.indexOf(':robot: I have created a release'),
		);
	});
	test('does not duplicate notes when run twice with different content (replaces)', () => {
		let body = 'baseline';
		body = upsertReleaseNotesBlock(body, 'first');
		body = upsertReleaseNotesBlock(body, 'second');
		const startCount = (body.match(/custom-release-notes:start/g) ?? []).length;
		const endCount = (body.match(/custom-release-notes:end/g) ?? []).length;
		expect(startCount).toBe(1);
		expect(endCount).toBe(1);
		expect(body).toContain('second');
		expect(body).not.toContain('first');
	});

	// Adversarial cases surfaced by the fresh-critic pass on PR #896.
	describe('marker-collision idempotency (adversarial)', () => {
		const literalStart = '<!-- custom-release-notes:start -->';
		const literalEnd = '<!-- custom-release-notes:end -->';

		test('fragment content that literally mentions the markers does NOT nest them in the block', () => {
			// A fragment legitimately documenting the marker syntax (this PR
			// itself ships one). Inserting it should NOT produce a body with
			// nested markers, and re-running must be idempotent.
			const fragmentContent = `Notes about markers — we use ${literalStart} and ${literalEnd} to delimit.`;
			const body = upsertReleaseNotesBlock('baseline', fragmentContent);
			const startCount = (body.match(/custom-release-notes:start/g) ?? [])
				.length;
			const endCount = (body.match(/custom-release-notes:end/g) ?? []).length;
			expect(startCount).toBe(1);
			expect(endCount).toBe(1);
		});

		test('idempotent across repeated runs with marker-containing content', () => {
			const fragmentContent = `Documenting ${literalStart} and ${literalEnd} delimiters.`;
			let body = 'baseline';
			body = upsertReleaseNotesBlock(body, fragmentContent);
			const afterFirst = body;
			body = upsertReleaseNotesBlock(body, fragmentContent);
			expect(body).toBe(afterFirst);
			body = upsertReleaseNotesBlock(body, fragmentContent);
			expect(body).toBe(afterFirst);
			const startCount = (body.match(/custom-release-notes:start/g) ?? [])
				.length;
			expect(startCount).toBe(1);
		});

		test('fragment attempting to escape the block (close + reopen markers) is neutralized', () => {
			// Attack: a fragment ends its own block early, injects raw HTML,
			// then opens a fresh block to swallow trailing release-please
			// content. The neutralizer must rewrite ALL literal markers,
			// preventing the escape.
			const malicious = `Legit text. ${literalEnd}\n\n# EVIL INJECTION\n\n${literalStart} more content`;
			const body = upsertReleaseNotesBlock(
				':robot: release-please content here',
				malicious,
			);
			const startCount = (body.match(/custom-release-notes:start/g) ?? [])
				.length;
			const endCount = (body.match(/custom-release-notes:end/g) ?? []).length;
			expect(startCount).toBe(1);
			expect(endCount).toBe(1);
			expect(body).toContain(':robot: release-please content here');
		});

		test('absorbs pre-existing nested markers from a prior buggy run', () => {
			// Simulate a body that a prior (broken) version of upsert left
			// behind: nested marker blocks. The fix's `lastIndexOf` lookup
			// for the end marker must absorb everything between the FIRST
			// start and the LAST end on the next run.
			const corrupted = [
				`${literalStart}`,
				'old content',
				`${literalStart}`,
				'nested orphan',
				`${literalEnd}`,
				'more nested orphan',
				`${literalEnd}`,
				'',
				':robot: trailing release-please content',
			].join('\n');
			const body = upsertReleaseNotesBlock(corrupted, 'clean new content');
			const startCount = (body.match(/custom-release-notes:start/g) ?? [])
				.length;
			const endCount = (body.match(/custom-release-notes:end/g) ?? []).length;
			expect(startCount).toBe(1);
			expect(endCount).toBe(1);
			expect(body).toContain('clean new content');
			expect(body).toContain(':robot: trailing release-please content');
			expect(body).not.toContain('old content');
			expect(body).not.toContain('nested orphan');
		});
	});
});

describe('path-traversal rejection (adversarial)', () => {
	test('rejects paths containing .. segments', () => {
		expect(
			filterPendingFragmentPaths([
				{ path: 'docs/releases/pending/../../etc/passwd' },
				{ path: 'docs/releases/pending/../../../secrets.md' },
				{ path: 'docs/releases/pending/./../escape.md' },
			]),
		).toEqual([]);
	});
	test('rejects paths with Windows-style .. segments after normalization', () => {
		expect(
			filterPendingFragmentPaths([
				{ path: 'docs\\releases\\pending\\..\\..\\secret.md' },
			]),
		).toEqual([]);
	});
	test('rejects absolute POSIX paths', () => {
		expect(
			filterPendingFragmentPaths([{ path: '/docs/releases/pending/x.md' }]),
		).toEqual([]);
	});
	test('rejects absolute Windows paths (drive letter)', () => {
		expect(
			filterPendingFragmentPaths([
				{ path: 'C:/docs/releases/pending/x.md' },
				{ path: 'C:\\docs\\releases\\pending\\x.md' },
			]),
		).toEqual([]);
	});
	test('rejects UNC / share-style paths', () => {
		expect(
			filterPendingFragmentPaths([
				{ path: '\\\\share\\docs\\releases\\pending\\x.md' },
			]),
		).toEqual([]);
	});
	test('rejects paths containing NUL or control characters', () => {
		expect(
			filterPendingFragmentPaths([
				{ path: 'docs/releases/pending/evil\x00.md' },
				{ path: 'docs/releases/pending/nl\nfile.md' },
			]),
		).toEqual([]);
	});
	test('accepts well-formed relative paths after the traversal rejections', () => {
		expect(
			filterPendingFragmentPaths([
				{ path: 'docs/releases/pending/legitimate.md' },
				{ path: 'docs/releases/pending/../../escape.md' },
			]),
		).toEqual(['docs/releases/pending/legitimate.md']);
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

describe('PR-number extraction — adversarial inputs', () => {
	test('rejects PR numbers exceeding the 7-digit cap', () => {
		expect(
			extractCandidatePrNumbers('giant junk (#12345678) and (#99999999999)'),
		).toEqual([]);
	});
	test('accepts up to 7-digit numbers', () => {
		expect(extractCandidatePrNumbers('(#1234567)')).toEqual([1234567]);
	});
	test('does not split a longer digit run into a valid head + ignored tail', () => {
		// `#12345678` is 8 digits; the regex CAP would otherwise greedily
		// capture the first 7 (`1234567`) and the trailing `8` would be
		// ignored, producing a fake PR ref. The trailing-digit check
		// must reject the whole match.
		expect(extractCandidatePrNumbers('see #12345678 ref')).toEqual([]);
	});
	test('rejects zero and negative-looking refs', () => {
		expect(extractCandidatePrNumbers('(#0)')).toEqual([]);
		expect(extractCandidatePrNumbers('see #-1')).toEqual([]);
	});
	test('rejects scientific-notation-looking inputs', () => {
		// `1e5` would parseInt to 1 in lax parsers; our cap restricts
		// to `\d{1,7}` and the regex doesn't match `e`, so it's safe.
		expect(extractCandidatePrNumbers('(#1e5)')).toEqual([]);
	});
});
