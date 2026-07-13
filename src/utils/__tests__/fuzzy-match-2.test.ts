import { describe, expect, test } from 'bun:test';
import { fuzzyFindAndReplace, findClosestLines, formatNoMatchHint } from '../fuzzy-match';

/**
 * Fuzzy-match acceptance tests — part 2 of 2.
 *
 * Verbatim port of these hermes test classes from
 * `E:/ZCode/hermes/tests/tools/test_fuzzy_match.py`:
 * - TestEscapeDriftGuard (6)
 * - TestEscapeNormalizedNewString (7 — tab/CR unescape, \n exclusion)
 * - TestFindClosestLines (5)
 * - TestFormatNoMatchHint (7)
 *
 * Part 1 (`fuzzy-match.test.ts`) covers the exact/whitespace/indent/unicode/
 * block-anchor/strategy-name/replace-all classes.
 */

describe('TestEscapeDriftGuard', () => {
	test('drift blocked on apostrophe', () => {
		// File has no apostrophe; old_string and new_string both have `\\'` —
		// classic tool-call drift. Guard must block instead of writing `\\'`.
		const content = 'line\n    x = 1\nline';
		const old = "line\n  x = \\'a\\'\nline";
		const newS = "line\n  x = \\'b\\'\nline";
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.matchCount).toBe(0);
		expect(r.error).not.toBeNull();
		expect(r.error).toContain('Escape-drift');
		expect(r.error!.toLowerCase()).toContain('backslash');
		expect(r.content).toBe(content); // file untouched
	});

	test('drift blocked on double quote', () => {
		const content = 'line\n    x = 1\nline';
		const old = 'line\n  x = \\"a\\"\nline';
		const newS = 'line\n  x = \\"b\\"\nline';
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.matchCount).toBe(0);
		expect(r.error).not.toBeNull();
		expect(r.error).toContain('Escape-drift');
	});

	test('drift allowed when file genuinely has backslash escapes', () => {
		// File already contains `\\'` inside an existing escaped string → model
		// is legitimately preserving it. Guard must NOT fire.
		const content = "line\n  x = \\'a\\'\nline";
		const old = "line\n  x = \\'a\\'\nline";
		const newS = "line\n  x = \\'b\\'\nline";
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.content).toContain("\\'b\\'");
	});

	test('drift allowed on exact match', () => {
		// Exact matches bypass the drift guard entirely.
		const content = "hello \\'world\\'";
		const r = fuzzyFindAndReplace(content, "hello \\'world\\'", "hello \\'there\\'");
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.strategy).toBe('exact');
	});

	test('drift allowed when adding escaped strings', () => {
		// old_string has no `\\'` → guard doesn't fire even when new adds one.
		const content = 'line1\nline2\nline3';
		const old = 'line1\nline2\nline3';
		const newS = "line1\nprint(\\'added\\')\nline2\nline3";
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.content).toContain("\\'added\\'");
	});

	test('no drift check when new_string lacks suspect chars', () => {
		// Fast-path: new_string has no `\\'` or `\\"` → guard never fires.
		const content = 'def foo():\n    pass';
		const old = 'def foo():\n  pass';
		const newS = 'def bar():\n  return 1';
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
	});
});

describe('TestEscapeNormalizedNewString', () => {
	test('tab in new_string unescaped under escape_normalized', () => {
		// File has real tab; model sends literal `\\t` in both old and new.
		const content = 'def hello():\n\tprint("before")\n';
		const old = 'def hello():\n\\tprint("before")\n';
		const newS = 'def hello():\n\\tprint("after")\n';
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.strategy).toBe('escape_normalized');
		expect(r.content).toContain('\tprint("after")');
		expect(r.content).not.toContain('\\t');
	});

	test('tab in new_string unescaped under exact', () => {
		// File has real tab, old_string has real tab (matches exact), but
		// new_string still arrives with literal `\\t`. Selective unescape
		// fires regardless of which strategy matched.
		const content = 'def hello():\n\tprint("before")\n';
		const old = '\tprint("before")';
		const newS = '\\tprint("after")';
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.strategy).toBe('exact');
		expect(r.content).toContain('\tprint("after")');
		expect(r.content).not.toContain('\\t');
	});

	test('carriage return in new_string unescaped', () => {
		const content = 'line1\r\nline2\r\n';
		const old = 'line1\\r\\nline2\\r\\n';
		const newS = 'replaced\\r\\n';
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.strategy).toBe('escape_normalized');
		expect(r.content).toContain('replaced\r');
	});

	test('newline in new_string NOT unescaped', () => {
		// `\\n` is intentionally left alone — newlines serialize correctly
		// through JSON; unescaping would corrupt source-code escape sequences.
		const content = 'line1\nline2\n';
		const old = 'line1\nline2';
		const newS = 'alpha\\nbeta';
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.content).toContain('alpha\\nbeta');
		expect(r.content).not.toContain('alpha\nbeta');
	});

	test('mixed tab and newline: only tab unescaped', () => {
		const content = 'def foo():\n\tpass\n';
		const old = 'def foo():\n\tpass\n';
		const newS = 'def bar():\\n\\treturn 1\\n';
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.content).toContain('\treturn 1');
		expect(r.content).not.toContain('\\t');
		expect(r.content).toContain('\\n');
	});

	test('exact match preserves literal backslash-t in string literal', () => {
		// Matched region has NO real tab → new_string's literal `\\t` preserved.
		const content = 'sep = "\\t"\n';
		const old = 'sep = "\\t"\n';
		const newS = 'sep = "\\tab"\n';
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.strategy).toBe('exact');
		expect(r.content).toContain('sep = "\\tab"');
		expect(r.content).not.toContain('\t');
	});

	test('no escape sequences: passthrough', () => {
		const content = 'def foo():\n    return 1\n';
		const old = 'def foo():\n    return 1\n';
		const newS = 'def foo():\n    return 2\n';
		const r = fuzzyFindAndReplace(content, old, newS);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.content).toContain('return 2');
	});
});

describe('TestFindClosestLines', () => {
	test('finds similar line', () => {
		const result = findClosestLines('def baz():', 'def foo():\n    pass\ndef bar():\n    return 1\n');
		expect(result.includes('def foo') || result.includes('def bar')).toBe(true);
	});

	test('returns empty for no match', () => {
		const result = findClosestLines('xyzzy_no_match_possible_!!!', 'completely different content here');
		expect(result).toBe('');
	});

	test('returns empty for empty inputs', () => {
		expect(findClosestLines('', 'some content')).toBe('');
		expect(findClosestLines('old string', '')).toBe('');
	});

	test('includes context lines', () => {
		const result = findClosestLines('def target():', 'line1\nline2\ndef target():\n    pass\nline5\n');
		expect(result).toContain('target');
	});

	test('includes line numbers', () => {
		const result = findClosestLines('def foo():', 'line1\nline2\ndef foo():\n    pass\n');
		// Format "   N| content"
		expect(result).toContain('|');
	});
});

describe('TestFormatNoMatchHint', () => {
	test('fires on could-not-find with similar content', () => {
		const result = formatNoMatchHint(
			'Could not find a match for old_string in the file',
			0,
			'def baz():',
			'def foo():\n    pass\ndef bar():\n    pass\n',
		);
		expect(result).toContain('Did you mean');
		expect(result.includes('foo') || result.includes('bar')).toBe(true);
	});

	test('silent on ambiguous-match error', () => {
		const result = formatNoMatchHint(
			'Found 2 matches for old_string. Provide more context to make it unique, or use replace_all=true.',
			0,
			'aaa',
			'aaa bbb aaa\n',
		);
		expect(result).toBe('');
	});

	test('silent on escape-drift error', () => {
		const result = formatNoMatchHint(
			"Escape-drift detected: old_string and new_string contain the literal sequence '\\''...",
			0,
			"x = \\'1\\'",
			'x = 1\n',
		);
		expect(result).toBe('');
	});

	test('silent on identical-strings error', () => {
		const result = formatNoMatchHint(
			'old_string and new_string are identical',
			0,
			'foo',
			'foo bar\n',
		);
		expect(result).toBe('');
	});

	test('silent when match_count nonzero (defense in depth)', () => {
		const result = formatNoMatchHint(
			'Could not find a match for old_string in the file',
			1,
			'foo',
			'foo bar\n',
		);
		expect(result).toBe('');
	});

	test('silent on null error', () => {
		expect(formatNoMatchHint(null, 0, 'foo', 'bar\n')).toBe('');
	});

	test('silent when no similar content exists', () => {
		const result = formatNoMatchHint(
			'Could not find a match for old_string in the file',
			0,
			'totally_unique_xyzzy_qux',
			'abc\nxyz\n',
		);
		expect(result).toBe('');
	});
});
