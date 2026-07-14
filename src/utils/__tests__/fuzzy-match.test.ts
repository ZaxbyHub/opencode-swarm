import { describe, expect, test } from 'bun:test';
import { fuzzyFindAndReplace } from '../fuzzy-match';

/**
 * Fuzzy-match acceptance tests — part 1 of 2.
 *
 * Verbatim port of these hermes test classes from
 * `E:/ZCode/hermes/tests/tools/test_fuzzy_match.py`:
 * - TestExactMatch (5)
 * - TestWhitespaceDifference (4 — word-boundary regression)
 * - TestIndentDifference (1)
 * - TestIndentationPreservation (6 — `ast.parse` replaced with exact string assertion)
 * - TestReplaceAll (3 — self-overlapping regression)
 * - TestUnicodeNormalized (8)
 * - TestBlockAnchorThreshold (2)
 * - TestStrategyNameSurfaced (2)
 *
 * Strategy-9 gating, escape-drift, escape-normalized, closest-lines and
 * hint tests live in `fuzzy-match-2.test.ts` (FR-006 cap split).
 */

describe('TestExactMatch', () => {
	test('single replacement', () => {
		const r = fuzzyFindAndReplace('hello world', 'hello', 'hi');
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.content).toBe('hi world');
	});

	test('no match', () => {
		const r = fuzzyFindAndReplace('hello world', 'xyz', 'abc');
		expect(r.matchCount).toBe(0);
		expect(r.error).not.toBeNull();
		expect(r.content).toBe('hello world');
	});

	test('empty old_string', () => {
		const r = fuzzyFindAndReplace('abc', '', 'x');
		expect(r.matchCount).toBe(0);
		expect(r.error).not.toBeNull();
	});

	test('identical strings', () => {
		const r = fuzzyFindAndReplace('abc', 'abc', 'abc');
		expect(r.matchCount).toBe(0);
		expect(r.error).toContain('identical');
	});

	test('multiline exact', () => {
		const r = fuzzyFindAndReplace(
			'line1\nline2\nline3',
			'line1\nline2',
			'replaced',
		);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.content).toBe('replaced\nline3');
	});
});

describe('TestWhitespaceDifference', () => {
	test('extra spaces match', () => {
		const r = fuzzyFindAndReplace(
			'def  foo(  x,  y  ):',
			'def foo( x, y ):',
			'def bar(x, y):',
		);
		expect(r.matchCount).toBe(1);
		expect(r.content).toContain('bar');
	});

	test('boundary space preserved after match (word boundary regression)', () => {
		// Regression: a whitespace_normalized match ending with a non-space must
		// NOT consume the word-boundary space that follows.
		const r = fuzzyFindAndReplace('foo   bar baz', 'foo bar', 'XY');
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.strategy).toBe('whitespace_normalized');
		expect(r.content).toBe('XY baz');
	});

	test('boundary space preserved in code edit', () => {
		const r = fuzzyFindAndReplace(
			'result = compute(a,  b) + tail',
			'compute(a, b)',
			'compute(a, b, c)',
		);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.strategy).toBe('whitespace_normalized');
		expect(r.content).toBe('result = compute(a, b, c) + tail');
	});

	test('trailing whitespace still consumed when match ends with space', () => {
		// Pattern has trailing space → normalized match ends with space → the
		// expansion must consume the full whitespace run in the original.
		const r = fuzzyFindAndReplace('a = foo   + bar', 'foo +', 'XY');
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.content).toContain('XY');
		expect(r.content).toContain('bar');
	});
});

describe('TestIndentDifference', () => {
	test('different indentation matches', () => {
		const r = fuzzyFindAndReplace(
			'    def foo():\n        pass',
			'def foo():\n    pass',
			'def bar():\n    return 1',
		);
		expect(r.matchCount).toBe(1);
		expect(r.content).toContain('bar');
	});
});

describe('TestIndentationPreservation', () => {
	test('unindented input reindented to match file', () => {
		const content =
			'class Calculator:\n' +
			'    def add(self, a, b):\n' +
			'        result = a + b\n' +
			'        return result\n';
		// LLM sends zero-indent old/new.
		const old = 'result = a + b\nreturn result';
		const replacement = 'result = a + b\nresult *= 2\nreturn result';
		const r = fuzzyFindAndReplace(content, old, replacement);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.strategy).not.toBe('exact');
		// Every replaced line must be at 8-space indent (exact structural check
		// replaces the Python `ast.parse(out)` validity assertion).
		const expected =
			'class Calculator:\n' +
			'    def add(self, a, b):\n' +
			'        result = a + b\n' +
			'        result *= 2\n' +
			'        return result\n';
		expect(r.content).toBe(expected);
	});

	test('dedent at start anchors to file base', () => {
		const content = '  return 1\n  return 2\n';
		const old = 'return 1\nreturn 2';
		const replacement = 'class X:\n  return 99\n  return 100';
		const r = fuzzyFindAndReplace(content, old, replacement);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.strategy).not.toBe('exact');
		const lines = r.content.split('\n');
		expect(lines[0]).toBe('  class X:');
		expect(lines[1]).toBe('    return 99');
		expect(lines[2]).toBe('    return 100');
	});

	test('exact match: no reindent (passthrough)', () => {
		const content = '    def foo():\n        return 1\n';
		const old = '    def foo():\n        return 1';
		const replacement = '    def foo():\n        return 2';
		const r = fuzzyFindAndReplace(content, old, replacement);
		expect(r.error).toBeNull();
		expect(r.strategy).toBe('exact');
		expect(r.content).toBe('    def foo():\n        return 2\n');
	});

	test('LLM zero-indent shifts to file two-space', () => {
		const content = '  def x():\n    return 1\n';
		const old = 'def x():\n  return 1';
		const replacement = 'def x():\n  return 99';
		const r = fuzzyFindAndReplace(content, old, replacement);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		const lines = r.content.replace(/\n$/, '').split('\n');
		expect(lines[0]).toBe('  def x():');
		expect(lines[1]).toBe('    return 99');
	});

	test('indent already matches → passthrough', () => {
		const content = '  def  x(  ):\n    return 1\n';
		const old = '  def x():\n    return 1';
		const replacement = '  def x():\n    return 42';
		const r = fuzzyFindAndReplace(content, old, replacement);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		expect(r.strategy).not.toBe('exact');
		expect(r.content).toContain('    return 42');
	});

	test('blank lines left alone', () => {
		const content = '    a = 1\n    b = 2\n';
		const old = 'a = 1\nb = 2';
		const replacement = 'a = 1\n\nb = 99';
		const r = fuzzyFindAndReplace(content, old, replacement);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(1);
		const lines = r.content.split('\n');
		expect(lines[0]).toBe('    a = 1');
		expect(lines[1]).toBe('');
		expect(lines[2]).toBe('    b = 99');
	});
});

describe('TestReplaceAll', () => {
	test('multiple matches without flag errors', () => {
		const r = fuzzyFindAndReplace('aaa bbb aaa', 'aaa', 'ccc', false);
		expect(r.matchCount).toBe(0);
		expect(r.error).toContain('Found 2 matches');
	});

	test('multiple matches with flag', () => {
		const r = fuzzyFindAndReplace('aaa bbb aaa', 'aaa', 'ccc', true);
		expect(r.error).toBeNull();
		expect(r.matchCount).toBe(2);
		expect(r.content).toBe('ccc bbb ccc');
	});

	test('self-overlapping pattern produces non-overlapping matches', () => {
		// Regression: advancing the scan cursor by 1 instead of pattern.length
		// produced overlapping matches that corrupted the file under replace_all.
		const a = fuzzyFindAndReplace('aaaa', 'aa', 'b', true);
		expect(a.error).toBeNull();
		expect(a.matchCount).toBe(2);
		expect(a.content).toBe('bb');

		const b = fuzzyFindAndReplace('aaa', 'a', 'b', true);
		expect(b.matchCount).toBe(3);
		expect(b.content).toBe('bbb');

		const c = fuzzyFindAndReplace('prefix aaaa suffix', 'aa', 'b', true);
		expect(c.error).toBeNull();
		expect(c.matchCount).toBe(2);
		expect(c.content).toBe('prefix bb suffix');

		// Without the flag, the non-overlapping count is reported (2, not 3).
		const d = fuzzyFindAndReplace('aaaa', 'aa', 'b', false);
		expect(d.matchCount).toBe(0);
		expect(d.error).toContain('2 matches');
	});
});

describe('TestUnicodeNormalized', () => {
	test('em-dash in content matches ASCII "--" in pattern', () => {
		const r = fuzzyFindAndReplace(
			'return value\u2014fallback',
			'return value--fallback',
			'return value or fallback',
		);
		expect(r.matchCount).toBe(1);
		expect(r.strategy).toBe('unicode_normalized');
		expect(r.content).toContain('return value or fallback');
	});

	test('smart quotes in content match straight quotes in pattern', () => {
		const r = fuzzyFindAndReplace(
			'print(\u201chello\u201d)',
			'print("hello")',
			'print("world")',
		);
		expect(r.matchCount).toBe(1);
		expect(r.content).toContain('world');
	});

	test('no unicode → strategy skipped (exact wins)', () => {
		const r = fuzzyFindAndReplace('hello world', 'hello', 'hi');
		expect(r.matchCount).toBe(1);
		expect(r.strategy).toBe('exact');
	});

	test('unicode preserved in output (em-dash)', () => {
		const r = fuzzyFindAndReplace(
			'Hello\u2014world',
			'Hello--world',
			'Hello--there',
		);
		expect(r.matchCount).toBe(1);
		expect(r.strategy).toBe('unicode_normalized');
		expect(r.content).toBe('Hello\u2014there');
	});

	test('smart quotes preserved', () => {
		const r = fuzzyFindAndReplace(
			'He said \u201chello\u201d to her',
			'He said "hello" to her',
			'He said "goodbye" to her',
		);
		expect(r.matchCount).toBe(1);
		expect(r.content).toBe('He said \u201cgoodbye\u201d to her');
	});

	test('ellipsis preserved', () => {
		const r = fuzzyFindAndReplace(
			'Wait for it\u2026and done',
			'Wait for it...and done',
			'Wait for it...then done',
		);
		expect(r.matchCount).toBe(1);
		expect(r.content).toBe('Wait for it\u2026then done');
	});

	test('mixed unicode multiline all preserved', () => {
		const content =
			'Line 1 \u2014 with dash\nLine 2 \u201cquoted\u201d text\nLine 3 plain';
		const old = 'Line 1 -- with dash\nLine 2 "quoted" text\nLine 3 plain';
		const replacement =
			'Line 1 -- with dash\nLine 2 "quoted" text\nLine 3 changed';
		const r = fuzzyFindAndReplace(content, old, replacement);
		expect(r.matchCount).toBe(1);
		expect(r.content).toBe(
			'Line 1 \u2014 with dash\nLine 2 \u201cquoted\u201d text\nLine 3 changed',
		);
	});

	test('no unicode: replacement is direct (no-op guard)', () => {
		// Ported from hermes test_no_unicode_no_change (test_fuzzy_match.py:313).
		// When the file has no Unicode, replacement is direct — the unicode
		// preservation pass is a no-op (its normalized-forms-equal guard
		// returns newString unchanged).
		const r = fuzzyFindAndReplace(
			'plain text here',
			'plain text here',
			'plain text there',
		);
		expect(r.matchCount).toBe(1);
		expect(r.content).toBe('plain text there');
	});
});

describe('TestBlockAnchorThreshold', () => {
	test('high-similarity middle matches', () => {
		const content = 'def foo():\n    x = 1\n    y = 2\n    return x + y\n';
		const pattern = 'def foo():\n    x = 1\n    y = 9\n    return x + y';
		const r = fuzzyFindAndReplace(
			content,
			pattern,
			'def foo():\n    return 0\n',
		);
		expect(r.matchCount).toBe(1);
	});

	test('completely different middle does NOT match under 0.50 threshold', () => {
		const content =
			'class Foo:\n' +
			"    completely = 'unrelated'\n" +
			"    content = 'here'\n" +
			"    nothing = 'in common'\n" +
			'    pass\n';
		const pattern = 'class Foo:\n    x = 1\n    y = 2\n    z = 3\n    pass';
		const r = fuzzyFindAndReplace(content, pattern, 'replaced');
		// Near-zero-similarity middle (0.4423 < 0.50) must not match.
		expect(r.matchCount).toBe(0);
	});
});

describe('TestStrategyNameSurfaced', () => {
	test('exact strategy name', () => {
		const r = fuzzyFindAndReplace('hello', 'hello', 'world');
		expect(r.strategy).toBe('exact');
		expect(r.matchCount).toBe(1);
	});

	test('failed match returns null strategy', () => {
		const r = fuzzyFindAndReplace('hello', 'xyz', 'world');
		expect(r.matchCount).toBe(0);
		expect(r.strategy).toBeNull();
	});
});
