import { describe, expect, test } from 'bun:test';
import {
	type Citation,
	collectFindings,
	collectRegistryStrings,
	findMalformed,
	looksLikeIdentifier,
	parseCitations,
	parseLineSpec,
	resolveCitedPath,
	type SourceTree,
	splitLines,
} from '../../../scripts/check-registry-citations.ts';

// Issue #1534 — the retention-registry citation drift gate. Every fixture here
// is hand-built: the suite never reads scripts/retention-registry.data.ts or
// the real src/ tree, so a test can never be satisfied by whatever the real
// registry happens to contain today. The real-tree coherence assertions live
// in check-registry-citations-ratchet.test.ts.

/** Build a synthetic source tree from an explicit path -> content map. */
function makeTree(files: Record<string, string>): SourceTree {
	return {
		srcFiles: Object.keys(files).filter(
			(f) => f.startsWith('src/') && !f.endsWith('.test.ts'),
		),
		readFile: (p) => files[p] ?? null,
	};
}

/** A 10-line file whose line 4 declares `writeThing`. */
const TEN_LINE_FILE = [
	'// line 1',
	'// line 2',
	'',
	'export function writeThing(): void {}',
	'',
	'export function readThing(): void {}',
	'',
	'// line 8',
	'// line 9',
	'// line 10',
].join('\n');

describe('parseLineSpec', () => {
	test('parses a single line', () => {
		expect(parseLineSpec('42')).toEqual([{ start: 42, end: 42 }]);
	});

	test('parses a range', () => {
		expect(parseLineSpec('10-20')).toEqual([{ start: 10, end: 20 }]);
	});

	test('parses a comma list mixing singles and ranges', () => {
		expect(parseLineSpec('225,367-370,394')).toEqual([
			{ start: 225, end: 225 },
			{ start: 367, end: 370 },
			{ start: 394, end: 394 },
		]);
	});
});

describe('looksLikeIdentifier', () => {
	test('accepts camelCase, PascalCase, SCREAMING_SNAKE and $-prefixed tokens', () => {
		expect(looksLikeIdentifier('writeThing')).toBe(true);
		expect(looksLikeIdentifier('WriteThing')).toBe(true);
		expect(looksLikeIdentifier('MAX_BYTES')).toBe(true);
		expect(looksLikeIdentifier('$internals')).toBe(true);
	});

	test('rejects all-lowercase words, which are indistinguishable from prose', () => {
		expect(looksLikeIdentifier('bounded')).toBe(false);
		expect(looksLikeIdentifier('sync')).toBe(false);
	});

	test('rejects non-identifier shapes', () => {
		expect(looksLikeIdentifier('10-20')).toBe(false);
		expect(looksLikeIdentifier('a-b')).toBe(false);
		expect(looksLikeIdentifier('')).toBe(false);
	});
});

describe('findMalformed', () => {
	test('catches the #1534 no-colon shape (foo.ts775-794)', () => {
		expect(
			findMalformed('see src/commands/close.ts775-794 for the array'),
		).toEqual(['src/commands/close.ts775-794']);
	});

	test('catches the dropped-colon-in-parentheses shape ((close.ts 775-794))', () => {
		expect(findMalformed('the arrays (close.ts 775-794) are split')).toEqual([
			'close.ts 775-794',
		]);
	});

	test('does NOT flag a well-formed citation', () => {
		expect(
			findMalformed('src/commands/close.ts:775-794 ARCHIVE_ARTIFACTS'),
		).toEqual([]);
	});

	test('does NOT flag prose where a filename is followed by a lone number', () => {
		expect(findMalformed('close.ts 2 arrays are relevant')).toEqual([]);
	});

	test('does NOT flag a filename that legitimately contains digits', () => {
		expect(findMalformed('scripts/repro-1873.ts:12 entry')).toEqual([]);
	});
});

describe('parseCitations', () => {
	const parse = (text: string): Citation[] => parseCitations(text, 'row', 'f');

	test('extracts path, ranges and the adjacent identifier', () => {
		const [c] = parse('src/a/b.ts:12-30 writeThing — atomic');
		expect(c?.pathText).toBe('src/a/b.ts');
		expect(c?.ranges).toEqual([{ start: 12, end: 30 }]);
		expect(c?.identifier).toBe('writeThing');
		expect(c?.continuation).toBe(false);
	});

	test('reports no identifier when punctuation follows the citation', () => {
		const [c] = parse('bounded by src/a/b.ts:12, which is fine');
		expect(c?.identifier).toBeNull();
	});

	test('a continuation inherits the single path that PRECEDES it', () => {
		const cites = parse('src/a/b.ts:12 writeThing — helper :20 readThing');
		expect(cites).toHaveLength(2);
		expect(cites[1]?.continuation).toBe(true);
		expect(cites[1]?.pathText).toBe('src/a/b.ts');
		expect(cites[1]?.identifier).toBe('readThing');
	});

	test('a continuation in a MULTI-path string is left unresolved', () => {
		// Guards the real skill-usage.disposition.citation false positive: a
		// bare (:1697-1703) sitting after a different file's citation.
		const cites = parse('src/a/b.ts:12 and src/c/d.ts:30, plus (:99)');
		expect(cites[2]?.continuation).toBe(true);
		expect(cites[2]?.pathText).toBeNull();
	});

	test('a continuation BEFORE any explicit path is left unresolved', () => {
		// Guards the real skill-usage.crashBehavior false positive: those
		// continuations belong to a file the string never names.
		const cites = parse('(pruneLog :1556, rewrite :1697) then src/a/b.ts:5');
		expect(cites.map((c) => c.raw)).toEqual([':1556', ':1697', 'src/a/b.ts:5']);
		expect(cites[0]?.pathText).toBeNull();
		expect(cites[1]?.pathText).toBeNull();
		expect(cites[2]?.pathText).toBe('src/a/b.ts');
	});

	test('a continuation followed by a comma is captured, not dropped', () => {
		// A dropped token is worse than an unresolved one: it never reaches a
		// coverage bucket, so the gate under-reports what it actually checked.
		expect(
			parse('src/a/b.ts:5 writeThing, helper :9, done').map((c) => c.raw),
		).toEqual(['src/a/b.ts:5', ':9']);
	});

	test('does not mistake a prose key for a continuation', () => {
		expect(parse('maxEntries: 5000 and readMaxBytes=1,677,722 B')).toEqual([]);
	});

	test('does not treat a decimal as a line spec', () => {
		expect(parse('schema version :1.5 applies')).toEqual([]);
	});
});

describe('resolveCitedPath', () => {
	const tree = makeTree({
		'src/plan/manager.ts': '',
		'src/summaries/manager.ts': '',
		'src/tools/repo-graph/cache.ts': '',
		'src/memory/embeddings/cache.ts': '',
		'src/plan/checkpoint.ts': '',
		'src/only/unique-name.ts': '',
	});
	const noCtx = new Set<string>();

	test('resolves a verbatim repo-relative path', () => {
		expect(resolveCitedPath('src/plan/manager.ts', tree, noCtx)).toEqual({
			kind: 'ok',
			file: 'src/plan/manager.ts',
		});
	});

	test('resolves src/-relative shorthand (plan/checkpoint.ts)', () => {
		expect(resolveCitedPath('plan/checkpoint.ts', tree, noCtx)).toEqual({
			kind: 'ok',
			file: 'src/plan/checkpoint.ts',
		});
	});

	test('resolves a unique bare basename', () => {
		expect(resolveCitedPath('unique-name.ts', tree, noCtx)).toEqual({
			kind: 'ok',
			file: 'src/only/unique-name.ts',
		});
	});

	test('reports missing for a path that matches nothing', () => {
		expect(resolveCitedPath('src/gone/away.ts', tree, noCtx)).toEqual({
			kind: 'missing',
		});
	});

	test('reports ambiguous for a duplicated basename with no row context', () => {
		const result = resolveCitedPath('manager.ts', tree, noCtx);
		expect(result.kind).toBe('ambiguous');
	});

	test('row-cited paths break a basename tie', () => {
		expect(
			resolveCitedPath('manager.ts', tree, new Set(['src/plan/manager.ts'])),
		).toEqual({ kind: 'ok', file: 'src/plan/manager.ts' });
	});

	test('a shared directory with a row-cited path breaks a basename tie', () => {
		expect(
			resolveCitedPath(
				'cache.ts',
				tree,
				new Set(['src/tools/repo-graph/storage.ts']),
			),
		).toEqual({ kind: 'ok', file: 'src/tools/repo-graph/cache.ts' });
	});
});

describe('splitLines', () => {
	test('strips CR so a CRLF checkout counts the same as LF', () => {
		expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
	});

	test('a trailing newline does not add a phantom line', () => {
		// Real source files end in \n; every join('\n') fixture does not. Without
		// this, lines.length is wc -l + 1 and the bounds check accepts a citation
		// one line past the end of the file.
		expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
		expect(splitLines('a\nb')).toEqual(['a', 'b']);
		expect(splitLines('')).toEqual([]);
	});
});

describe('bounds against a file that ends in a newline', () => {
	const tree = makeTree({ 'src/a/b.ts': 'one\ntwo\n' });

	test('the last real line is in bounds', () => {
		expect(
			collectFindings([{ id: 'r', writerCitations: ['src/a/b.ts:2'] }], tree)
				.structural,
		).toEqual([]);
	});

	test('the phantom line after the trailing newline is out of bounds', () => {
		const structural = collectFindings(
			[{ id: 'r', writerCitations: ['src/a/b.ts:3'] }],
			tree,
		).structural;
		expect(structural).toHaveLength(1);
		expect(structural[0]?.detail).toContain('1..2');
	});
});

describe('collectRegistryStrings', () => {
	test('walks nested arrays and objects, tagging row id and field path', () => {
		const strings = collectRegistryStrings([
			{ id: 'r1', writerCitations: ['a', 'b'], writeLimits: { citation: 'c' } },
		]);
		expect(strings).toEqual([
			{ rowId: 'r1', field: 'id', value: 'r1' },
			{ rowId: 'r1', field: 'writerCitations[0]', value: 'a' },
			{ rowId: 'r1', field: 'writerCitations[1]', value: 'b' },
			{ rowId: 'r1', field: 'writeLimits.citation', value: 'c' },
		]);
	});
});

describe('collectFindings — structural arm', () => {
	const tree = makeTree({ 'src/a/b.ts': TEN_LINE_FILE });

	test('a well-formed, in-bounds, anchored citation produces no findings', () => {
		const result = collectFindings(
			[{ id: 'row', writerCitations: ['src/a/b.ts:4 writeThing — atomic'] }],
			tree,
		);
		expect(result.structural).toEqual([]);
		expect(result.anchorFailures).toEqual([]);
		expect(result.coverage.structurallyChecked).toBe(1);
		expect(result.coverage.anchorPassed).toBe(1);
		expect(result.coverage.anchorOutOfRange).toBe(0);
	});

	test('a citation naming a missing file is a structural failure', () => {
		const result = collectFindings(
			[{ id: 'row', writerCitations: ['src/a/gone.ts:4 writeThing'] }],
			tree,
		);
		expect(result.structural).toHaveLength(1);
		expect(result.structural[0]?.kind).toBe('unresolvable-path');
		expect(result.structural[0]?.raw).toBe('src/a/gone.ts:4');
		expect(result.structural[0]?.detail).toContain('src/a/gone.ts');
	});

	test('a line past the end of the file is a structural failure', () => {
		const result = collectFindings(
			[{ id: 'row', writerCitations: ['src/a/b.ts:11 writeThing'] }],
			tree,
		);
		expect(result.structural).toHaveLength(1);
		expect(result.structural[0]?.kind).toBe('out-of-bounds');
		expect(result.structural[0]?.detail).toContain('1..10');
	});

	test('a zero / inverted range is a structural failure', () => {
		expect(
			collectFindings(
				[{ id: 'row', writerCitations: ['src/a/b.ts:0 writeThing'] }],
				tree,
			).structural[0]?.kind,
		).toBe('out-of-bounds');
		expect(
			collectFindings(
				[{ id: 'row', writerCitations: ['src/a/b.ts:8-3 writeThing'] }],
				tree,
			).structural[0]?.kind,
		).toBe('out-of-bounds');
	});

	test('the no-colon malformed shape is a structural failure', () => {
		const result = collectFindings(
			[{ id: 'row', writerCitations: ['src/a/b.ts4-9 writeThing'] }],
			tree,
		);
		expect(result.structural.map((f) => f.kind)).toContain('malformed');
	});

	test('every comma-list member is bounds-checked, not just the first', () => {
		const result = collectFindings(
			[{ id: 'row', writerCitations: ['src/a/b.ts:4,999'] }],
			tree,
		);
		expect(result.structural).toHaveLength(1);
		expect(result.structural[0]?.detail).toContain('999-999');
	});

	test('an unresolvable continuation is counted, never silently dropped', () => {
		const result = collectFindings(
			[{ id: 'row', crashBehavior: '(pruneLog :1556) then src/a/b.ts:4' }],
			tree,
		);
		expect(result.structural).toEqual([]);
		expect(result.coverage.continuationsUnresolvable).toBe(1);
		expect(result.coverage.citationsScanned).toBe(2);
	});
});
